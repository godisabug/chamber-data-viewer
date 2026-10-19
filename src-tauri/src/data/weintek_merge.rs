use std::cmp::Reverse;
use std::collections::BinaryHeap;

use chrono::{Duration, NaiveDateTime};

use crate::data::controller_rules::WEINTEK_EXPORT_RULE;
use crate::data::errors::AppError;
use crate::data::model::{Dataset, Diagnostic, TimeRange};
use crate::data::parsers::weintek_export::{
    format_weintek_timestamp, WeintekRow, WeintekSourceRows,
};
use crate::data::series_builder::{effective_reading, make_optional_series};

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

fn format_period_seconds(period_millis: i64) -> String {
    let seconds = period_millis / 1_000;
    let remaining_millis = period_millis % 1_000;
    if remaining_millis == 0 {
        return seconds.to_string();
    }

    let mut fraction = format!("{:03}", remaining_millis.abs());
    while fraction.ends_with('0') {
        fraction.pop();
    }
    format!("{seconds}.{fraction}")
}

fn gap_tolerance_millis(period_millis: i64) -> i64 {
    period_millis / 20
}

fn validate_source_rows(source: &WeintekSourceRows) -> Result<(), AppError> {
    if source.rows.is_empty() {
        return Err(AppError::Parse(format!(
            "文件 {}：威纶通数据源没有采样行",
            source.source.source_file
        )));
    }
    for rows in source.rows.windows(2) {
        if rows[0].timestamp >= rows[1].timestamp {
            return Err(AppError::Parse(format!(
                "文件 {}：威纶通采样时间必须严格递增，{} 后出现 {}",
                source.source.source_file,
                format_weintek_timestamp(rows[0].timestamp),
                format_weintek_timestamp(rows[1].timestamp)
            )));
        }
    }
    Ok(())
}

fn reject_duplicate_source_ids(sources: &[WeintekSourceRows]) -> Result<(), AppError> {
    let mut identities = sources
        .iter()
        .map(|source| {
            (
                source.source.source_id.as_str(),
                source.source.source_file.as_str(),
            )
        })
        .collect::<Vec<_>>();
    identities.sort_by(|left, right| left.0.cmp(right.0).then_with(|| left.1.cmp(right.1)));

    for duplicate in identities.windows(2) {
        if duplicate[0].0 == duplicate[1].0 {
            return Err(AppError::Parse(format!(
                "检测到重复的威纶通数据源 {}：文件 {} 与 {} 指向同一数据源",
                duplicate[0].0, duplicate[0].1, duplicate[1].1
            )));
        }
    }
    Ok(())
}

fn validate_compatible_periods(
    first: &WeintekSourceRows,
    later: &WeintekSourceRows,
) -> Result<(), AppError> {
    if first.period_millis != later.period_millis {
        return Err(AppError::Parse(format!(
            "文件 {} 与 {} 的采样周期不兼容：分别为 {} 秒和 {} 秒",
            first.source.source_file,
            later.source.source_file,
            format_period_seconds(first.period_millis),
            format_period_seconds(later.period_millis)
        )));
    }
    Ok(())
}

fn group_source_id(sources: &[WeintekSourceRows]) -> Result<String, AppError> {
    let source_ids = sources
        .iter()
        .map(|source| source.source.source_id.as_str())
        .collect::<Vec<_>>();
    let serialized = serde_json::to_string(&source_ids)
        .map_err(|error| AppError::Parse(format!("无法构造威纶通组合身份：{error}")))?;
    Ok(format!("weintek-group:{serialized}"))
}

enum DisplayRow<'a> {
    Real(&'a WeintekRow),
    Gap(NaiveDateTime),
}

