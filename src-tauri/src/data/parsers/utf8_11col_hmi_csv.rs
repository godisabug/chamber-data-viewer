use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDateTime;
use csv::StringRecord;

use super::timed_rows::{infer_period_millis, TimedRow};
use crate::data::controller_rules::{FieldSourceRule, UTF8_11COL_HMI_CSV_RULE};
use crate::data::errors::AppError;
use crate::data::merge_sources::{merge_sources, SourceRows};
use crate::data::model::{dataset_source, Diagnostic};

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

pub fn probe_utf8_11col_hmi_csv(path: &Path) -> Result<bool, AppError> {
    let file = File::open(path)?;
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(file.take(MAX_PROBE_BYTES));
    let headers = match reader.headers() {
        Ok(headers) => headers,
        Err(_) => return Ok(false),
    };
    if !is_11col_header(headers) {
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
            if parse_timestamp(date, time).is_ok() {
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

pub(crate) fn parse_utf8_11col_hmi_csv_rows(path: &Path) -> Result<SourceRows, AppError> {
    UTF8_11COL_HMI_CSV_RULE.validate()?;
    let source = dataset_source(path)?;
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_path(path)?;
    let headers = reader.headers()?;
    if !is_11col_header(headers) {
        return Err(AppError::Parse(format!(
            "文件 {}：不是 11 列中文头 CSV",
            source.source_file
        )));
    }
    let columns = semantic_columns()?;

    let records = reader
        .records()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            AppError::Parse(format!("文件 {} 解析失败：{error}", source.source_file))
        })?;
    let first_invalid = records.iter().position(|record| record.len() != 11);
    let valid_count = match first_invalid {
        Some(index) => {
            if records[index..].iter().any(|record| record.len() == 11) {
                return Err(AppError::Parse(format!(
                    "文件 {}：记录字段数不一致",
                    source.source_file
                )));
            }
            index
        }
        None => records.len(),
    };
    let skipped_trailing = records.len() - valid_count;

    let mut rows = Vec::new();
    let mut invalid_counts = [0_usize; CHANNEL_COUNT];
    for record in &records[..valid_count] {
        let date = record.get(0).unwrap_or("").trim();
        let time = record.get(1).unwrap_or("").trim();
        if date.is_empty() || time.is_empty() {
            continue;
        }
        let timestamp = parse_timestamp(date, time)?;
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
            "{} 中没有 11 列中文头 CSV 采样行",
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
    let mut diagnostics = Vec::new();
    if skipped_trailing > 0 {
        diagnostics.push(Diagnostic::warning(format!(
            "文件 {}：末尾存在 {skipped_trailing} 条不完整记录，已忽略",
            source.source_file
        )));
    }
    Ok(SourceRows {
        source,
        period_millis: infer_period_millis(&timed_rows),
        rows: timed_rows,
        invalid_counts: invalid_counts.to_vec(),
        diagnostics,
    })
}

pub fn parse_utf8_11col_hmi_csv(path: &Path) -> Result<crate::data::model::Dataset, AppError> {
    let source = parse_utf8_11col_hmi_csv_rows(path)?;
    merge_sources(vec![source], &UTF8_11COL_HMI_CSV_RULE)
}

fn is_11col_header(headers: &StringRecord) -> bool {
    headers.len() == 11
        && headers.iter().enumerate().all(|(index, header)| {
            let normalized = header.trim_start_matches('\u{feff}').trim();
            match index {
                0 => normalized == "Date",
                1 => normalized == "Time",
                2 => normalized == "控制温度",
                3 => normalized == "控制湿度",
                4 => normalized == "设定温度",
                5 => normalized == "设定温度",
                6 => normalized == "工作室温度",
                7 => normalized == "TEMP 1",
                8 => normalized == "TEMP 2",
                9 => normalized == "TEMP 3",
                _ => normalized == "TEMP 4",
            }
        })
}

fn semantic_columns() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut columns = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in UTF8_11COL_HMI_CSV_RULE.series.iter().enumerate() {
        let FieldSourceRule::Column(column) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置 CSV 列号",
                UTF8_11COL_HMI_CSV_RULE.id, series.id
            )));
        };
        columns[semantic] = column;
    }
    Ok(columns)
}

fn parse_timestamp(date: &str, time: &str) -> Result<NaiveDateTime, AppError> {
    NaiveDateTime::parse_from_str(&format!("{date} {time}"), "%Y/%m/%d %H:%M:%S")
        .map_err(|error| AppError::Parse(format!("时间戳解析失败：{error}")))
}

fn parse_raw(value: Option<&str>) -> Option<f64> {
    let text = value.unwrap_or("").trim();
    if text.is_empty() {
        return None;
    }
    let raw: i64 = text.parse().ok()?;
    if raw == 32767 || raw == -32768 {
        return None;
    }
    Some(raw as f64 * RAW_SCALE)
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
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(
            "\"Date\",\"Time\",\"控制温度\",\"控制湿度\",\"设定温度\",\"设定温度\",\"工作室温度\",\"TEMP 1\",\"TEMP 2\",\"TEMP 3\",\"TEMP 4\"\n\
             \"2026/07/02\",\"08:55:36\",\"225\",\"576\",\"200\",\"100\",\"0\",\"248\",\"238\",\"32767\",\"32767\"\n\
             \"2026/07/02\",\"08:56:06\",\"279\",\"385\",\"600\",\"100\",\"0\",\"279\",\"269\",\"32767\",\"32767\"\n"
                .as_bytes(),
        );
        TempFile::new("csv", bytes)
    }

    #[test]
    fn probe_and_parse_11col_csv_with_scaling_and_sentinel() {
        let fixture = fixture();
        assert!(probe_utf8_11col_hmi_csv(&fixture.path).unwrap());
        let dataset = parse_utf8_11col_hmi_csv(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "utf8-11col-hmi-csv");
        assert_eq!(dataset.controller_rule, "utf8-11col-hmi-csv-v1");
        assert_eq!(dataset.row_count, 2);
        let set_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "set-temp")
            .unwrap();
        assert_eq!(set_temp.points[0].1, Some(20.0));
        assert_eq!(set_temp.points[1].1, Some(60.0));
        let set_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "set-humidity")
            .unwrap();
        assert_eq!(set_humidity.points[0].1, Some(10.0));
    }

    #[test]
    fn rejects_other_csv_structures() {
        let fixture = TempFile::new("csv", b"Date,Time,Value\n2026/01/01,00:00:00,1\n".to_vec());
        assert!(!probe_utf8_11col_hmi_csv(&fixture.path).unwrap());
    }

    #[test]
    #[ignore = "requires CHAMBER_ATEC_11COL_ROOT with the private Atec 11-column CSV sample"]
    fn external_atec_11col_parses_the_sample() {
        let root = std::path::PathBuf::from(
            std::env::var_os("CHAMBER_ATEC_11COL_ROOT")
                .expect("set CHAMBER_ATEC_11COL_ROOT to the Atec 11-column CSV sample folder"),
        );
        let path = root.join("0855{260702}.csv");
        let dataset = parse_utf8_11col_hmi_csv(&path).unwrap();
        assert_eq!(dataset.parser, "utf8-11col-hmi-csv");
        assert_eq!(dataset.row_count, 28_082);
        assert!(dataset
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.message.contains("不完整记录") }));
    }
}
