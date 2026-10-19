use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDateTime;
use csv::StringRecord;

use super::timed_rows::{infer_period_millis, TimedRow};
use crate::data::controller_rules::{FieldSourceRule, KR_TSV_RULE};
use crate::data::errors::AppError;
use crate::data::merge_sources::{merge_sources, SourceRows};
use crate::data::model::dataset_source;

const CHANNEL_COUNT: usize = 4;
const PROBE_RECORD_LIMIT: usize = 64;
const MAX_TOTAL_PROBE_RECORDS: usize = 256;
const MAX_PROBE_BYTES: u64 = 256 * 1024;
const MISSING_VALUE: f64 = -99_999.0;

#[derive(Debug, Clone)]
struct ParsedRow {
    timestamp: NaiveDateTime,
    values: [Option<f64>; CHANNEL_COUNT],
}

pub fn probe_kr_tsv(path: &Path) -> Result<bool, AppError> {
    let file = File::open(path)?;
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b'\t')
        .from_reader(file.take(MAX_PROBE_BYTES));
    let headers = match reader.headers() {
        Ok(headers) => headers,
        Err(_) => return Ok(false),
    };
    if !is_kr_tsv_header(headers) {
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

pub(crate) fn parse_kr_tsv_rows(path: &Path) -> Result<SourceRows, AppError> {
    KR_TSV_RULE.validate()?;
    let source = dataset_source(path)?;
    let mut reader = csv::ReaderBuilder::new().delimiter(b'\t').from_path(path)?;
    let headers = reader.headers()?;
    if !is_kr_tsv_header(headers) {
        return Err(AppError::Parse(format!(
            "文件 {}：不是汉测 TSV",
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
            "{} 中没有汉测 TSV 采样行",
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

pub fn parse_kr_tsv(path: &Path) -> Result<crate::data::model::Dataset, AppError> {
    let source = parse_kr_tsv_rows(path)?;
    merge_sources(vec![source], &KR_TSV_RULE)
}

fn is_kr_tsv_header(headers: &StringRecord) -> bool {
    headers.len() == 5
        && headers.iter().enumerate().all(|(index, header)| {
            let normalized = header.trim_start_matches('\u{feff}').trim();
            match index {
                0 => normalized == "TIME",
                1 => normalized == "TEMP_PV",
                2 => normalized == "TEMP_SV",
                3 => normalized == "HUMI_PV",
                _ => normalized == "HUMI_SV",
            }
        })
}

fn semantic_columns() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut columns = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in KR_TSV_RULE.series.iter().enumerate() {
        let FieldSourceRule::Column(column) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置 CSV 列号",
                KR_TSV_RULE.id, series.id
            )));
        };
        columns[semantic] = column;
    }
    Ok(columns)
}

fn parse_timestamp(time: &str) -> Result<NaiveDateTime, AppError> {
    NaiveDateTime::parse_from_str(time, "%Y-%m-%d %H:%M:%S")
        .map_err(|error| AppError::Parse(format!("时间戳解析失败：{error}")))
}

fn parse_value(value: Option<&str>) -> Option<f64> {
    let text = value.unwrap_or("").trim();
    let parsed = match text.parse::<f64>() {
        Ok(value) if value.is_finite() => value,
        _ => return None,
    };
    if parsed == MISSING_VALUE {
        None
    } else {
        Some(parsed)
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
            "xls",
            b"TIME\tTEMP_PV\tTEMP_SV\tHUMI_PV\tHUMI_SV\n\
2026-06-23 11:12:19\t14.77\t100.00\t-99999.00\t-99999.00\n\
2026-06-23 11:12:23\t14.87\t100.00\t50.00\t40.00\n"
                .to_vec(),
        )
    }

    #[test]
    fn probe_and_parse_kr_tsv() {
        let fixture = fixture();
        assert!(probe_kr_tsv(&fixture.path).unwrap());
        let dataset = parse_kr_tsv(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "kr-tsv");
        assert_eq!(dataset.controller_rule, "kr-tsv-v1");
        assert_eq!(dataset.row_count, 2);
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert_eq!(actual_temp.points[0].1, Some(14.77));
        assert_eq!(actual_temp.points[1].1, Some(14.87));
        let actual_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-humidity")
            .unwrap();
        assert!(actual_humidity.points[0].1.is_none());
        assert_eq!(actual_humidity.points[1].1, Some(50.0));
    }

    #[test]
    fn rejects_other_delimited_structures() {
        let fixture = TempFile::new("xls", b"TIME,VALUE\n2026-06-23 11:12:19,1\n".to_vec());
        assert!(!probe_kr_tsv(&fixture.path).unwrap());
    }

    #[test]
    #[ignore = "requires CHAMBER_HANCHE_ROOT with the private Hanche samples"]
    fn external_hanche_tsv_parses_every_sample() {
        let root = std::path::PathBuf::from(
            std::env::var_os("CHAMBER_HANCHE_ROOT")
                .expect("set CHAMBER_HANCHE_ROOT to the Hanche sample folder"),
        );
        let mut paths = std::fs::read_dir(root.join("kr_xls"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("xls"))
            })
            .collect::<Vec<_>>();
        paths.sort();
        assert_eq!(paths.len(), 3);
        for path in paths {
            let dataset = parse_kr_tsv(&path).unwrap();
            assert_eq!(dataset.parser, "kr-tsv");
            assert!(dataset.row_count > 0);
        }
    }
}
