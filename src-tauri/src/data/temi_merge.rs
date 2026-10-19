use std::cmp::Reverse;
use std::collections::BinaryHeap;

use chrono::{Duration, NaiveDateTime};

use crate::data::controller_rules::TEMI2500_SDR_RULE;
use crate::data::errors::AppError;
use crate::data::model::{Dataset, Diagnostic, TimeRange};
use crate::data::parsers::temi2500_sdr::{engineering_value, TemiRow, TemiSourceRows};
use crate::data::series_builder::{effective_reading, make_optional_series};

fn format_temi_timestamp(timestamp: chrono::NaiveDateTime) -> String {
    if timestamp.and_utc().timestamp_subsec_millis() == 0 {
        timestamp.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        timestamp.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
    }
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

fn validate_source_rows(source: &TemiSourceRows) -> Result<(), AppError> {
    if source.rows.is_empty() {
        return Err(AppError::Parse(format!(
            "文件 {}：TEMI2500 数据源没有采样行",
            source.source.source_file
        )));
    }
    for rows in source.rows.windows(2) {
        if rows[0].timestamp >= rows[1].timestamp {
            return Err(AppError::Parse(format!(
                "文件 {}：TEMI2500 采样时间必须严格递增，{} 后出现 {}",
                source.source.source_file,
                format_temi_timestamp(rows[0].timestamp),
                format_temi_timestamp(rows[1].timestamp)
            )));
        }
    }
    Ok(())
}

fn reject_duplicate_source_ids(sources: &[TemiSourceRows]) -> Result<(), AppError> {
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
                "检测到重复的 TEMI2500 数据源 {}：文件 {} 与 {} 指向同一数据源",
                duplicate[0].0, duplicate[0].1, duplicate[1].1
            )));
        }
    }
    Ok(())
}

fn validate_compatible_metadata(
    first: &TemiSourceRows,
    later: &TemiSourceRows,
) -> Result<(), AppError> {
    if first.metadata.period_millis != later.metadata.period_millis {
        return Err(AppError::Parse(format!(
            "文件 {} 与 {} 的采样周期不兼容：分别为 {} 毫秒和 {} 毫秒",
            first.source.source_file,
            later.source.source_file,
            first.metadata.period_millis,
            later.metadata.period_millis
        )));
    }

    for semantic in 0..first.metadata.scales.len() {
        let channel_name = TEMI2500_SDR_RULE.series[semantic].name;
        let first_scale = first.metadata.scales[semantic];
        let later_scale = later.metadata.scales[semantic];
        let incompatible = if first_scale.raw_full_scale != later_scale.raw_full_scale {
            Some((
                "满量程原始值",
                first_scale.raw_full_scale.to_string(),
                later_scale.raw_full_scale.to_string(),
            ))
        } else if first_scale.high_int != later_scale.high_int {
            Some((
                "高量程",
                first_scale.high_int.to_string(),
                later_scale.high_int.to_string(),
            ))
        } else if first_scale.low_int != later_scale.low_int {
            Some((
                "低量程",
                first_scale.low_int.to_string(),
                later_scale.low_int.to_string(),
            ))
        } else if first_scale.decimals != later_scale.decimals {
            Some((
                "小数位",
                first_scale.decimals.to_string(),
                later_scale.decimals.to_string(),
            ))
        } else {
            None
        };
        if let Some((property, first_value, later_value)) = incompatible {
            return Err(AppError::Parse(format!(
                "文件 {} 与 {} 的{}通道{}不兼容：分别为 {} 和 {}",
                first.source.source_file,
                later.source.source_file,
                channel_name,
                property,
                first_value,
                later_value
            )));
        }
    }
    Ok(())
}

fn group_source_id(sources: &[TemiSourceRows]) -> Result<String, AppError> {
    let source_ids = sources
        .iter()
        .map(|source| source.source.source_id.as_str())
        .collect::<Vec<_>>();
    let serialized = serde_json::to_string(&source_ids)
        .map_err(|error| AppError::Parse(format!("无法构造 TEMI2500 组合身份：{error}")))?;
    Ok(format!("temi2500-group:{serialized}"))
}

