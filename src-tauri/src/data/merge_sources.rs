use chrono::{Duration, NaiveDateTime};

use crate::data::controller_rules::ControllerRule;
use crate::data::errors::AppError;
use crate::data::model::{Dataset, DatasetSource, Diagnostic};
use crate::data::parsers::timed_rows::{build_dataset, format_seconds, TimedRow};
use crate::data::series_builder::effective_reading;

/// 单文件解析结果，供同目录多选合并使用。
pub struct SourceRows {
    pub source: DatasetSource,
    pub period_millis: Option<i64>,
    pub rows: Vec<TimedRow>,
    pub invalid_counts: Vec<usize>,
    pub diagnostics: Vec<Diagnostic>,
}

fn format_count(count: usize) -> String {
    let digits = count.to_string();
    let mut formatted = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            formatted.push(',');
        }
        formatted.push(digit);
    }
    formatted
}

fn gap_tolerance_millis(period_millis: i64) -> i64 {
    // 秒级量化的文本时间戳（如弗锐德温湿高箱、GBK 温冲箱）会在 30 秒网格上产生
    // ±1 秒抖动，5% 容差会把 32 秒的真实间隔误判为停录。量化误差本身即 ±1 秒，
    // 因此容差下限设为 2 秒；真实停录间隔远大于周期 + 容差，仍会正常断点。
    (period_millis / 20).max(2_000)
}

fn reject_duplicate_source_ids(sources: &[SourceRows]) -> Result<(), AppError> {
    let mut keyed = sources
        .iter()
        .map(|source| (unicode_lowercase(&source.source.source_id), source))
        .collect::<Vec<_>>();
    keyed.sort_by(|left, right| left.0.cmp(&right.0));
    for pair in keyed.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err(AppError::Parse(format!(
                "检测到重复的数据源 {}：文件 {} 与 {} 指向同一数据源",
                pair[0].1.source.source_id,
                pair[0].1.source.source_file,
                pair[1].1.source.source_file
            )));
        }
    }
    Ok(())
}

fn unicode_lowercase(value: &str) -> String {
    value.chars().flat_map(char::to_lowercase).collect()
}

fn validate_source(source: &SourceRows) -> Result<(), AppError> {
    if source.rows.is_empty() {
        return Err(AppError::Parse(format!(
            "文件 {}：数据源没有采样行",
            source.source.source_file
        )));
    }
    for pair in source.rows.windows(2) {
        if pair[0].timestamp >= pair[1].timestamp {
            return Err(AppError::Parse(format!(
                "文件 {}：采样时间必须严格递增",
                source.source.source_file
            )));
        }
    }
    Ok(())
}

fn group_source_id(sources: &[SourceRows], rule: &ControllerRule) -> Result<String, AppError> {
    let source_ids = sources
        .iter()
        .map(|source| source.source.source_id.as_str())
        .collect::<Vec<_>>();
    let serialized = serde_json::to_string(&source_ids)
        .map_err(|error| AppError::Parse(format!("无法构造组合身份：{error}")))?;
    Ok(format!("{}-group:{serialized}", rule.parser_id))
}

