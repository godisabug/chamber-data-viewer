use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDateTime;
use csv::StringRecord;

use super::timed_rows::{infer_period_millis, parse_slash_date_time, TimedRow};
use crate::data::controller_rules::{FieldSourceRule, ATEC_6COL_CSV_RULE};
use crate::data::errors::AppError;
use crate::data::merge_sources::{merge_sources, SourceRows};
use crate::data::model::dataset_source;

const CHANNEL_COUNT: usize = 4;
const PROBE_RECORD_LIMIT: usize = 64;
const MAX_TOTAL_PROBE_RECORDS: usize = 256;
const MAX_PROBE_BYTES: u64 = 256 * 1024;
const RAW_SCALE: f64 = 0.1;

#[derive(Debug, Clone)]
struct ParsedRow {
    timestamp: NaiveDateTime,
    values: [Option<f64>; CHANNEL_COUNT],
}

pub fn probe_atec_6col_csv(path: &Path) -> Result<bool, AppError> {
    let file = File::open(path)?;
    let mut reader = csv::ReaderBuilder::new().from_reader(file.take(MAX_PROBE_BYTES));
    let headers = match reader.headers() {
        Ok(headers) => headers,
        Err(_) => return Ok(false),
    };
    if !is_atec_6col_header(headers) {
        return Ok(false);
    }
    let columns = semantic_columns()?;

    let mut total_records = 0;
    let mut examined_records = 0;
    let mut has_valid_timestamp = false;
    for record_result in reader.records() {
        let record = match record_result {
            Ok(record) => record,
            Err(_) => return Ok(false),
        };
        total_records += 1;
        let date = record.get(0).unwrap_or("").trim();
        let time = record.get(1).unwrap_or("").trim();
        if !date.is_empty() && !time.is_empty() {
            examined_records += 1;
            if parse_slash_date_time(date, time).is_ok() {
                has_valid_timestamp = true;
                let has_finite_value = columns
                    .iter()
                    .any(|column| parse_raw(record.get(*column)).is_some());
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

pub(crate) fn parse_atec_6col_csv_rows(path: &Path) -> Result<SourceRows, AppError> {
    ATEC_6COL_CSV_RULE.validate()?;
    let source = dataset_source(path)?;
    let mut reader = csv::ReaderBuilder::new().from_path(path)?;
    let headers = reader.headers()?;
    if !is_atec_6col_header(headers) {
        return Err(AppError::Parse(format!(
            "文件 {}：不是阿泰可 6 列 CSV",
            source.source_file
        )));
    }
    let columns = semantic_columns()?;

    let mut rows = Vec::new();
    let mut invalid_counts = [0_usize; CHANNEL_COUNT];
    for (row_index, record_result) in reader.records().enumerate() {
        let record = record_result.map_err(|error| {
            AppError::Parse(format!(
                "文件 {} 的第 {} 行解析失败：{error}",
                source.source_file,
                row_index + 2
            ))
        })?;
        let date = record.get(0).unwrap_or("").trim();
        let time = record.get(1).unwrap_or("").trim();
        if date.is_empty() || time.is_empty() {
            continue;
        }
        let timestamp = parse_slash_date_time(date, time)?;
        let mut values = [None; CHANNEL_COUNT];
        let mut invalid = [false; CHANNEL_COUNT];
        for (semantic, column) in columns.iter().enumerate() {
            match parse_raw(record.get(*column)) {
                Some(value) => values[semantic] = Some(value),
                None => invalid[semantic] = true,
            }
        }
        for (count, flag) in invalid_counts.iter_mut().zip(invalid) {
            if flag {
                *count += 1;
            }
        }
        rows.push(ParsedRow { timestamp, values });
    }

    if rows.is_empty() {
        return Err(AppError::NoDisplayableData(format!(
            "{} 中没有阿泰可 6 列 CSV 采样行",
            source.source_file
        )));
    }
    ensure_monotonic(&source.source_file, &rows)?;

    let timed_rows: Vec<TimedRow> = rows
        .iter()
        .map(|row| TimedRow {
            timestamp: row.timestamp,
            values: row.values.to_vec(),
            synthetic: false,
        })
        .collect();
    Ok(SourceRows {
        source,
        period_millis: infer_period_millis(&timed_rows),
        rows: timed_rows,
        invalid_counts: invalid_counts.to_vec(),
        diagnostics: Vec::new(),
    })
}

pub fn parse_atec_6col_csv(path: &Path) -> Result<crate::data::model::Dataset, AppError> {
    let source = parse_atec_6col_csv_rows(path)?;
    merge_sources(vec![source], &ATEC_6COL_CSV_RULE)
}

fn is_atec_6col_header(headers: &StringRecord) -> bool {
    headers.len() == 6
        && headers.iter().enumerate().all(|(index, header)| {
            let normalized = header.trim_start_matches('\u{feff}').trim();
            match index {
                0 => normalized == "Date",
                1 => normalized == "Time",
                2 => normalized == "控制温度",
                3 => normalized.is_empty(),
                4 => normalized == "设置湿度上限",
                _ => normalized == "TD",
            }
        })
}

fn semantic_columns() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut columns = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in ATEC_6COL_CSV_RULE.series.iter().enumerate() {
        let FieldSourceRule::Column(column) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置 CSV 列号",
                ATEC_6COL_CSV_RULE.id, series.id
            )));
        };
        columns[semantic] = column;
    }
    Ok(columns)
}

