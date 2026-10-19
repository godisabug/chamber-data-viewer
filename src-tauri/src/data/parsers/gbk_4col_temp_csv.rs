use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

use super::timed_rows::{infer_period_millis, TimedRow};
use crate::data::controller_rules::{FieldSourceRule, GBK_4COL_TEMP_CSV_RULE};
use crate::data::errors::AppError;
use crate::data::merge_sources::{merge_sources, SourceRows};
use crate::data::model::dataset_source;

const CHANNEL_COUNT: usize = 2;
const MAX_PROBE_BYTES: u64 = 256 * 1024;
const PROBE_RECORD_LIMIT: usize = 64;

/// GBK 编码的 `Date,Time,运行温度,设定温度` 表头字节。
const GBK_HEADER_BYTES: &[u8] =
    b"Date,Time,\xD4\xCB\xD0\xD0\xCE\xC2\xB6\xC8,\xC9\xE8\xB6\xA8\xCE\xC2\xB6\xC8";
const UTF8_HEADER: &[u8] = "Date,Time,运行温度,设定温度".as_bytes();

#[derive(Debug, Clone)]
struct ParsedRow {
    timestamp: NaiveDateTime,
    values: [Option<f64>; CHANNEL_COUNT],
}

pub fn probe_gbk_4col_temp_csv(path: &Path) -> Result<bool, AppError> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_PROBE_BYTES)
        .read_to_end(&mut bytes)?;
    let Some(header_len) = header_len(&bytes) else {
        return Ok(false);
    };
    let Some(rest) = bytes.get(header_len..) else {
        return Ok(false);
    };
    let lines = rest.split(|byte| *byte == b'\n');
    let mut examined = 0;
    let mut has_valid_timestamp = false;
    for line in lines {
        let line = trim_crlf(line);
        if line.is_empty() {
            continue;
        }
        examined += 1;
        let mut fields = line.split(|byte| *byte == b',');
        let Some(date) = fields.next() else { continue };
        let Some(time) = fields.next() else { continue };
        let date = String::from_utf8_lossy(date);
        let time = String::from_utf8_lossy(time);
        if parse_timestamp(&date, &time).is_ok() {
            has_valid_timestamp = true;
            let has_value =
                fields.any(|field| String::from_utf8_lossy(field).trim().parse::<f64>().is_ok());
            if has_value {
                return Ok(true);
            }
        }
        if examined == PROBE_RECORD_LIMIT {
            break;
        }
    }
    Ok(has_valid_timestamp)
}

pub(crate) fn parse_gbk_4col_temp_csv_rows(path: &Path) -> Result<SourceRows, AppError> {
    GBK_4COL_TEMP_CSV_RULE.validate()?;
    let source = dataset_source(path)?;
    let mut bytes = Vec::new();
    File::open(path)?.read_to_end(&mut bytes)?;
    let Some(header_len) = header_len(&bytes) else {
        return Err(AppError::Parse(format!(
            "文件 {}：不是 GBK 4 列温度 CSV",
            source.source_file
        )));
    };
    let mut transcoded = Vec::with_capacity(bytes.len());
    transcoded.extend_from_slice(UTF8_HEADER);
    transcoded.push(b'\n');
    transcoded.extend_from_slice(&bytes[header_len..]);

    let mut reader = csv::ReaderBuilder::new().from_reader(Cursor::new(transcoded));
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
        let timestamp = parse_timestamp(date, time)?;
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
            "{} 中没有 GBK 4 列温度 CSV 采样行",
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

pub fn parse_gbk_4col_temp_csv(path: &Path) -> Result<crate::data::model::Dataset, AppError> {
    let source = parse_gbk_4col_temp_csv_rows(path)?;
    merge_sources(vec![source], &GBK_4COL_TEMP_CSV_RULE)
}

fn header_len(bytes: &[u8]) -> Option<usize> {
    if !bytes.starts_with(GBK_HEADER_BYTES) {
        return None;
    }
    let rest = &bytes[GBK_HEADER_BYTES.len()..];
    if rest.starts_with(b"\r\n") {
        Some(GBK_HEADER_BYTES.len() + 2)
    } else if rest.starts_with(b"\n") {
        Some(GBK_HEADER_BYTES.len() + 1)
    } else {
        None
    }
}

fn trim_crlf(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

fn semantic_columns() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut columns = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in GBK_4COL_TEMP_CSV_RULE.series.iter().enumerate() {
        let FieldSourceRule::Column(column) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置 CSV 列号",
                GBK_4COL_TEMP_CSV_RULE.id, series.id
            )));
        };
        columns[semantic] = column;
    }
    Ok(columns)
}

