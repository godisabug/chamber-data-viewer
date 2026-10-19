use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDateTime;
use csv::StringRecord;

use super::timed_rows::{infer_period_millis, TimedRow};
use crate::data::controller_rules::{FieldSourceRule, FREUD_HISTORY_CSV_RULE};
use crate::data::errors::AppError;
use crate::data::merge_sources::{merge_sources, SourceRows};
use crate::data::model::{dataset_source, Dataset, DatasetSource};

const CHANNEL_COUNT: usize = 6;
const PROBE_RECORD_LIMIT: usize = 64;
const MAX_TOTAL_PROBE_RECORDS: usize = 256;
const MAX_PROBE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone)]
struct ParsedRow {
    timestamp: NaiveDateTime,
    values: [Option<f64>; CHANNEL_COUNT],
}

pub fn probe_freud_history_csv(path: &Path) -> Result<bool, AppError> {
    let file = File::open(path)?;
    let mut reader = csv::ReaderBuilder::new().from_reader(file.take(MAX_PROBE_BYTES));
    let headers = match reader.headers() {
        Ok(headers) => headers,
        Err(_) => return Ok(false),
    };
    if !is_freud_history_header(headers) {
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
        let time = record.get(0).unwrap_or("").trim();
        if !time.is_empty() {
            examined_records += 1;
            if parse_timestamp(time).is_ok() {
                has_valid_timestamp = true;
                let has_finite_value = columns
                    .iter()
                    .any(|column| parse_value(record.get(*column)).is_some());
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

pub(crate) fn probe_freud_history_csv_bytes(bytes: &[u8]) -> bool {
    let mut reader = csv::ReaderBuilder::new().from_reader(bytes);
    let Ok(headers) = reader.headers() else {
        return false;
    };
    if !is_freud_history_header(headers) {
        return false;
    }
    let Ok(columns) = semantic_columns() else {
        return false;
    };
    let mut total_records = 0;
    let mut examined_records = 0;
    for record_result in reader.records() {
        let Ok(record) = record_result else {
            return false;
        };
        total_records += 1;
        let time = record.get(0).unwrap_or("").trim();
        if !time.is_empty() {
            examined_records += 1;
            if parse_timestamp(time).is_ok()
                && columns
                    .iter()
                    .any(|column| parse_value(record.get(*column)).is_some())
            {
                return true;
            }
        }
        if total_records == MAX_TOTAL_PROBE_RECORDS || examined_records == PROBE_RECORD_LIMIT {
            break;
        }
    }
    false
}

pub(crate) fn parse_freud_history_csv_bytes(
    source: &DatasetSource,
    bytes: &[u8],
) -> Result<SourceRows, AppError> {
    FREUD_HISTORY_CSV_RULE.validate()?;
    let columns = semantic_columns()?;
    let mut reader = csv::ReaderBuilder::new().from_reader(bytes);
    let headers = reader.headers()?;
    if !is_freud_history_header(headers) {
        return Err(AppError::Parse(format!(
            "文件 {}：不是弗锐德温湿高箱 history_data.csv",
            source.source_file
        )));
    }

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
        let time = record.get(0).unwrap_or("").trim();
        if time.is_empty() {
            continue;
        }
        let timestamp = parse_timestamp(time)?;
        let mut values = [None; CHANNEL_COUNT];
        let mut invalid = [false; CHANNEL_COUNT];
        for (semantic, column) in columns.iter().enumerate() {
            match parse_value(record.get(*column)) {
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
            "{} 中没有弗锐德温湿高箱采样行",
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
        source: source.clone(),
        period_millis: infer_period_millis(&timed_rows),
        rows: timed_rows,
        invalid_counts: invalid_counts.to_vec(),
        diagnostics: Vec::new(),
    })
}

pub(crate) fn parse_freud_history_csv_rows(path: &Path) -> Result<SourceRows, AppError> {
    let source = dataset_source(path)?;
    let mut bytes = Vec::new();
    File::open(path)?.read_to_end(&mut bytes)?;
    parse_freud_history_csv_bytes(&source, &bytes)
}

pub fn parse_freud_history_csv(path: &Path) -> Result<Dataset, AppError> {
    let source = parse_freud_history_csv_rows(path)?;
    merge_sources(vec![source], &FREUD_HISTORY_CSV_RULE)
}

fn is_freud_history_header(headers: &StringRecord) -> bool {
    headers.len() == 8
        && headers.iter().enumerate().all(|(index, header)| {
            let normalized = header.trim_start_matches('\u{feff}').trim();
            match index {
                0 => normalized == "时间",
                1 => normalized == "CH1_PV",
                2 => normalized == "CH2_PV",
                3 => normalized == "CH3_PV",
                4 => normalized == "CH1_SV",
                5 => normalized == "CH2_SV",
                6 => normalized == "CH3_SV",
                _ => normalized == "CH4_SV",
            }
        })
}

fn semantic_columns() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut columns = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in FREUD_HISTORY_CSV_RULE.series.iter().enumerate() {
        let FieldSourceRule::Column(column) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置 CSV 列号",
                FREUD_HISTORY_CSV_RULE.id, series.id
            )));
        };
        columns[semantic] = column;
    }
    Ok(columns)
}