fn parse_raw(value: Option<&str>) -> Option<f64> {
    let text = value.unwrap_or("").trim();
    if text.is_empty() {
        return None;
    }
    match text.parse::<f64>() {
        Ok(value) if value.is_finite() => Some(value * RAW_SCALE),
        _ => None,
    }
}

fn ensure_monotonic(source_file: &str, rows: &[ParsedRow]) -> Result<(), AppError> {
    for pair in rows.windows(2) {
        if pair[0].timestamp >= pair[1].timestamp {
            return Err(AppError::Parse(format!(
                "文件 {source_file}：采样时间必须严格递增，{} 后出现 {}",
                super::timed_rows::format_seconds(pair[0].timestamp),
                super::timed_rows::format_seconds(pair[1].timestamp)
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::test_support::TempFile;

    fn fixture() -> TempFile {
        TempFile::new(
            "csv",
            "\u{feff}\"Date\",\"Time\",\"控制温度\",\"\",\"设置湿度上限\",\"TD\"\n\
             \"2026/04/21\",\"10:02:03\",\"522\",\"650\",\"92\",\"930\"\n\
             \"2026/04/21\",\"10:02:33\",\"581\",\"650\",\"486\",\"930\"\n\
             \"2026/04/21\",\"10:03:03\",\"invalid\",\"650\",\"-100\",\"0\"\n"
                .to_string()
                .into_bytes(),
        )
    }

    #[test]
    fn probe_and_parse_atec_6col_csv() {
        let fixture = fixture();
        assert!(probe_atec_6col_csv(&fixture.path).unwrap());
        let dataset = parse_atec_6col_csv(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "atec-6col-csv");
        assert_eq!(dataset.controller_rule, "atec-6col-csv-v1");
        assert_eq!(dataset.row_count, 3);
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert_eq!(actual_temp.points[0].1, Some(52.2));
        assert_eq!(actual_temp.points[1].1, Some(58.1));
        assert_eq!(actual_temp.points[2].1, None);
        let set_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "set-temp")
            .unwrap();
        assert_eq!(set_temp.points[0].1, Some(65.0));
        let set_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "set-humidity")
            .unwrap();
        assert_eq!(set_humidity.points[1].1, Some(48.6));
        let actual_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-humidity")
            .unwrap();
        // 实测湿度 0%RH 不可能是真实测量值，按缺失数据处理。
        assert_eq!(actual_humidity.points[2].1, None);
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains("实测温度有 1 个无效原始值")
                && diagnostic.code == Some(crate::data::model::DiagnosticCode::InvalidMeasurement)
        }));
    }

    #[test]
    fn rejects_other_csv_structures() {
        let fixture = TempFile::new(
            "csv",
            b"Date,Time,Value\n2026/01/01,00:00:00,1\n".to_vec(),
        );
        assert!(!probe_atec_6col_csv(&fixture.path).unwrap());
    }
}
