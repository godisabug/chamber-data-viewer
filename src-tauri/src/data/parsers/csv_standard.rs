use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDateTime;
use csv::StringRecord;

use crate::data::controller_rules::{FieldSourceRule, SeriesRule, GENERIC_CSV_RULE};
use crate::data::errors::AppError;
use crate::data::model::{dataset_source, Dataset, Diagnostic, Series, TimeRange};
use crate::data::series_builder::make_optional_series;

const PARSER_ID: &str = GENERIC_CSV_RULE.parser_id;
const PROBE_RECORD_LIMIT: usize = 64;
const MAX_TOTAL_PROBE_RECORDS: usize = 256;
const MAX_PROBE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone)]
struct CsvRow {
    timestamp: NaiveDateTime,
    set_temp: Option<f64>,
    actual_temp: Option<f64>,
    set_humidity: Option<f64>,
    actual_humidity: Option<f64>,
}

#[derive(Debug, Clone, Copy)]
struct ColumnIndexes {
    timestamp: usize,
    set_temp: usize,
    actual_temp: usize,
    set_humidity: usize,
    actual_humidity: usize,
}

#[derive(Debug, Clone, Copy)]
struct ParsedNumber {
    value: Option<f64>,
    invalid: bool,
}

pub fn parse_csv(path: &Path) -> Result<Dataset, AppError> {
    GENERIC_CSV_RULE.validate()?;
    let mut reader = csv::ReaderBuilder::new().from_path(path)?;
    let indexes = column_indexes(reader.headers()?)?;
    let mut rows = Vec::new();
    let mut invalid_counts = [0_usize; 4];

    for record_result in reader.records() {
        let record = record_result?;
        if let Some((row, invalid_flags)) = parse_record(&record, indexes)? {
            for (count, invalid) in invalid_counts.iter_mut().zip(invalid_flags) {
                if invalid {
                    *count += 1;
                }
            }
            rows.push(row);
        }
    }

    if rows.is_empty() {
        return Err(AppError::NoDisplayableData(
            "CSV 中没有可显示的数据行".to_string(),
        ));
    }

    let was_non_monotonic = rows
        .windows(2)
        .any(|pair| pair[1].timestamp < pair[0].timestamp);
    rows.sort_by_key(|row| row.timestamp);

    build_dataset(path, rows, was_non_monotonic, invalid_counts)
}

pub fn probe_csv(path: &Path) -> Result<bool, AppError> {
    let file = File::open(path)?;
    let mut reader = csv::ReaderBuilder::new().from_reader(file.take(MAX_PROBE_BYTES));
    let indexes = {
        let headers = match reader.headers() {
            Ok(headers) => headers,
            Err(_) => return Ok(false),
        };
        match column_indexes(headers) {
            Ok(indexes) => indexes,
            Err(_) => return Ok(false),
        }
    };
    let mut total_records = 0;
    let mut examined_records = 0;
    let mut has_valid_timestamp = false;

    for record_result in reader.records() {
        let record = match record_result {
            Ok(record) => record,
            Err(_) => return Ok(false),
        };
        total_records += 1;
        let timestamp_text = record.get(indexes.timestamp).unwrap_or("").trim();
        if !timestamp_text.is_empty() {
            examined_records += 1;
            if NaiveDateTime::parse_from_str(timestamp_text, "%Y-%m-%d %H:%M:%S").is_ok() {
                has_valid_timestamp = true;
                let has_finite_value = [
                    indexes.set_temp,
                    indexes.actual_temp,
                    indexes.set_humidity,
                    indexes.actual_humidity,
                ]
                .into_iter()
                .any(|index| parse_number(record.get(index)).value.is_some());
                if has_finite_value {
                    return Ok(true);
                }
            }
        }

        if total_records == MAX_TOTAL_PROBE_RECORDS || examined_records == PROBE_RECORD_LIMIT {
            break;
        }
    }

    Ok(has_valid_timestamp)
}