pub(crate) fn merge_weintek_sources(
    mut sources: Vec<WeintekSourceRows>,
) -> Result<Dataset, AppError> {
    WEINTEK_EXPORT_RULE.validate()?;
    if sources.is_empty() {
        return Err(AppError::NoDisplayableData(
            "未找到任何威纶通数据源".to_string(),
        ));
    }
    reject_duplicate_source_ids(&sources)?;
    for source in &sources {
        validate_source_rows(source)?;
    }
    sources.sort_by(|left, right| {
        left.rows[0]
            .timestamp
            .cmp(&right.rows[0].timestamp)
            .then_with(|| left.source.source_id.cmp(&right.source.source_id))
    });

    let first_source = &sources[0];
    let period_millis = first_source.period_millis;
    for later in &sources[1..] {
        validate_compatible_periods(first_source, later)?;
    }

    let mut heap = BinaryHeap::with_capacity(sources.len());
    for (source_index, source) in sources.iter().enumerate() {
        heap.push(Reverse((source.rows[0].timestamp, source_index, 0_usize)));
    }

    let mut real_rows = Vec::new();
    let mut duplicate_count = 0_usize;
    while let Some(Reverse((timestamp, source_index, row_index))) = heap.pop() {
        let mut same_timestamp = vec![(source_index, row_index)];
        while let Some(Reverse((next_timestamp, _, _))) = heap.peek() {
            if *next_timestamp != timestamp {
                break;
            }
            let Reverse((_, next_source_index, next_row_index)) = heap
                .pop()
                .expect("peeked 威纶通 heap entry must still exist");
            same_timestamp.push((next_source_index, next_row_index));
        }

        let (representative_source, representative_row) = same_timestamp[0];
        let representative = &sources[representative_source].rows[representative_row];
        for &(other_source, other_row) in &same_timestamp[1..] {
            let other = &sources[other_source].rows[other_row];
            if other.values != representative.values {
                return Err(AppError::Parse(format!(
                    "时间点 {} 在文件 {} 与 {} 中的 4 通道数值冲突",
                    format_weintek_timestamp(timestamp),
                    sources[representative_source].source.source_file,
                    sources[other_source].source.source_file
                )));
            }
        }
        duplicate_count += same_timestamp.len() - 1;
        real_rows.push(representative);

        for (popped_source, popped_row) in same_timestamp {
            let successor = popped_row + 1;
            if successor < sources[popped_source].rows.len() {
                heap.push(Reverse((
                    sources[popped_source].rows[successor].timestamp,
                    popped_source,
                    successor,
                )));
            }
        }
    }

    let first_row = real_rows[0];
    let last_row = real_rows[real_rows.len() - 1];
    let mut display_rows = Vec::with_capacity(real_rows.len());
    let mut gap_count = 0_usize;
    let mut missing_count = 0_usize;
    for (index, row) in real_rows.iter().copied().enumerate() {
        if let Some(previous) = index.checked_sub(1).map(|previous| real_rows[previous]) {
            let delta_millis = row
                .timestamp
                .signed_duration_since(previous.timestamp)
                .num_milliseconds();
            if delta_millis > period_millis + gap_tolerance_millis(period_millis) {
                let missing = usize::try_from(delta_millis / period_millis - 1).map_err(|_| {
                    AppError::Parse("威纶通停录间断的缺失采样点数量溢出".to_string())
                })?;
                missing_count = missing_count.checked_add(missing).ok_or_else(|| {
                    AppError::Parse("威纶通停录间断的缺失采样点总数溢出".to_string())
                })?;
                gap_count += 1;
                let marker_timestamp = previous
                    .timestamp
                    .checked_add_signed(Duration::milliseconds(period_millis))
                    .ok_or_else(|| AppError::Parse("威纶通停录间断标记时间溢出".to_string()))?;
                display_rows.push(DisplayRow::Gap(marker_timestamp));
            }
        }
        display_rows.push(DisplayRow::Real(row));
    }

    let mut series = Vec::new();
    let mut diagnostics = Vec::new();
    for (semantic, rule) in WEINTEK_EXPORT_RULE.series.iter().enumerate() {
        let optional_series = make_optional_series(
            rule,
            &display_rows,
            |row| match row {
                DisplayRow::Real(row) => format_weintek_timestamp(row.timestamp),
                DisplayRow::Gap(timestamp) => format_weintek_timestamp(*timestamp),
            },
            |row| match row {
                DisplayRow::Real(row) => row.values[semantic],
                DisplayRow::Gap(_) => None,
            },
        );
        let has_series = optional_series.is_some();
        if let Some(optional_series) = optional_series {
            series.push(optional_series);
        }

        let invalid_counts = sources
            .iter()
            .map(|source| {
                let physically_invalid = source
                    .rows
                    .iter()
                    .filter(|row| {
                        let raw = row.values[semantic];
                        rule.role == "measured"
                            && raw.is_some()
                            && effective_reading(rule, raw).is_none()
                    })
                    .count();
                source.invalid_counts[semantic] + physically_invalid
            })
            .collect::<Vec<_>>();
        let invalid_count: usize = invalid_counts.iter().sum();
        if invalid_count > 0 {
            let file_count = invalid_counts
                .iter()
                .filter(|invalid| **invalid > 0)
                .count();
            let message = format!(
                "{}有 {} 个无效值（涉及 {} 个文件），已按缺失数据处理",
                rule.name,
                format_count(invalid_count),
                format_count(file_count)
            );
            diagnostics.push(if rule.role == "measured" && has_series {
                Diagnostic::invalid_measurement(message)
            } else {
                Diagnostic::warning(message)
            });
        }
    }

    if gap_count > 0 {
        diagnostics.push(Diagnostic::warning(format!(
            "检测到 {} 个停录间断，按 {} 秒采样周期估算缺少 {} 个采样点；曲线已断开",
            format_count(gap_count),
            format_period_seconds(period_millis),
            format_count(missing_count)
        )));
    }
    if duplicate_count > 0 {
        diagnostics.push(Diagnostic::warning(format!(
            "已去重 {} 个内容完全相同的重复时间点",
            format_count(duplicate_count)
        )));
    }

    if series.is_empty() {
        return Err(AppError::NoDisplayableData(
            "威纶通 CSV 中没有任何有效的温湿度数值".to_string(),
        ));
    }

    let (source_id, source_file) = if sources.len() == 1 {
        (
            first_source.source.source_id.clone(),
            first_source.source.source_file.clone(),
        )
    } else {
        (
            group_source_id(&sources)?,
            format!("已合并 {} 个威纶通文件", sources.len()),
        )
    };
    let dataset_sources = sources.iter().map(|source| source.source.clone()).collect();

    Ok(Dataset {
        source_id,
        source_file,
        sources: dataset_sources,
        parser: WEINTEK_EXPORT_RULE.parser_id.to_string(),
        controller_rule: WEINTEK_EXPORT_RULE.id.to_string(),
        time_range: TimeRange {
            start: format_weintek_timestamp(first_row.timestamp),
            end: format_weintek_timestamp(last_row.timestamp),
        },
        row_count: real_rows.len(),
        axes: WEINTEK_EXPORT_RULE.axis_definitions(),
        series,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, NaiveDateTime};

    use super::merge_weintek_sources;
    use crate::data::errors::AppError;
    use crate::data::model::DatasetSource;
    use crate::data::parsers::weintek_export::WeintekRow;

    fn parsed_time(value: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.3f").unwrap()
    }

    fn source_with_times(
        source_id: &str,
        source_file: &str,
        rows: &[(&str, [Option<f64>; 4])],
    ) -> super::WeintekSourceRows {
        super::WeintekSourceRows {
            source: DatasetSource {
                source_id: source_id.to_string(),
                source_file: source_file.to_string(),
            },
            period_millis: 30_000,
            rows: rows
                .iter()
                .map(|(timestamp, values)| WeintekRow {
                    timestamp: parsed_time(timestamp),
                    values: *values,
                })
                .collect(),
            invalid_counts: [0; 4],
        }
    }

    fn source(
        source_id: &str,
        source_file: &str,
        start: &str,
        value_rows: &[[Option<f64>; 4]],
    ) -> super::WeintekSourceRows {
        let start = parsed_time(start);
        let rows = value_rows
            .iter()
            .enumerate()
            .map(|(index, values)| WeintekRow {
                timestamp: start + Duration::seconds(index as i64 * 30),
                values: *values,
            })
            .collect::<Vec<_>>();
        super::WeintekSourceRows {
            source: DatasetSource {
                source_id: source_id.to_string(),
                source_file: source_file.to_string(),
            },
            period_millis: 30_000,
            rows,
            invalid_counts: [0; 4],
        }
    }

    #[test]
    fn selection_order_does_not_change_group_identity_or_points() {
        let a = source(
            "canonical:/fixtures/a.csv",
            "a.csv",
            "2026-06-08 00:14:16.690",
            &[[Some(20.0); 4]],
        );
        let b = source(
            "canonical:/fixtures/b.csv",
            "b.csv",
            "2026-06-08 00:15:16.690",
            &[[Some(21.0); 4]],
        );

        let forward = merge_weintek_sources(vec![a.clone(), b.clone()]).unwrap();
        let reverse = merge_weintek_sources(vec![b, a]).unwrap();

        assert_eq!(forward.source_id, reverse.source_id);
        assert_eq!(forward.sources, reverse.sources);
        assert_eq!(forward.series, reverse.series);
        assert_eq!(forward.row_count, 2);
        assert_eq!(forward.source_file, "已合并 2 个威纶通文件");
        assert!(forward.source_id.starts_with("weintek-group:"));
        assert_eq!(
            serde_json::to_value(&forward).unwrap(),
            serde_json::to_value(&reverse).unwrap()
        );
    }

    #[test]
    fn equal_rows_deduplicate_but_conflicting_rows_fail() {
        let a = source(
            "canonical:/fixtures/a.csv",
            "a.csv",
            "2026-06-08 00:14:16.690",
            &[[Some(20.0); 4]],
        );
        let b = source(
            "canonical:/fixtures/b.csv",
            "b.csv",
            "2026-06-08 00:14:16.690",
            &[[Some(20.0); 4]],
        );
        let duplicate = merge_weintek_sources(vec![a.clone(), b.clone()]).unwrap();
        assert_eq!(duplicate.row_count, 1);
        assert!(duplicate.diagnostics.iter().any(|diagnostic| {
            diagnostic.message == "已去重 1 个内容完全相同的重复时间点"
        }));

        let conflicting = source_with_times(
            "canonical:/fixtures/c.csv",
            "c.csv",
            &[(
                "2026-06-08 00:14:16.690",
                [Some(20.0), Some(21.0), Some(60.0), Some(59.0)],
            )],
        );
        let error = merge_weintek_sources(vec![a, conflicting]).unwrap_err();
        assert!(matches!(
            error,
            AppError::Parse(message)
                if message.contains("2026-06-08 00:14:16.690")
                    && message.contains("a.csv")
                    && message.contains("c.csv")
        ));
    }

    #[test]
    fn one_null_marker_breaks_each_gap_without_changing_row_count() {
        let dataset = merge_weintek_sources(vec![
            source(
                "canonical:/fixtures/a.csv",
                "a.csv",
                "2026-06-08 00:14:16.690",
                &[[Some(20.0); 4], [Some(21.0); 4]],
            ),
            source(
                "canonical:/fixtures/b.csv",
                "b.csv",
                "2026-06-08 00:15:46.690",
                &[[Some(22.0); 4]],
            ),
        ])
        .unwrap();

        assert_eq!(dataset.row_count, 3);
        assert_eq!(dataset.time_range.start, "2026-06-08 00:14:16.690");
        assert_eq!(dataset.time_range.end, "2026-06-08 00:15:46.690");
        assert!(dataset.series.iter().all(|series| {
            series.points.len() == 4
                && series.points[2].0 == "2026-06-08 00:15:16.690"
                && series.points[2].1.is_none()
        }));
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message
                == "检测到 1 个停录间断，按 30 秒采样周期估算缺少 1 个采样点；曲线已断开"
        }));
    }

    #[test]
    fn rejects_incompatible_periods_with_both_file_names() {
        let mut first = source(
            "canonical:/fixtures/a.csv",
            "a.csv",
            "2026-06-08 00:14:16.690",
            &[[Some(20.0); 4]],
        );
        first.period_millis = 60_000;
        let later = source(
            "canonical:/fixtures/b.csv",
            "b.csv",
            "2026-06-08 00:15:16.690",
            &[[Some(20.0); 4]],
        );

        let error = merge_weintek_sources(vec![first, later]).unwrap_err();
        assert!(matches!(
            error,
            AppError::Parse(message)
                if message.contains("采样周期")
                    && message.contains("a.csv")
                    && message.contains("b.csv")
        ));
    }

    #[test]
    fn rejects_non_monotonic_and_empty_rows() {
        let non_monotonic = source_with_times(
            "canonical:/fixtures/reversed.csv",
            "reversed.csv",
            &[
                ("2026-06-08 00:14:46.690", [Some(20.0); 4]),
                ("2026-06-08 00:14:16.690", [Some(21.0); 4]),
            ],
        );
        let error = merge_weintek_sources(vec![non_monotonic]).unwrap_err();
        assert!(matches!(
            error,
            AppError::Parse(message) if message.contains("reversed.csv")
        ));

        let mut empty = source(
            "canonical:/fixtures/empty.csv",
            "empty.csv",
            "2026-06-08 00:14:16.690",
            &[[Some(20.0); 4]],
        );
        empty.rows.clear();
        assert!(matches!(
            merge_weintek_sources(vec![empty]),
            Err(AppError::Parse(message)) if message.contains("empty.csv")
        ));
    }

    #[test]
    fn rejects_duplicate_source_ids_deterministically() {
        let left = source(
            "c:/same/a.csv",
            "a.csv",
            "2026-06-08 00:14:16.690",
            &[[Some(20.0); 4]],
        );
        let right = source(
            "c:/same/a.csv",
            "alias.csv",
            "2026-06-08 00:14:46.690",
            &[[Some(20.0); 4]],
        );

        let forward = merge_weintek_sources(vec![left.clone(), right.clone()]);
        let reverse = merge_weintek_sources(vec![right, left]);
        let parse_message = |result| match result {
            Err(AppError::Parse(message)) => message,
            other => panic!("expected duplicate source Parse error, got {other:?}"),
        };

        let forward_message = parse_message(forward);
        let reverse_message = parse_message(reverse);
        assert_eq!(forward_message, reverse_message);
        assert!(forward_message.contains("重复的威纶通数据源"));
        assert!(forward_message.contains("a.csv"));
        assert!(forward_message.contains("alias.csv"));
    }

    #[test]
    fn aggregates_invalid_values_across_files() {
        let mut a = source(
            "canonical:/fixtures/a.csv",
            "a.csv",
            "2026-06-08 00:14:16.690",
            &[[Some(20.0); 4]],
        );
        a.invalid_counts[0] = 2;
        let mut b = source(
            "canonical:/fixtures/b.csv",
            "b.csv",
            "2026-06-08 00:15:16.690",
            &[[Some(21.0); 4]],
        );
        b.invalid_counts[0] = 3;

        let dataset = merge_weintek_sources(vec![a, b]).unwrap();

        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message == "设定温度有 5 个无效值（涉及 2 个文件），已按缺失数据处理"
                && diagnostic.code.is_none()
        }));
    }

    #[test]
    fn all_empty_values_return_no_displayable_data() {
        assert!(matches!(
            merge_weintek_sources(vec![source(
                "canonical:/fixtures/empty-values.csv",
                "empty-values.csv",
                "2026-06-08 00:14:16.690",
                &[[None; 4]],
            )]),
            Err(AppError::NoDisplayableData(message))
                if message == "威纶通 CSV 中没有任何有效的温湿度数值"
        ));
    }
}
