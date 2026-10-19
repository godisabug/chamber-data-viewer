use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDateTime;

use super::timed_rows::{infer_period_millis, TimedRow};
use crate::data::controller_rules::{FieldSourceRule, FREUD_S1_HISTORY_CSV_RULE};
use crate::data::errors::AppError;
use crate::data::merge_sources::{merge_sources, SourceRows};
use crate::data::model::{dataset_source, Dataset, DatasetSource};

const CHANNEL_COUNT: usize = 4;
const MAX_PROBE_BYTES: u64 = 256 * 1024;
const MIN_EPOCH_MILLIS: i64 = 1_500_000_000_000;
const MAX_EPOCH_MILLIS: i64 = 2_200_000_000_000;
/// 弗锐德记录器导出的是 UTC Unix 毫秒；设备在中国使用，按 UTC+8 换算为墙上时间。
/// 该约定依据导出文件名（本地时间）与最后采样时刻的相对关系推断，待桌面验收复核。
const WALL_CLOCK_OFFSET_SECONDS: i64 = 8 * 3_600;

#[derive(Debug, Clone)]
struct ParsedRow {
    timestamp: NaiveDateTime,
    values: [Option<f64>; CHANNEL_COUNT],
}

pub fn probe_freud_s1_history_csv(path: &Path) -> Result<bool, AppError> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_PROBE_BYTES)
        .read_to_end(&mut bytes)?;
    Ok(probe_freud_s1_history_bytes(&bytes))
}

pub(crate) fn probe_freud_s1_history_bytes(bytes: &[u8]) -> bool {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(bytes);
    let mut examined = 0;
    let mut previous_seq: Option<i64> = None;
    let mut previous_millis: Option<i64> = None;
    for record_result in reader.records().take(256) {
        let Ok(record) = record_result else {
            return false;
        };
        if record.len() < 9 {
            continue;
        }
        let Ok(seq) = record[0].trim().parse::<i64>() else {
            return false;
        };
        let Ok(millis) = record[1].trim().parse::<i64>() else {
            return false;
        };
        if !(MIN_EPOCH_MILLIS..=MAX_EPOCH_MILLIS).contains(&millis) {
            return false;
        }
        if let Some(previous) = previous_seq {
            if seq <= previous {
                return false;
            }
        }
        if let Some(previous) = previous_millis {
            let delta = millis - previous;
            if delta <= 0 || delta > 3_600_000 {
                return false;
            }
        }
        let has_plausible_value = [2_usize, 3, 4, 5].iter().any(|column| {
            record
                .get(*column)
                .unwrap_or("")
                .trim()
                .parse::<f64>()
                .is_ok_and(|value| value.is_finite() && (-100.0..=300.0).contains(&value))
        });
        if !has_plausible_value {
            return false;
        }
        examined += 1;
        previous_seq = Some(seq);
        previous_millis = Some(millis);
        if examined >= 3 {
            return true;
        }
    }
    false
}

pub(crate) fn parse_freud_s1_history_bytes(
    source: &DatasetSource,
    bytes: &[u8],
) -> Result<SourceRows, AppError> {
    FREUD_S1_HISTORY_CSV_RULE.validate()?;
    let columns = semantic_columns()?;
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(bytes);

    let mut rows = Vec::new();
    let mut invalid_counts = [0_usize; CHANNEL_COUNT];
    for (row_index, record_result) in reader.records().enumerate() {
        let record = record_result.map_err(|error| {
            AppError::Parse(format!(
                "文件 {} 的第 {} 行解析失败：{error}",
                source.source_file,
                row_index + 1
            ))
        })?;
        if record.len() < 9 {
            continue;
        }
        let millis = record[1].trim().parse::<i64>().map_err(|_| {
            AppError::Parse(format!(
                "文件 {} 的第 {} 行时间戳无法解析",
                source.source_file,
                row_index + 1
            ))
        })?;
        let timestamp = chrono::DateTime::from_timestamp_millis(millis)
            .map(|value| value.naive_utc())
            .map(|value| value + chrono::Duration::seconds(WALL_CLOCK_OFFSET_SECONDS))
            .ok_or_else(|| {
                AppError::Parse(format!(
                    "文件 {} 的第 {} 行时间戳超出范围",
                    source.source_file,
                    row_index + 1
                ))
            })?;
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
            "{} 中没有弗锐德 s1_history 采样行",
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

pub(crate) fn parse_freud_s1_history_csv_rows(path: &Path) -> Result<SourceRows, AppError> {
    let source = dataset_source(path)?;
    let mut bytes = Vec::new();
    File::open(path)?.read_to_end(&mut bytes)?;
    parse_freud_s1_history_bytes(&source, &bytes)
}

pub fn parse_freud_s1_history_csv(path: &Path) -> Result<Dataset, AppError> {
    let source = parse_freud_s1_history_csv_rows(path)?;
    merge_sources(vec![source], &FREUD_S1_HISTORY_CSV_RULE)
}

fn semantic_columns() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut columns = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in FREUD_S1_HISTORY_CSV_RULE.series.iter().enumerate() {
        let FieldSourceRule::Column(column) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置 CSV 列号",
                FREUD_S1_HISTORY_CSV_RULE.id, series.id
            )));
        };
        columns[semantic] = column;
    }
    Ok(columns)
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
            b"1409746,1771902019754,16.700,49.800,16.700,49.800,0.000,0.000,139\n\
1409747,1771902024755,16.700,49.800,16.800,49.800,0.000,0.000,139\n\
1409748,1771902029757,17.000,49.800,16.900,49.800,0.000,0.000,139\n\
1409749,1771902034761,invalid,49.800,17.000,NaN,0.000,0.000,139\n"
                .to_vec(),
        )
    }

    #[test]
    fn probe_and_parse_freud_s1_history_csv() {
        let fixture = fixture();
        assert!(probe_freud_s1_history_csv(&fixture.path).unwrap());
        let dataset = parse_freud_s1_history_csv(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "freud-s1-history-csv");
        assert_eq!(dataset.controller_rule, "freud-s1-history-csv-v1");
        assert_eq!(dataset.row_count, 4);
        assert_eq!(dataset.time_range.start, "2026-02-24 11:00:19");
        assert_eq!(dataset.time_range.end, "2026-02-24 11:00:34");
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert_eq!(actual_temp.points[0].1, Some(16.7));
        assert_eq!(actual_temp.points[1].1, Some(16.7));
        assert_eq!(actual_temp.points[2].1, Some(17.0));
        assert_eq!(actual_temp.points[3].1, None);
        let actual_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-humidity")
            .unwrap();
        assert_eq!(actual_humidity.points[0].1, Some(49.8));
        assert_eq!(actual_humidity.points[3].1, Some(49.8));
        let set_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "set-temp")
            .unwrap();
        assert_eq!(set_temp.points[2].1, Some(16.9));
        let set_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "set-humidity")
            .unwrap();
        assert_eq!(set_humidity.points[3].1, None);
        assert_eq!(dataset.series.len(), 4);
    }

    #[test]
    fn rejects_other_csv_structures() {
        let fixture = TempFile::new(
            "csv",
            b"Date,Time,Value\n2026/01/01,00:00:00,1\n".to_vec(),
        );
        assert!(!probe_freud_s1_history_csv(&fixture.path).unwrap());
    }
}