fn column_indexes(headers: &StringRecord) -> Result<ColumnIndexes, AppError> {
    let indexes = ColumnIndexes {
        timestamp: required_column(headers, GENERIC_CSV_RULE.timestamp_headers)?,
        set_temp: series_column(headers, "set-temp")?,
        actual_temp: series_column(headers, "actual-temp")?,
        set_humidity: series_column(headers, "set-humidity")?,
        actual_humidity: series_column(headers, "actual-humidity")?,
    };
    let distinct_indexes: HashSet<usize> = [
        indexes.timestamp,
        indexes.set_temp,
        indexes.actual_temp,
        indexes.set_humidity,
        indexes.actual_humidity,
    ]
    .into_iter()
    .collect();
    if distinct_indexes.len() != 5 {
        return Err(AppError::Parse(
            "CSV 必要列映射存在重复或含义不明确".to_string(),
        ));
    }

    Ok(indexes)
}

fn series_column(headers: &StringRecord, series_id: &str) -> Result<usize, AppError> {
    let rule = GENERIC_CSV_RULE.series_rule(series_id)?;
    let FieldSourceRule::HeaderAliases(aliases) = rule.source else {
        return Err(AppError::Parse(format!(
            "控制器规则 {} 的曲线 {} 未配置 CSV 列名",
            GENERIC_CSV_RULE.id, series_id
        )));
    };
    required_column(headers, aliases)
}

fn required_column(headers: &StringRecord, aliases: &[&str]) -> Result<usize, AppError> {
    let matches: Vec<usize> = headers
        .iter()
        .enumerate()
        .filter_map(|(index, header)| {
            let normalized = header.trim_start_matches('\u{feff}').trim();
            aliases.contains(&normalized).then_some(index)
        })
        .collect();

    match matches.as_slice() {
        [index] => Ok(*index),
        [] => Err(AppError::Parse(format!(
            "CSV 缺少必要列：{}",
            aliases.join(" / ")
        ))),
        _ => Err(AppError::Parse(format!(
            "CSV 必要列匹配不唯一：{}",
            aliases.join(" / ")
        ))),
    }
}

fn parse_record(
    record: &StringRecord,
    indexes: ColumnIndexes,
) -> Result<Option<(CsvRow, [bool; 4])>, AppError> {
    let timestamp_text = record.get(indexes.timestamp).unwrap_or("").trim();
    if timestamp_text.is_empty() {
        return Ok(None);
    }

    let timestamp = NaiveDateTime::parse_from_str(timestamp_text, "%Y-%m-%d %H:%M:%S")
        .map_err(|error| AppError::Parse(format!("时间戳解析失败：{}", error)))?;
    let set_temp = parse_number(record.get(indexes.set_temp));
    let actual_temp = parse_number(record.get(indexes.actual_temp));
    let set_humidity = parse_number(record.get(indexes.set_humidity));
    let actual_humidity = parse_number(record.get(indexes.actual_humidity));

    Ok(Some((
        CsvRow {
            timestamp,
            set_temp: set_temp.value,
            actual_temp: actual_temp.value,
            set_humidity: set_humidity.value,
            actual_humidity: actual_humidity.value,
        },
        [
            set_temp.invalid,
            actual_temp.invalid,
            set_humidity.invalid,
            actual_humidity.invalid,
        ],
    )))
}

fn parse_number(value: Option<&str>) -> ParsedNumber {
    let text = value.unwrap_or("").trim();
    if text.is_empty() {
        return ParsedNumber {
            value: None,
            invalid: false,
        };
    }

    match text.parse::<f64>() {
        Ok(value) if value.is_finite() => ParsedNumber {
            value: Some(value),
            invalid: false,
        },
        _ => ParsedNumber {
            value: None,
            invalid: true,
        },
    }
}

