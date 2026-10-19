use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDateTime;
use csv::StringRecord;

use super::timed_rows::{infer_period_millis, TimedRow};
use crate::data::controller_rules::{FieldSourceRule, INT16_7COL_CSV_RULE};
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

pub fn probe_int16_7col_csv(path: &Path) -> Result<bool, AppError> {
    let file = File::open(path)?;
    let mut reader = csv::ReaderBuilder::new().from_reader(file.take(MAX_PROBE_BYTES));
    let headers = match reader.headers() {
        Ok(headers) => headers,
        Err(_) => return Ok(false),
    };
    if !is_int16_7col_header(headers) {
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
            if parse_timestamp(date, time, record.get(2).unwrap_or("")).is_ok() {
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

pub(crate) fn parse_int16_7col_csv_rows(path: &Path) -> Result<SourceRows, AppError> {
    INT16_7COL_CSV_RULE.validate()?;
    let source = dataset_source(path)?;
    let mut reader = csv::ReaderBuilder::new().from_path(path)?;
    let headers = reader.headers()?;
    if !is_int16_7col_header(headers) {
        return Err(AppError::Parse(format!(
            "文件 {}：不是 16 位 7 列 CSV",
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
        let timestamp = parse_timestamp(date, time, record.get(2).unwrap_or(""))?;
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
            "{} 中没有 16 位 7 列 CSV 采样行",
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

pub fn parse_int16_7col_csv(path: &Path) -> Result<crate::data::model::Dataset, AppError> {
    let source = parse_int16_7col_csv_rows(path)?;
    merge_sources(vec![source], &INT16_7COL_CSV_RULE)
}

fn is_int16_7col_header(headers: &StringRecord) -> bool {
    headers.len() == 7
        && headers.iter().enumerate().all(|(index, header)| {
            let normalized = header.trim_start_matches('\u{feff}').trim();
            match index {
                0 => normalized == "Date",
                1 => normalized == "Time",
                2 => normalized == "Millisecond",
                _ => normalized == "16-bit Signed",
            }
        })
}

fn semantic_columns() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut columns = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in INT16_7COL_CSV_RULE.series.iter().enumerate() {
        let FieldSourceRule::Column(column) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置 CSV 列号",
                INT16_7COL_CSV_RULE.id, series.id
            )));
        };
        columns[semantic] = column;
    }
    Ok(columns)
}

fn parse_timestamp(date: &str, time: &str, millisecond: &str) -> Result<NaiveDateTime, AppError> {
    let millisecond = millisecond.trim();
    let millisecond: u32 = millisecond
        .parse()
        .map_err(|_| AppError::Parse(format!("毫秒字段无法解析：{millisecond:?}")))?;
    if millisecond > 999 {
        return Err(AppError::Parse(format!("毫秒字段超出范围：{millisecond}")));
    }
    NaiveDateTime::parse_from_str(
        &format!("{date} {time}.{millisecond:03}"),
        "%Y/%m/%d %H:%M:%S%.3f",
    )
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
        TempFile::new(
            "csv",
            br#""Date","Time","Millisecond","16-bit Signed","16-bit Signed","16-bit Signed","16-bit Signed"
"2026/08/02","00:00:18","480","499","500","500","496"
"2026/08/02","00:00:48","560","302","500","500","301"
"2026/08/02","00:01:18","620","32767","300","500","300"
"#
            .to_vec(),
        )
    }

    #[test]
    fn probe_and_parse_int16_7col_csv() {
        let fixture = fixture();
        assert!(probe_int16_7col_csv(&fixture.path).unwrap());
        let dataset = parse_int16_7col_csv(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "16bit-7col-csv");
        assert_eq!(dataset.controller_rule, "16bit-7col-csv-v1");
        assert_eq!(dataset.row_count, 3);
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert!((actual_temp.points[0].1.unwrap() - 49.9).abs() < 1e-9);
        assert!((actual_temp.points[1].1.unwrap() - 30.2).abs() < 1e-9);
        assert_eq!(actual_temp.points[2].1, None);
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains("实测温度有 1 个无效原始值")
        }));
    }

    #[test]
    fn rejects_other_csv_structures() {
        let fixture = TempFile::new("csv", b"Date,Time,Value\n2026/01/01,00:00:00,1\n".to_vec());
        assert!(!probe_int16_7col_csv(&fixture.path).unwrap());
    }

    #[test]
    #[ignore = "requires CHAMBER_ATEC_INT16_ROOT with the private Atec 16-bit 7-column CSV samples"]
    fn external_atec_int16_folder_parses_every_sample() {
        let root = std::path::PathBuf::from(
            std::env::var_os("CHAMBER_ATEC_INT16_ROOT")
                .expect("set CHAMBER_ATEC_INT16_ROOT to the Atec 16-bit 7-column CSV sample folder"),
        );
        let mut paths = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"))
            })
            .collect::<Vec<_>>();
        paths.sort();
        assert_eq!(paths.len(), 6);
        for path in paths {
            let dataset = parse_int16_7col_csv(&path).unwrap();
            assert_eq!(dataset.parser, "16bit-7col-csv");
            assert!(dataset.row_count > 0);
        }
    }
}
