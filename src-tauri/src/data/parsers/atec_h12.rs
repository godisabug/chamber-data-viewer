use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDateTime;

use super::timed_rows::{infer_period_millis, TimedRow};
use crate::data::controller_rules::{FieldSourceRule, ATEC_H12_RULE};
use crate::data::errors::AppError;
use crate::data::merge_sources::{merge_sources, SourceRows};
use crate::data::model::dataset_source;

const RECORD_SIZE: usize = 8;
const CHANNEL_COUNT: usize = 2;
const SAMPLE_INTERVAL: i64 = 30;
/// 2010-01-01 00:00:00 ~ 2035-01-01 00:00:00 的 Unix 秒范围。
const MIN_TIMESTAMP: i64 = 1_262_304_000;
const MAX_TIMESTAMP: i64 = 2_050_819_200;
/// 记录器存的是 UTC Unix 秒；设备在中国使用，按 UTC+8 换算为墙上时间。
/// 依据：导出文件夹时间（本地）与最后采样时刻的相对关系交叉验证。
const WALL_CLOCK_OFFSET_SECONDS: i64 = 8 * 3_600;
/// 温度原始值有效范围（×0.1，即 -100.0~100.0℃）；`-10000` 为无传感器哨兵。
const MIN_TEMP_RAW: i32 = -1_000;
const MAX_TEMP_RAW: i32 = 1_000;
/// 湿度原始值有效范围（×0.1，即 0~100.0%RH）；`65535` 及更大值视为缺失。
const MAX_HUMIDITY_RAW: u32 = 1_000;

#[derive(Debug, Clone)]
struct ParsedRow {
    timestamp: NaiveDateTime,
    values: [Option<f64>; CHANNEL_COUNT],
}

pub fn probe_atec_h12(path: &Path) -> Result<bool, AppError> {
    let file_len = std::fs::metadata(path)?.len();
    if file_len < RECORD_SIZE as u64 * 2 || file_len % RECORD_SIZE as u64 != 0 {
        return Ok(false);
    }
    let mut bytes = Vec::with_capacity(file_len as usize);
    File::open(path)?.read_to_end(&mut bytes)?;

    let mut previous: Option<i64> = None;
    let mut delta_30_count = 0_u32;
    let mut delta_total = 0_u32;
    let mut temp_ok = 0_u32;
    let mut humidity_ok = 0_u32;
    let record_count = (bytes.len() / RECORD_SIZE) as u32;
    let mut first_timestamp: Option<i64> = None;

    for chunk in bytes.chunks_exact(RECORD_SIZE) {
        let timestamp = i64::from(u32::from_le_bytes(
            chunk[0..4].try_into().unwrap(),
        ));
        if first_timestamp.is_none() {
            first_timestamp = Some(timestamp);
        }
        if let Some(previous_timestamp) = previous {
            if timestamp <= previous_timestamp {
                return Ok(false);
            }
            delta_total += 1;
            if timestamp - previous_timestamp == SAMPLE_INTERVAL {
                delta_30_count += 1;
            }
        }
        previous = Some(timestamp);

        let packed = u32::from_le_bytes(chunk[4..8].try_into().unwrap());
        let temp_raw = ((packed >> 16) & 0xFFFF) as i16 as i32;
        if (-10_000..=MAX_TEMP_RAW).contains(&temp_raw) {
            temp_ok += 1;
        }
        let humidity_raw = packed & 0xFFFF;
        if humidity_raw <= MAX_HUMIDITY_RAW || humidity_raw >= 65_000 {
            humidity_ok += 1;
        }
    }

    let Some(first) = first_timestamp else {
        return Ok(false);
    };
    if !(MIN_TIMESTAMP..=MAX_TIMESTAMP).contains(&first) {
        return Ok(false);
    }
    if delta_total == 0 {
        return Ok(false);
    }
    if delta_30_count * 2 < delta_total {
        return Ok(false);
    }
    if temp_ok * 2 < record_count || humidity_ok * 2 < record_count {
        return Ok(false);
    }
    Ok(true)
}