fn build_dataset(
    path: &Path,
    rows: Vec<CsvRow>,
    was_non_monotonic: bool,
    invalid_counts: [usize; 4],
) -> Result<Dataset, AppError> {
    let start = rows.first().unwrap().timestamp;
    let end = rows.last().unwrap().timestamp;
    let row_count = rows.len();

    let set_temp_rule = GENERIC_CSV_RULE.series_rule("set-temp")?;
    let actual_temp_rule = GENERIC_CSV_RULE.series_rule("actual-temp")?;
    let set_humidity_rule = GENERIC_CSV_RULE.series_rule("set-humidity")?;
    let actual_humidity_rule = GENERIC_CSV_RULE.series_rule("actual-humidity")?;
    let rules = [
        set_temp_rule,
        actual_temp_rule,
        set_humidity_rule,
        actual_humidity_rule,
    ];
    let mut diagnostics = Vec::new();
    for (rule, invalid_count) in rules.iter().zip(invalid_counts) {
        if invalid_count > 0 {
            let message = format!(
                "{}有 {} 个无效值，已按缺失数据处理",
                rule.name, invalid_count
            );
            diagnostics.push(if rule.role == "measured" {
                Diagnostic::invalid_measurement(message)
            } else {
                Diagnostic::warning(message)
            });
        }
    }
    if was_non_monotonic {
        diagnostics.push(Diagnostic::info("CSV 时间顺序已按升序整理"));
    }

    let series: Vec<Series> = [
        make_series(set_temp_rule, &rows, |row| row.set_temp),
        make_series(actual_temp_rule, &rows, |row| row.actual_temp),
        make_series(set_humidity_rule, &rows, |row| row.set_humidity),
        make_series(actual_humidity_rule, &rows, |row| row.actual_humidity),
    ]
    .into_iter()
    .flatten()
    .collect();

    if series.is_empty() {
        return Err(AppError::NoDisplayableData(
            "CSV 中没有任何有效的温湿度数值".to_string(),
        ));
    }

    let source = dataset_source(path)?;

    Ok(Dataset {
        source_id: source.source_id.clone(),
        source_file: source.source_file.clone(),
        sources: vec![source],
        parser: PARSER_ID.to_string(),
        controller_rule: GENERIC_CSV_RULE.id.to_string(),
        time_range: TimeRange {
            start: format_timestamp(start),
            end: format_timestamp(end),
        },
        row_count,
        axes: GENERIC_CSV_RULE.axis_definitions(),
        series,
        diagnostics,
    })
}

fn make_series(
    rule: &SeriesRule,
    rows: &[CsvRow],
    value: fn(&CsvRow) -> Option<f64>,
) -> Option<Series> {
    make_optional_series(rule, rows, |row| format_timestamp(row.timestamp), value)
}