pub fn merge_sources(
    mut sources: Vec<SourceRows>,
    rule: &ControllerRule,
) -> Result<Dataset, AppError> {
    rule.validate()?;
    if sources.is_empty() {
        return Err(AppError::NoDisplayableData("未找到任何数据源".to_string()));
    }
    reject_duplicate_source_ids(&sources)?;
    for source in &sources {
        validate_source(source)?;
    }

    let periods = sources
        .iter()
        .filter_map(|source| source.period_millis)
        .collect::<Vec<_>>();
    let period_millis = if periods.is_empty() {
        None
    } else {
        let first = periods[0];
        if periods.iter().any(|period| *period != first) {
            return Err(AppError::Parse("多文件合并的采样周期不一致".to_string()));
        }
        Some(first)
    };

    sources.sort_by(|left, right| {
        left.rows[0]
            .timestamp
            .cmp(&right.rows[0].timestamp)
            .then_with(|| left.source.source_id.cmp(&right.source.source_id))
    });

    let mut items = Vec::new();
    for (source_index, source) in sources.iter().enumerate() {
        for (row_index, row) in source.rows.iter().enumerate() {
            items.push((row.timestamp, source_index, row_index));
        }
    }
    items.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });

    let mut real_rows: Vec<(NaiveDateTime, usize, &TimedRow)> = Vec::new();
    let mut duplicate_count = 0_usize;
    let mut index = 0_usize;
    while index < items.len() {
        let timestamp = items[index].0;
        let mut end = index;
        while end + 1 < items.len() && items[end + 1].0 == timestamp {
            end += 1;
        }
        let (_, representative_source, representative_row) = items[index];
        let representative = &sources[representative_source].rows[representative_row];
        for &(_, other_source, other_row) in &items[index + 1..=end] {
            let other = &sources[other_source].rows[other_row];
            if other.values != representative.values {
                return Err(AppError::Parse(format!(
                    "时间点 {} 在文件 {} 与 {} 中的通道值冲突",
                    format_seconds(timestamp),
                    sources[representative_source].source.source_file,
                    sources[other_source].source.source_file
                )));
            }
        }
        duplicate_count += end - index;
        real_rows.push((timestamp, representative_source, representative));
        index = end + 1;
    }

    let mut display_rows = Vec::with_capacity(real_rows.len());
    let mut gap_count = 0_usize;
    let mut missing_count = 0_usize;
    for (row_index, (timestamp, source_index, row)) in real_rows.iter().enumerate() {
        if let Some((previous, previous_source, _)) = row_index
            .checked_sub(1)
            .map(|previous_index| real_rows[previous_index])
        {
            let delta = timestamp.signed_duration_since(previous).num_milliseconds();
            let is_file_boundary = *source_index != previous_source;
            let should_break = match period_millis {
                Some(period) => {
                    let tolerance = gap_tolerance_millis(period);
                    let remainder = delta % period;
                    let on_grid = remainder <= tolerance || period - remainder <= tolerance;
                    delta > period + tolerance || (is_file_boundary && !on_grid)
                }
                None => is_file_boundary,
            };
            if should_break {
                let missing = match period_millis {
                    Some(period) if delta > period => usize::try_from(delta / period - 1)
                        .map_err(|_| AppError::Parse("停录间断的缺失采样点数量溢出".to_string()))?,
                    _ => 0,
                };
                missing_count = missing_count
                    .checked_add(missing)
                    .ok_or_else(|| AppError::Parse("停录间断的缺失采样点总数溢出".to_string()))?;
                gap_count += 1;
                let marker = match period_millis {
                    Some(period) if delta > period => {
                        previous.checked_add_signed(Duration::milliseconds(period))
                    }
                    _ => previous.checked_add_signed(Duration::seconds(1)),
                };
                let marker =
                    marker.ok_or_else(|| AppError::Parse("停录间断标记时间溢出".to_string()))?;
                display_rows.push(TimedRow {
                    timestamp: marker,
                    values: vec![None; rule.series.len()],
                    synthetic: true,
                });
            }
        }
        display_rows.push((*row).clone());
    }

    let mut diagnostics = Vec::new();
    for source in &sources {
        diagnostics.extend(source.diagnostics.iter().cloned());
    }
    for (semantic, series_rule) in rule.series.iter().enumerate() {
        let source_summaries = sources
            .iter()
            .map(|source| {
                let parsed_invalid = source.invalid_counts.get(semantic).copied().unwrap_or(0);
                let mut physically_invalid = 0;
                let mut has_valid = false;
                for row in &source.rows {
                    let raw = row.values.get(semantic).copied().flatten();
                    let effective = effective_reading(series_rule, raw);
                    has_valid |= effective.is_some();
                    if series_rule.role == "measured" && raw.is_some() && effective.is_none() {
                        physically_invalid += 1;
                    }
                }
                (parsed_invalid + physically_invalid, has_valid)
            })
            .collect::<Vec<_>>();
        let invalid_count = source_summaries
            .iter()
            .map(|(invalid, _)| invalid)
            .sum::<usize>();
        if invalid_count > 0 {
            let file_count = source_summaries
                .iter()
                .filter(|(invalid, _)| *invalid > 0)
                .count();
            let has_valid_measurement = source_summaries
                .iter()
                .any(|(_, has_valid)| *has_valid);
            let message = format!(
                "{}有 {} 个无效原始值（涉及 {} 个文件），已按缺失数据处理",
                series_rule.name,
                format_count(invalid_count),
                format_count(file_count)
            );
            diagnostics.push(if series_rule.role == "measured" && has_valid_measurement {
                Diagnostic::invalid_measurement(message)
            } else {
                Diagnostic::warning(message)
            });
        }
    }
    if gap_count > 0 {
        let period_seconds = period_millis.unwrap_or(0) / 1_000;
        diagnostics.push(Diagnostic::warning(format!(
            "检测到 {} 个停录间断，按 {period_seconds} 秒采样周期估算缺少 {} 个采样点；曲线已断开",
            format_count(gap_count),
            format_count(missing_count)
        )));
    }
    if duplicate_count > 0 {
        diagnostics.push(Diagnostic::warning(format!(
            "已去重 {} 个内容完全相同的重复时间点",
            format_count(duplicate_count)
        )));
    }

    let first_source = &sources[0];
    let (source_id, source_file) = if sources.len() == 1 {
        (
            first_source.source.source_id.clone(),
            first_source.source.source_file.clone(),
        )
    } else {
        (
            group_source_id(&sources, rule)?,
            format!("已合并 {} 个文件", sources.len()),
        )
    };
    let dataset_sources = sources.iter().map(|source| source.source.clone()).collect();

    build_dataset(
        DatasetSource {
            source_id,
            source_file,
        },
        dataset_sources,
        rule,
        &display_rows,
        diagnostics,
    )
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;

    use super::*;
    use crate::data::controller_rules::INT16_7COL_CSV_RULE;

    fn timestamp(second: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 8, 2)
            .unwrap()
            .and_hms_opt(0, second / 60, second % 60)
            .unwrap()
    }

    fn source(name: &str, seconds: &[u32], value: f64, period_millis: Option<i64>) -> SourceRows {
        SourceRows {
            source: DatasetSource {
                source_id: format!("c:/{name}"),
                source_file: name.to_string(),
            },
            period_millis,
            rows: seconds
                .iter()
                .map(|second| TimedRow {
                    timestamp: timestamp(*second),
                    values: vec![Some(value), Some(value), None, None],
                    synthetic: false,
                })
                .collect(),
            invalid_counts: vec![0, 0, 2, 2],
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn merges_sources_and_deduplicates_equal_timestamps() {
        let first = source("a.csv", &[0, 30], 20.0, Some(30_000));
        let second = source("b.csv", &[30, 60], 20.0, Some(30_000));
        let dataset = merge_sources(vec![first, second], &INT16_7COL_CSV_RULE).unwrap();

        assert_eq!(dataset.sources.len(), 2);
        assert_eq!(dataset.source_file, "已合并 2 个文件");
        assert_eq!(dataset.row_count, 3);
        assert!(dataset
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("已去重 1 个")));
    }

    #[test]
    fn rejects_conflicting_values_at_the_same_timestamp() {
        let first = source("a.csv", &[0], 20.0, Some(30_000));
        let second = source("b.csv", &[0], 21.0, Some(30_000));

        let result = merge_sources(vec![first, second], &INT16_7COL_CSV_RULE);
        assert!(matches!(
            result,
            Err(AppError::Parse(message)) if message.contains("通道值冲突")
        ));
    }

    #[test]
    fn inserts_a_single_breakpoint_per_gap() {
        let first = source("a.csv", &[0, 60], 20.0, Some(30_000));
        let dataset = merge_sources(vec![first], &INT16_7COL_CSV_RULE).unwrap();

        assert_eq!(dataset.row_count, 2);
        assert!(dataset
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("检测到 1 个停录间断")));
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert_eq!(actual_temp.points.len(), 3);
        assert_eq!(actual_temp.points[1].1, None);
    }

    #[test]
    fn breaks_at_off_grid_file_boundary() {
        let first = source("a.xls", &[0, 60], 20.0, Some(60_000));
        let second = source("b.xls", &[96], 21.0, Some(60_000));
        let dataset = merge_sources(
            vec![first, second],
            &crate::data::controller_rules::KR_TSV_RULE,
        )
        .unwrap();

        assert_eq!(dataset.row_count, 3);
        assert!(dataset
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("检测到 1 个停录间断")));
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert_eq!(actual_temp.points.len(), 4);
        assert_eq!(actual_temp.points[2].1, None);
    }

    #[test]
    fn rejects_mismatched_periods() {
        let first = source("a.csv", &[0, 30], 20.0, Some(30_000));
        let second = source("b.csv", &[60, 90], 20.0, Some(60_000));

        let result = merge_sources(vec![first, second], &INT16_7COL_CSV_RULE);
        assert!(matches!(
            result,
            Err(AppError::Parse(message)) if message.contains("采样周期不一致")
        ));
    }
}