pub(crate) fn parse_atec_h12_rows(path: &Path) -> Result<SourceRows, AppError> {
    ATEC_H12_RULE.validate()?;
    let source = dataset_source(path)?;
    let mut bytes = Vec::new();
    File::open(path)?.read_to_end(&mut bytes)?;
    if bytes.len() < RECORD_SIZE * 2 || bytes.len() % RECORD_SIZE != 0 {
        return Err(AppError::Parse(format!(
            "文件 {}：阿泰可 .h12 长度无效",
            source.source_file
        )));
    }
    let words = semantic_words()?;

    let mut rows = Vec::new();
    let mut invalid_counts = [0_usize; CHANNEL_COUNT];
    let mut previous: Option<NaiveDateTime> = None;
    for chunk in bytes.chunks_exact(RECORD_SIZE) {
        let timestamp = u32::from_le_bytes(chunk[0..4].try_into().unwrap());
        let naive = chrono::DateTime::UNIX_EPOCH
            .naive_utc()
            .checked_add_signed(chrono::Duration::seconds(
                timestamp as i64 + WALL_CLOCK_OFFSET_SECONDS,
            ))
            .ok_or_else(|| {
                AppError::Parse(format!("文件 {}：时间戳超出范围", source.source_file))
            })?;
        if let Some(previous_timestamp) = previous {
            if naive <= previous_timestamp {
                return Err(AppError::Parse(format!(
                    "文件 {}：阿泰可 .h12 记录时间必须严格递增",
                    source.source_file
                )));
            }
        }
        previous = Some(naive);

        let packed = u32::from_le_bytes(chunk[4..8].try_into().unwrap());
        let temp_raw = ((packed >> 16) & 0xFFFF) as i16 as i32;
        let humidity_raw = packed & 0xFFFF;
        let mut values = [None; CHANNEL_COUNT];
        for (semantic, word) in words.iter().enumerate() {
            let parsed = match word {
                0 => parse_temp(temp_raw),
                _ => parse_humidity(humidity_raw),
            };
            match parsed {
                Some(value) => values[semantic] = Some(value),
                None => invalid_counts[semantic] += 1,
            }
        }
        rows.push(ParsedRow {
            timestamp: naive,
            values,
        });
    }

    if rows.is_empty() {
        return Err(AppError::NoDisplayableData(format!(
            "{} 中没有阿泰可 .h12 采样行",
            source.source_file
        )));
    }

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

pub fn parse_atec_h12(path: &Path) -> Result<crate::data::model::Dataset, AppError> {
    let source = parse_atec_h12_rows(path)?;
    merge_sources(vec![source], &ATEC_H12_RULE)
}

fn semantic_words() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut words = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in ATEC_H12_RULE.series.iter().enumerate() {
        let FieldSourceRule::Word(word) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置 16 位字位置",
                ATEC_H12_RULE.id, series.id
            )));
        };
        words[semantic] = word;
    }
    Ok(words)
}

fn parse_temp(raw: i32) -> Option<f64> {
    if !(MIN_TEMP_RAW..=MAX_TEMP_RAW).contains(&raw) {
        return None;
    }
    Some(raw as f64 * 0.1)
}

fn parse_humidity(raw: u32) -> Option<f64> {
    if raw > MAX_HUMIDITY_RAW {
        return None;
    }
    Some(raw as f64 * 0.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::test_support::TempFile;

    fn fixture_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        // 2026-04-25 07:25:47 起，30 秒一条，温度 95.0℃、湿度 40.0%RH。
        let start = 1_777_073_147_u32;
        for (index, (temp, humidity)) in
            [(950_i32, 400_u32), (935, 400), (-10_000, 400), (950, 65_535)].iter().enumerate()
        {
            bytes.extend_from_slice(&(start + index as u32 * 30).to_le_bytes());
            let packed = ((*temp as u32) << 16) | *humidity;
            bytes.extend_from_slice(&packed.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn probe_and_parse_atec_h12() {
        let fixture = TempFile::new("h12", fixture_bytes());
        assert!(probe_atec_h12(&fixture.path).unwrap());
        let dataset = parse_atec_h12(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "atec-h12");
        assert_eq!(dataset.controller_rule, "atec-h12-v1");
        assert_eq!(dataset.row_count, 4);
        assert_eq!(dataset.time_range.start, "2026-04-25 07:25:47");
        assert_eq!(dataset.time_range.end, "2026-04-25 07:27:17");
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert_eq!(actual_temp.points[0].1, Some(95.0));
        assert_eq!(actual_temp.points[1].1, Some(93.5));
        assert_eq!(actual_temp.points[2].1, None);
        let actual_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-humidity")
            .unwrap();
        assert_eq!(actual_humidity.points[0].1, Some(40.0));
        assert_eq!(actual_humidity.points[3].1, None);
        assert_eq!(dataset.series.len(), 2);
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains("实测温度有 1 个无效原始值")
        }));
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains("实测湿度有 1 个无效原始值")
        }));
    }

    #[test]
    fn rejects_files_without_30_second_dominant_sampling() {
        let mut bytes = Vec::new();
        for index in 0..8_u32 {
            bytes.extend_from_slice(&(1_777_073_147 + index * 61).to_le_bytes());
            bytes.extend_from_slice(&0x03E8_0190_u32.to_le_bytes());
        }
        let fixture = TempFile::new("h12", bytes);
        assert!(!probe_atec_h12(&fixture.path).unwrap());
    }

    #[test]
    fn rejects_random_binary() {
        let fixture = TempFile::new("h12", vec![0x5A; 64]);
        assert!(!probe_atec_h12(&fixture.path).unwrap());
    }
}