enum DisplayRow<'a> {
    Real(&'a TemiRow),
    Gap(NaiveDateTime),
}

pub(crate) fn merge_temi_sources(mut sources: Vec<TemiSourceRows>) -> Result<Dataset, AppError> {
    TEMI2500_SDR_RULE.validate()?;
    if sources.is_empty() {
        return Err(AppError::NoDisplayableData(
            "未找到任何 TEMI2500 数据源".to_string(),
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
    for later in &sources[1..] {
        validate_compatible_metadata(first_source, later)?;
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
                .expect("peeked TEMI2500 heap entry must still exist");
            same_timestamp.push((next_source_index, next_row_index));
        }

        let (representative_source, representative_row) = same_timestamp[0];
        let representative = &sources[representative_source].rows[representative_row];
        for &(other_source, other_row) in &same_timestamp[1..] {
            let other = &sources[other_source].rows[other_row];
            if other.raw != representative.raw {
                return Err(AppError::Parse(format!(
                    "时间点 {} 在文件 {} 与 {} 中的 4 通道原始值冲突",
                    format_temi_timestamp(timestamp),
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
    let period_millis = first_source.metadata.period_millis;
    let mut display_rows = Vec::with_capacity(real_rows.len());
    let mut gap_count = 0_usize;
    let mut missing_count = 0_usize;
    for (index, row) in real_rows.iter().copied().enumerate() {
        if let Some(previous) = index.checked_sub(1).map(|previous| real_rows[previous]) {
            let delta_millis = row
                .timestamp
                .signed_duration_since(previous.timestamp)
                .num_milliseconds();
            if delta_millis > period_millis {
                let missing = usize::try_from(delta_millis / period_millis - 1).map_err(|_| {
                    AppError::Parse("TEMI2500 停录间断的缺失采样点数量溢出".to_string())
                })?;
                missing_count = missing_count.checked_add(missing).ok_or_else(|| {
                    AppError::Parse("TEMI2500 停录间断的缺失采样点总数溢出".to_string())
                })?;
                gap_count += 1;
                let marker_timestamp = previous
                    .timestamp
                    .checked_add_signed(Duration::milliseconds(period_millis))
                    .ok_or_else(|| AppError::Parse("TEMI2500 停录间断标记时间溢出".to_string()))?;
                display_rows.push(DisplayRow::Gap(marker_timestamp));
            }
        }
        display_rows.push(DisplayRow::Real(row));
    }

    let mut series = Vec::new();
    let mut diagnostics = Vec::new();
    for (semantic, rule) in TEMI2500_SDR_RULE.series.iter().enumerate() {
        let optional_series = make_optional_series(
            rule,
            &display_rows,
            |row| match row {
                DisplayRow::Real(row) => format_temi_timestamp(row.timestamp),
                DisplayRow::Gap(timestamp) => format_temi_timestamp(*timestamp),
            },
            |row| match row {
                DisplayRow::Real(row) => {
                    engineering_value(row.raw[semantic], first_source.metadata.scales[semantic])
                }
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
                        let engineering = engineering_value(
                            row.raw[semantic],
                            source.metadata.scales[semantic],
                        );
                        rule.role == "measured"
                            && engineering.is_some()
                            && effective_reading(rule, engineering).is_none()
                    })
                    .count();
                source.overrange_counts[semantic] + physically_invalid
            })
            .collect::<Vec<_>>();
        let invalid_count: usize = invalid_counts.iter().sum();
        if invalid_count > 0 {
            let file_count = invalid_counts
                .iter()
                .filter(|invalid| **invalid > 0)
                .count();
            diagnostics.push(if rule.role == "measured" && has_series {
                Diagnostic::invalid_measurement(format!(
                    "{}有 {} 个无效测量值（涉及 {} 个文件），已按缺失数据处理",
                    rule.name,
                    format_count(invalid_count),
                    format_count(file_count)
                ))
            } else {
                Diagnostic::warning(format!(
                    "{}有 {} 个超满量程值（涉及 {} 个文件），已按缺失数据处理",
                    rule.name,
                    format_count(invalid_count),
                    format_count(file_count)
                ))
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
            "未找到任何有效的温湿度数值".to_string(),
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
            format!("已合并 {} 个 TEMI2500 文件", sources.len()),
        )
    };
    let dataset_sources = sources.iter().map(|source| source.source.clone()).collect();

    Ok(Dataset {
        source_id,
        source_file,
        sources: dataset_sources,
        parser: TEMI2500_SDR_RULE.parser_id.to_string(),
        controller_rule: TEMI2500_SDR_RULE.id.to_string(),
        time_range: TimeRange {
            start: format_temi_timestamp(first_row.timestamp),
            end: format_temi_timestamp(last_row.timestamp),
        },
        row_count: real_rows.len(),
        axes: TEMI2500_SDR_RULE.axis_definitions(),
        series,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, NaiveDate, NaiveDateTime};

    use super::{format_temi_timestamp, merge_temi_sources};
    use crate::data::errors::AppError;
    use crate::data::model::DatasetSource;
    use crate::data::parsers::temi2500_sdr::{ChannelScale, TemiMetadata, TemiRow, TemiSourceRows};

    fn test_metadata() -> TemiMetadata {
        let scale = ChannelScale {
            raw_full_scale: 30_000,
            high_int: 1_000,
            low_int: 0,
            decimals: 1,
        };
        TemiMetadata {
            period_millis: 10_000,
            scales: [scale; 4],
        }
    }

    fn parsed_time(value: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    fn source_with_times(
        source_id: &str,
        source_file: &str,
        rows: &[(&str, [u16; 4])],
    ) -> TemiSourceRows {
        let metadata = test_metadata();
        let mut overrange_counts = [0; 4];
        let rows = rows
            .iter()
            .map(|(timestamp, raw)| {
                for semantic in 0..4 {
                    if raw[semantic] > metadata.scales[semantic].raw_full_scale {
                        overrange_counts[semantic] += 1;
                    }
                }
                TemiRow {
                    timestamp: parsed_time(timestamp),
                    raw: *raw,
                }
            })
            .collect();
        TemiSourceRows {
            source: DatasetSource {
                source_id: source_id.to_string(),
                source_file: source_file.to_string(),
            },
            metadata,
            rows,
            overrange_counts,
        }
    }

    fn source(
        source_id: &str,
        source_file: &str,
        start: &str,
        raw_rows: &[[u16; 4]],
    ) -> TemiSourceRows {
        let start = parsed_time(start);
        let owned_rows = raw_rows
            .iter()
            .enumerate()
            .map(|(index, raw)| {
                (
                    (start + Duration::seconds(index as i64 * 10))
                        .format("%Y-%m-%d %H:%M:%S")
                        .to_string(),
                    *raw,
                )
            })
            .collect::<Vec<_>>();
        let borrowed_rows = owned_rows
            .iter()
            .map(|(timestamp, raw)| (timestamp.as_str(), *raw))
            .collect::<Vec<_>>();
        source_with_times(source_id, source_file, &borrowed_rows)
    }

    fn base_timestamp() -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 6, 15)
            .unwrap()
            .and_hms_opt(14, 4, 39)
            .unwrap()
    }

    #[test]
    fn formats_temi_timestamps_with_optional_milliseconds() {
        let whole_second = base_timestamp();
        let half_second = whole_second + Duration::milliseconds(500);

        assert_eq!(format_temi_timestamp(whole_second), "2026-06-15 14:04:39");
        assert_eq!(
            format_temi_timestamp(half_second),
            "2026-06-15 14:04:39.500"
        );
    }

    #[test]
    fn merge_preserves_subsecond_points_and_time_range() {
        let first = base_timestamp();
        let second = first + Duration::milliseconds(500);
        let scale = ChannelScale {
            raw_full_scale: 1_000,
            high_int: 1_000,
            low_int: 0,
            decimals: 1,
        };
        let source = TemiSourceRows {
            source: DatasetSource {
                source_id: "source-1".to_string(),
                source_file: "half-second.sdr".to_string(),
            },
            metadata: TemiMetadata {
                period_millis: 500,
                scales: [scale; 4],
            },
            rows: vec![
                TemiRow {
                    timestamp: first,
                    raw: [500; 4],
                },
                TemiRow {
                    timestamp: second,
                    raw: [500; 4],
                },
            ],
            overrange_counts: [0; 4],
        };

        let dataset = merge_temi_sources(vec![source]).unwrap();

        assert_eq!(dataset.time_range.start, "2026-06-15 14:04:39");
        assert_eq!(dataset.time_range.end, "2026-06-15 14:04:39.500");
        assert_eq!(
            dataset.series[0]
                .points
                .iter()
                .map(|point| point.0.as_str())
                .collect::<Vec<_>>(),
            ["2026-06-15 14:04:39", "2026-06-15 14:04:39.500"]
        );
    }

    #[test]
    fn selection_order_does_not_change_group_identity_or_points() {
        let a = source(
            "canonical:/fixtures/a.sdr",
            "a.SDR",
            "2026-06-15 10:00:00",
            &[[15_000; 4]],
        );
        let b = source(
            "canonical:/fixtures/b.sdr",
            "b.SDR",
            "2026-06-15 10:00:20",
            &[[16_000; 4]],
        );

        let forward = merge_temi_sources(vec![a.clone(), b.clone()]).unwrap();
        let reverse = merge_temi_sources(vec![b, a]).unwrap();

        assert_eq!(forward.source_id, reverse.source_id);
        assert_eq!(forward.sources, reverse.sources);
        assert_eq!(forward.series, reverse.series);
        assert_eq!(forward.row_count, 2);
        assert_eq!(forward.source_file, "已合并 2 个 TEMI2500 文件");
        assert!(forward.source_id.starts_with("temi2500-group:"));
        assert_eq!(
            serde_json::to_value(&forward).unwrap(),
            serde_json::to_value(&reverse).unwrap()
        );
    }

    #[test]
    fn rejects_duplicate_source_ids_deterministically() {
        let cases = [
            (
                "a.SDR",
                "2026-06-15 10:00:00",
                "alias.SDR",
                "2026-06-15 10:00:20",
                "检测到重复的 TEMI2500 数据源 c:/same/a.SDR：文件 a.SDR 与 alias.SDR 指向同一数据源",
            ),
            (
                "a.SDR",
                "2026-06-15 10:00:00",
                "alias.SDR",
                "2026-06-15 10:00:00",
                "检测到重复的 TEMI2500 数据源 c:/same/a.SDR：文件 a.SDR 与 alias.SDR 指向同一数据源",
            ),
            (
                "a.SDR",
                "2026-06-15 10:00:00",
                "a.SDR",
                "2026-06-15 10:00:00",
                "检测到重复的 TEMI2500 数据源 c:/same/a.SDR：文件 a.SDR 与 a.SDR 指向同一数据源",
            ),
        ];

        for (left_file, left_time, right_file, right_time, expected) in cases {
            let left = source("c:/same/a.SDR", left_file, left_time, &[[15_000; 4]]);
            let right = source("c:/same/a.SDR", right_file, right_time, &[[15_000; 4]]);

            let forward = merge_temi_sources(vec![left.clone(), right.clone()]);
            let reverse = merge_temi_sources(vec![right, left]);
            let parse_message = |result| match result {
                Err(AppError::Parse(message)) => message,
                other => panic!("expected duplicate source Parse error, got {other:?}"),
            };
            let forward_message = parse_message(forward);
            let reverse_message = parse_message(reverse);

            assert_eq!(forward_message, expected);
            assert_eq!(reverse_message, expected);
            assert!(forward_message.contains("重复"));
            assert!(forward_message.contains("同一数据源"));
            assert!(forward_message.contains("c:/same/a.SDR"));
            assert!(forward_message.contains(left_file));
            assert!(forward_message.contains(right_file));
        }
    }

    #[test]
    fn equal_raw_rows_deduplicate_but_conflicting_raw_rows_fail() {
        let a = source(
            "canonical:/fixtures/a.sdr",
            "a.SDR",
            "2026-06-15 10:00:00",
            &[[15_000; 4]],
        );
        let b = source(
            "canonical:/fixtures/b.sdr",
            "b.SDR",
            "2026-06-15 10:00:00",
            &[[15_000; 4]],
        );
        let duplicate = merge_temi_sources(vec![a.clone(), b.clone()]).unwrap();
        let reversed_duplicate = merge_temi_sources(vec![b, a]).unwrap();
        assert_eq!(duplicate.row_count, 1);
        assert_eq!(
            serde_json::to_value(&duplicate).unwrap(),
            serde_json::to_value(&reversed_duplicate).unwrap()
        );
        assert!(duplicate.diagnostics.iter().any(|diagnostic| {
            diagnostic.message == "已去重 1 个内容完全相同的重复时间点"
        }));

        let conflicts = [
            (
                "a.SDR",
                [15_000; 4],
                "c.SDR",
                [0x8006, 15_000, 15_000, 15_000],
            ),
            (
                "a.SDR",
                [15_000; 4],
                "d.SDR",
                [15_001, 15_000, 15_000, 15_000],
            ),
            (
                "e.SDR",
                [0x8006, 15_000, 15_000, 15_000],
                "f.SDR",
                [0x8007, 15_000, 15_000, 15_000],
            ),
        ];
        for (left_file, left_raw, right_file, right_raw) in conflicts {
            let error = merge_temi_sources(vec![
                source(
                    &format!("canonical:/fixtures/{left_file}"),
                    left_file,
                    "2026-06-15 10:00:00",
                    &[left_raw],
                ),
                source(
                    &format!("canonical:/fixtures/{right_file}"),
                    right_file,
                    "2026-06-15 10:00:00",
                    &[right_raw],
                ),
            ])
            .unwrap_err();
            assert!(matches!(
                error,
                AppError::Parse(message)
                    if message.contains("2026-06-15 10:00:00")
                        && message.contains(left_file)
                        && message.contains(right_file)
            ));
        }
    }

    #[test]
    fn one_null_marker_breaks_each_gap_without_changing_row_count() {
        let dataset = merge_temi_sources(vec![
            source(
                "canonical:/fixtures/a.sdr",
                "a.SDR",
                "2026-06-15 10:00:00",
                &[[15_000; 4], [16_000; 4]],
            ),
            source(
                "canonical:/fixtures/b.sdr",
                "b.SDR",
                "2026-06-15 10:01:00",
                &[[17_000; 4]],
            ),
        ])
        .unwrap();

        assert_eq!(dataset.row_count, 3);
        assert_eq!(dataset.time_range.start, "2026-06-15 10:00:00");
        assert_eq!(dataset.time_range.end, "2026-06-15 10:01:00");
        assert!(dataset.series.iter().all(|series| {
            series.points.len() == 4
                && series.points[2].0 == "2026-06-15 10:00:20"
                && series.points[2].1.is_none()
        }));
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message
                == "检测到 1 个停录间断，按 10 秒采样周期估算缺少 4 个采样点；曲线已断开"
        }));
    }

    #[test]
    fn rejects_incompatible_period_and_scale_with_both_file_names() {
        let first = source(
            "canonical:/fixtures/a.sdr",
            "a.SDR",
            "2026-06-15 10:00:00",
            &[[15_000; 4]],
        );

        let mut incompatible_period = source(
            "canonical:/fixtures/b.sdr",
            "b.SDR",
            "2026-06-15 10:00:10",
            &[[15_000; 4]],
        );
        incompatible_period.metadata.period_millis = 20_000;
        assert_parse_mentions(
            merge_temi_sources(vec![first.clone(), incompatible_period]),
            "采样周期",
            "a.SDR",
            "b.SDR",
        );

        let scale_cases = [
            (
                "c.SDR",
                "小数位",
                ChannelScale {
                    decimals: 2,
                    ..test_metadata().scales[0]
                },
            ),
            (
                "d.SDR",
                "满量程原始值",
                ChannelScale {
                    raw_full_scale: 29_999,
                    ..test_metadata().scales[0]
                },
            ),
            (
                "e.SDR",
                "高量程",
                ChannelScale {
                    high_int: 999,
                    ..test_metadata().scales[0]
                },
            ),
            (
                "f.SDR",
                "低量程",
                ChannelScale {
                    low_int: -1,
                    ..test_metadata().scales[0]
                },
            ),
        ];
        for (file, property, scale) in scale_cases {
            let mut incompatible = source(
                &format!("canonical:/fixtures/{file}"),
                file,
                "2026-06-15 10:00:10",
                &[[15_000; 4]],
            );
            incompatible.metadata.scales[0] = scale;
            assert_parse_mentions(
                merge_temi_sources(vec![first.clone(), incompatible]),
                property,
                "a.SDR",
                file,
            );
        }
    }

    fn assert_parse_mentions(
        result: Result<crate::data::model::Dataset, AppError>,
        property: &str,
        first_file: &str,
        later_file: &str,
    ) {
        assert!(matches!(
            result,
            Err(AppError::Parse(message))
                if message.contains(property)
                    && message.contains(first_file)
                    && message.contains(later_file)
        ));
    }

    #[test]
    fn rejects_non_monotonic_rows_with_the_physical_file_name() {
        let non_monotonic_cases = [
            (
                "reversed.SDR",
                [
                    ("2026-06-15 10:00:10", [15_000; 4]),
                    ("2026-06-15 10:00:00", [16_000; 4]),
                ],
            ),
            (
                "equal.SDR",
                [
                    ("2026-06-15 10:00:00", [15_000; 4]),
                    ("2026-06-15 10:00:00", [16_000; 4]),
                ],
            ),
        ];
        for (file, rows) in non_monotonic_cases {
            let error = merge_temi_sources(vec![source_with_times(
                &format!("canonical:/fixtures/{file}"),
                file,
                &rows,
            )])
            .unwrap_err();
            assert!(matches!(error, AppError::Parse(message) if message.contains(file)));
        }

        let mut empty = source(
            "canonical:/fixtures/empty-rows.sdr",
            "empty-rows.SDR",
            "2026-06-15 10:00:00",
            &[[15_000; 4]],
        );
        empty.rows.clear();
        assert!(matches!(
            merge_temi_sources(vec![empty]),
            Err(AppError::Parse(message)) if message.contains("empty-rows.SDR")
        ));
    }

    #[test]
    fn preserves_a_channel_when_any_source_has_values_and_rejects_all_empty_data() {
        let dataset = merge_temi_sources(vec![
            source(
                "canonical:/fixtures/a.sdr",
                "a.SDR",
                "2026-06-15 10:00:00",
                &[[15_000, 15_000, 15_000, 30_001]],
            ),
            source(
                "canonical:/fixtures/b.sdr",
                "b.SDR",
                "2026-06-15 10:00:10",
                &[[15_000; 4]],
            ),
        ])
        .unwrap();
        let actual_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-humidity")
            .unwrap();
        assert_eq!(
            actual_humidity
                .points
                .iter()
                .map(|point| point.1)
                .collect::<Vec<_>>(),
            [None, Some(50.0)]
        );

        assert!(matches!(
            merge_temi_sources(vec![source(
                "canonical:/fixtures/empty.sdr",
                "empty.SDR",
                "2026-06-15 10:00:00",
                &[[30_001; 4]],
            )]),
            Err(AppError::NoDisplayableData(_))
        ));
    }

    #[test]
    fn diagnostics_format_large_counts_and_subsecond_periods_without_loss() {
        let first = base_timestamp();
        let mut source = source(
            "canonical:/fixtures/large-count.sdr",
            "large-count.SDR",
            "2026-06-15 14:04:39",
            &[[15_000; 4], [15_000; 4]],
        );
        source.metadata.period_millis = 500;
        source.rows[1].timestamp = first + Duration::milliseconds(1_500);
        source.overrange_counts[0] = 48_036;

        let dataset = merge_temi_sources(vec![source]).unwrap();

        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message
                == "设定温度有 48,036 个超满量程值（涉及 1 个文件），已按缺失数据处理"
        }));
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message
                == "检测到 1 个停录间断，按 0.5 秒采样周期估算缺少 2 个采样点；曲线已断开"
        }));
    }
}