fn parse_timestamp(date: &str, time: &str) -> Result<NaiveDateTime, AppError> {
    let mut date_parts = date.split('/');
    let year = parse_part(date_parts.next())? as i32;
    let month = parse_part(date_parts.next())?;
    let day = parse_part(date_parts.next())?;
    if date_parts.next().is_some() {
        return Err(AppError::Parse(format!("日期字段无法解析：{date:?}")));
    }
    let mut time_parts = time.split(':');
    let hour = parse_part(time_parts.next())?;
    let minute = parse_part(time_parts.next())?;
    let second = parse_part(time_parts.next())?;
    if time_parts.next().is_some() {
        return Err(AppError::Parse(format!("时间字段无法解析：{time:?}")));
    }
    let date = NaiveDate::from_ymd_opt(year, month, day)
        .ok_or_else(|| AppError::Parse(format!("日期超出范围：{date:?}")))?;
    let time = NaiveTime::from_hms_opt(hour, minute, second)
        .ok_or_else(|| AppError::Parse(format!("时间超出范围：{time:?}")))?;
    Ok(date.and_time(time))
}

fn parse_part(value: Option<&str>) -> Result<u32, AppError> {
    value
        .ok_or_else(|| AppError::Parse("日期时间字段缺失".to_string()))?
        .trim()
        .parse::<u32>()
        .map_err(|_| AppError::Parse("日期时间字段无法解析".to_string()))
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

    fn fixture_bytes() -> Vec<u8> {
        let mut bytes = GBK_HEADER_BYTES.to_vec();
        bytes.extend_from_slice(b"\r\n2024/1/20,0:00:10,14.7,20\r\n2024/1/20,0:00:40,51.4,70\r\n");
        bytes
    }

    #[test]
    fn probe_and_parse_gbk_temp_csv() {
        let fixture = TempFile::new("csv", fixture_bytes());
        assert!(probe_gbk_4col_temp_csv(&fixture.path).unwrap());
        let dataset = parse_gbk_4col_temp_csv(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "gbk-4col-temp-csv");
        assert_eq!(dataset.controller_rule, "gbk-4col-temp-csv-v1");
        assert_eq!(dataset.row_count, 2);
        assert_eq!(dataset.axes.len(), 1);
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert_eq!(actual_temp.points[0].1, Some(14.7));
        assert_eq!(actual_temp.points[1].1, Some(51.4));
        assert_eq!(dataset.series.len(), 2);
    }

    #[test]
    fn rejects_non_gbk_headers() {
        let fixture = TempFile::new(
            "csv",
            b"Date,Time,Temperature\n2024/1/20,0:00:10,14.7\n".to_vec(),
        );
        assert!(!probe_gbk_4col_temp_csv(&fixture.path).unwrap());
    }

    #[test]
    #[ignore = "requires CHAMBER_ATEC_GBK_ROOT with the private Atec shock chamber sample"]
    fn external_atec_gbk_parses_the_sample() {
        let root = std::path::PathBuf::from(
            std::env::var_os("CHAMBER_ATEC_GBK_ROOT")
                .expect("set CHAMBER_ATEC_GBK_ROOT to the Atec shock chamber sample folder"),
        );
        let path = root.join("20240120.csv");
        let dataset = parse_gbk_4col_temp_csv(&path).unwrap();
        assert_eq!(dataset.parser, "gbk-4col-temp-csv");
        assert_eq!(dataset.row_count, 2_470);
        assert_eq!(dataset.series.len(), 2);
    }
}