fn parse_timestamp(time: &str) -> Result<NaiveDateTime, AppError> {
    NaiveDateTime::parse_from_str(time, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(time, "%Y-%m-%d %H:%M:%S%.f"))
        .map_err(|error| AppError::Parse(format!("时间戳解析失败：{error}")))
}

fn parse_value(value: Option<&str>) -> Option<f64> {
    let text = value.unwrap_or("").trim();
    match text.parse::<f64>() {
        Ok(value) if value.is_finite() => Some(value),
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
            "\u{feff}时间,CH1_PV,CH2_PV,CH3_PV,CH1_SV,CH2_SV,CH3_SV,CH4_SV\n\
2026-07-15 14:14:18,35.7,46.4,99.4,35.7,46.5,99.4,3194.69995\n\
2026-07-15 14:14:48,36,46.5,99.3,34.4,0,0,2858.19995\n\
2026-07-15 14:15:18,36.1,46.5,99.3,33.1,36.7,99.5,2521.30005\n\
2026-07-15 14:15:49,invalid,46.5,99.3,32.0,NaN,99.5,2200.0\n"
                .to_string()
                .into_bytes(),
        )
    }

    #[test]
    fn probe_and_parse_freud_history_csv() {
        let fixture = fixture();
        assert!(probe_freud_history_csv(&fixture.path).unwrap());
        let dataset = parse_freud_history_csv(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "freud-history-csv");
        assert_eq!(dataset.controller_rule, "freud-history-csv-v1");
        assert_eq!(dataset.row_count, 4);
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert_eq!(actual_temp.points[0].1, Some(35.7));
        assert_eq!(actual_temp.points[1].1, Some(36.0));
        assert_eq!(actual_temp.points[2].1, Some(36.1));
        assert_eq!(actual_temp.points[3].1, None);
        let set_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "set-temp")
            .unwrap();
        assert_eq!(set_temp.points[0].1, Some(35.7));
        assert_eq!(set_temp.points[3].1, Some(32.0));
        let actual_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-humidity")
            .unwrap();
        assert_eq!(actual_humidity.points[1].1, Some(46.5));
        let set_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "set-humidity")
            .unwrap();
        assert_eq!(set_humidity.points[1].1, None);
        assert_eq!(set_humidity.points[3].1, None);
        let actual_pressure = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-pressure")
            .unwrap();
        assert_eq!(
            actual_pressure
                .points
                .iter()
                .map(|point| point.1)
                .collect::<Vec<_>>(),
            [Some(99.4), Some(99.3), Some(99.3), Some(99.3)]
        );
        let set_pressure = dataset
            .series
            .iter()
            .find(|series| series.id == "set-pressure")
            .unwrap();
        assert_eq!(
            set_pressure
                .points
                .iter()
                .map(|point| point.1)
                .collect::<Vec<_>>(),
            [Some(99.4), None, Some(99.5), Some(99.5)]
        );
        assert_eq!(
            dataset
                .axes
                .iter()
                .map(|axis| axis.name.as_str())
                .collect::<Vec<_>>(),
            ["温度", "湿度", "气压"]
        );
        assert_eq!(dataset.row_count, 4);
        assert_eq!(dataset.series.len(), 6);
    }

    #[test]
    fn rejects_other_csv_structures() {
        let fixture = TempFile::new("csv", b"Date,Time,Value\n2026/01/01,00:00:00,1\n".to_vec());
        assert!(!probe_freud_history_csv(&fixture.path).unwrap());
    }
}