fn format_timestamp(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_CSV_ID: AtomicU64 = AtomicU64::new(0);

    struct TempCsv {
        path: PathBuf,
    }

    impl TempCsv {
        fn write(contents: &str) -> Self {
            let sequence = NEXT_TEMP_CSV_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "chamber-data-viewer-csv-{}-{sequence}.csv",
                std::process::id()
            ));
            std::fs::write(&path, contents).unwrap();
            Self { path }
        }
    }

    impl Drop for TempCsv {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join(name)
    }

    fn repository_fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    #[test]
    fn repository_fixture_has_stable_source_identity() {
        let dataset = parse_csv(&repository_fixture("csv-standard-minimal.csv")).unwrap();
        assert!(dataset
            .source_id
            .ends_with("/src-tauri/tests/fixtures/csv-standard-minimal.csv"));
        assert_eq!(dataset.source_file, "csv-standard-minimal.csv");
        assert_eq!(dataset.sources.len(), 1);
        assert_eq!(dataset.sources[0].source_id, dataset.source_id);
        assert_eq!(dataset.sources[0].source_file, dataset.source_file);
        assert_eq!(dataset.controller_rule, GENERIC_CSV_RULE.id);
        assert_eq!(
            serde_json::to_value(&dataset).unwrap()["controllerVendor"],
            serde_json::Value::Null
        );
        assert_eq!(dataset.row_count, 2);
        assert_eq!(dataset.time_range.start, "2026-01-01 00:00:00");
        assert_eq!(dataset.time_range.end, "2026-01-01 00:01:00");
        assert_eq!(dataset.series[3].points[1].1, None);
        assert_eq!(
            serde_json::to_value(&dataset).unwrap()["sourceId"],
            dataset.source_id
        );
    }

    #[test]
    #[ignore = "requires external 710 fixture"]
    fn external_710_csv() {
        let dataset = parse_csv(&fixture_path("710.csv")).unwrap();
        assert_eq!(dataset.parser, PARSER_ID);
        assert_eq!(dataset.row_count, 336_000);
        assert_eq!(dataset.time_range.start, "2026-05-04 02:09:18");
        assert_eq!(dataset.time_range.end, "2026-07-01 16:31:52");
        assert_eq!(dataset.controller_rule, GENERIC_CSV_RULE.id);
        assert_eq!(dataset.axes[0].name, "温度");
        assert_eq!(dataset.axes[1].name, "湿度");
        assert_eq!(dataset.series.len(), 4);
        assert_eq!(dataset.series[0].axis_id, "primary");
        assert_eq!(dataset.series[3].axis_id, "secondary");
    }

    #[test]
    fn accepts_controller_rule_header_aliases() {
        let headers = StringRecord::from(vec![
            "时间戳",
            "目标温度",
            "当前温度",
            "目标湿度",
            "当前湿度",
        ]);
        let indexes = column_indexes(&headers).unwrap();
        assert_eq!(indexes.timestamp, 0);
        assert_eq!(indexes.set_temp, 1);
        assert_eq!(indexes.actual_temp, 2);
        assert_eq!(indexes.set_humidity, 3);
        assert_eq!(indexes.actual_humidity, 4);
    }

    #[test]
    fn probe_requires_all_supported_headers() {
        assert!(probe_csv(&repository_fixture("csv-standard-minimal.csv")).unwrap());
    }

    #[test]
    fn probe_rejects_headers_without_a_credible_data_record() {
        let fixture = TempCsv::write(
            "时间戳,目标温度,当前温度,目标湿度,当前湿度\n\
             not-a-time,garbage,garbage,garbage,garbage\n",
        );

        assert!(!probe_csv(&fixture.path).unwrap());
    }

    #[test]
    fn probe_rejects_unequal_record_widths() {
        let fixture = TempCsv::write(
            "时间戳,目标温度,当前温度,目标湿度,当前湿度\n\
             2026-01-01 00:00:00,25,24,60\n",
        );

        assert!(!probe_csv(&fixture.path).unwrap());
    }

    #[test]
    fn parse_rejects_unequal_record_widths() {
        let fixture = TempCsv::write(
            "时间戳,目标温度,当前温度,目标湿度,当前湿度\n\
             2026-01-01 00:00:00,25,24,60\n",
        );

        assert!(matches!(parse_csv(&fixture.path), Err(AppError::Parse(_))));
    }

    #[test]
    fn probe_checks_at_most_64_non_empty_timestamp_records() {
        let mut contents = "时间戳,目标温度,当前温度,目标湿度,当前湿度\n".to_string();
        for _ in 0..PROBE_RECORD_LIMIT {
            contents.push_str("not-a-time,25,24,60,59\n");
        }
        contents.push_str("2026-01-01 00:00:00,25,24,60,59\n");
        let fixture = TempCsv::write(&contents);

        assert!(!probe_csv(&fixture.path).unwrap());
    }

    #[test]
    fn blank_timestamps_do_not_consume_the_probe_record_limit() {
        let mut contents = "时间戳,目标温度,当前温度,目标湿度,当前湿度\n".to_string();
        for _ in 0..PROBE_RECORD_LIMIT {
            contents.push_str(",25,24,60,59\n");
        }
        contents.push_str("2026-01-01 00:00:00,25,24,60,59\n");
        let fixture = TempCsv::write(&contents);

        assert!(probe_csv(&fixture.path).unwrap());
    }

    #[test]
    fn probe_stops_after_the_total_record_limit() {
        let mut contents = "时间戳,目标温度,当前温度,目标湿度,当前湿度\n".to_string();
        for _ in 0..MAX_TOTAL_PROBE_RECORDS {
            contents.push_str(",25,24,60,59\n");
        }
        contents.push_str("2026-01-01 00:00:00,25,24,60,59\n");
        let fixture = TempCsv::write(&contents);

        assert!(!probe_csv(&fixture.path).unwrap());
    }

    #[test]
    fn probe_rejects_a_record_truncated_by_the_byte_limit() {
        let oversized_field = "x".repeat(MAX_PROBE_BYTES as usize + 1);
        let contents = format!(
            "时间戳,目标温度,当前温度,目标湿度,当前湿度\n,\"{oversized_field}\",,,\n\
             2026-01-01 00:00:00,25,24,60,59\n"
        );
        let fixture = TempCsv::write(&contents);

        assert!(!probe_csv(&fixture.path).unwrap());
    }

    #[test]
    fn probe_recognizes_exact_structure_with_valid_time_but_no_finite_values() {
        let fixture = TempCsv::write(
            "时间戳,目标温度,当前温度,目标湿度,当前湿度\n\
             2026-01-01 00:00:00,,invalid,NaN,inf\n\
             2026-01-01 00:01:00,NaN,+inf,-inf,garbage\n",
        );

        assert!(probe_csv(&fixture.path).unwrap());
    }

    #[test]
    fn duplicate_semantic_headers_are_not_unique_matches() {
        let headers = StringRecord::from(vec![
            "时间戳",
            "目标温度",
            "目标温度",
            "当前温度",
            "目标湿度",
            "当前湿度",
        ]);

        assert!(column_indexes(&headers).is_err());
    }

    #[test]
    fn blank_numeric_cell_is_missing_but_not_invalid() {
        let parsed = parse_number(Some("  "));

        assert_eq!(parsed.value, None);
        assert!(!parsed.invalid);
    }

    #[test]
    fn invalid_or_non_finite_numeric_cell_is_invalid() {
        for value in ["invalid", "NaN", "inf", "+inf", "-inf"] {
            let parsed = parse_number(Some(value));

            assert_eq!(parsed.value, None, "{value}");
            assert!(parsed.invalid, "{value}");
        }
    }

    #[test]
    fn zero_numeric_cell_is_finite_and_valid() {
        let parsed = parse_number(Some("0"));

        assert_eq!(parsed.value, Some(0.0));
        assert!(!parsed.invalid);
    }

    #[test]
    fn invalid_numeric_cells_become_gaps_without_fabricating_zero() {
        let fixture = TempCsv::write(
            "时间戳,目标温度,当前温度,目标湿度,当前湿度\n\
             2026-01-01 00:00:00,invalid,24,NaN,58\n\
             2026-01-01 00:01:00,0,25,60,59\n",
        );
        let dataset = parse_csv(&fixture.path).unwrap();

        let set_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "set-temp")
            .unwrap();
        let set_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "set-humidity")
            .unwrap();
        assert_eq!(set_temp.points[0].1, None);
        assert_eq!(set_temp.points[1].1, Some(0.0));
        assert_eq!(set_humidity.points[0].1, None);
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.level == "warning"
                && diagnostic.message == "设定温度有 1 个无效值，已按缺失数据处理"
        }));
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.level == "warning"
                && diagnostic.message == "设定湿度有 1 个无效值，已按缺失数据处理"
        }));
    }

    #[test]
    fn all_empty_setpoint_columns_are_omitted() {
        let fixture = TempCsv::write(
            "时间戳,目标温度,当前温度,目标湿度,当前湿度\n\
             2026-01-01 00:00:00,,24,,58\n\
             2026-01-01 00:01:00,,25,,59\n",
        );
        let dataset = parse_csv(&fixture.path).unwrap();

        assert_eq!(
            dataset
                .series
                .iter()
                .map(|series| series.id.as_str())
                .collect::<Vec<_>>(),
            vec!["actual-temp", "actual-humidity"]
        );
    }

    #[test]
    fn all_non_finite_or_invalid_values_returns_no_displayable_data() {
        let fixture = TempCsv::write(
            "时间戳,目标温度,当前温度,目标湿度,当前湿度\n\
             2026-01-01 00:00:00,,invalid,NaN,inf\n\
             2026-01-01 00:01:00,NaN,+inf,-inf,garbage\n",
        );

        assert!(matches!(
            parse_csv(&fixture.path),
            Err(AppError::NoDisplayableData(message))
                if message == "CSV 中没有任何有效的温湿度数值"
        ));
    }
}
