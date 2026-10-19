use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};

use super::timed_rows::{infer_period_millis, TimedRow};
use crate::data::controller_rules::{FieldSourceRule, KR_RCD_BIN_RULE};
use crate::data::errors::AppError;
use crate::data::merge_sources::{merge_sources, SourceRows};
use crate::data::model::dataset_source;

const HEADER_SIZE: usize = 48;
const RECORD_SIZE: usize = 20;
const CHANNEL_COUNT: usize = 4;
const MISSING_VALUE: f32 = -99_999.0;

#[derive(Debug, Clone)]
struct ParsedRow {
    timestamp: NaiveDateTime,
    values: [Option<f64>; CHANNEL_COUNT],
}

pub fn probe_kr_rcd_bin(path: &Path) -> Result<bool, AppError> {
    let file_len = std::fs::metadata(path)?.len();
    if file_len < (HEADER_SIZE + RECORD_SIZE) as u64 {
        return Ok(false);
    }
    if (file_len - HEADER_SIZE as u64) % RECORD_SIZE as u64 != 0 {
        return Ok(false);
    }
    let mut header = [0_u8; HEADER_SIZE];
    File::open(path)?.read_exact(&mut header)?;
    if !valid_header(&header) {
        return Ok(false);
    }
    if header_datetime(&header).is_err() {
        return Ok(false);
    }
    let mut first_record = [0_u8; RECORD_SIZE];
    let mut file = File::open(path)?;
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(HEADER_SIZE as u64))?;
    file.read_exact(&mut first_record)?;
    let elapsed = u32::from_le_bytes(first_record[0..4].try_into().unwrap());
    if elapsed != 0 {
        return Ok(false);
    }
    let values: [f32; 4] = read_f32s(&first_record, 4);
    if !values.iter().all(|value| value.is_finite()) {
        return Ok(false);
    }
    Ok(true)
}

pub(crate) fn parse_kr_rcd_bin_rows(path: &Path) -> Result<SourceRows, AppError> {
    KR_RCD_BIN_RULE.validate()?;
    let source = dataset_source(path)?;
    let mut bytes = Vec::new();
    File::open(path)?.read_to_end(&mut bytes)?;
    if bytes.len() < HEADER_SIZE + RECORD_SIZE || (bytes.len() - HEADER_SIZE) % RECORD_SIZE != 0 {
        return Err(AppError::Parse(format!(
            "文件 {}：汉测 bin 长度无效",
            source.source_file
        )));
    }
    let header: [u8; HEADER_SIZE] = bytes[..HEADER_SIZE].try_into().unwrap();
    if !valid_header(&header) {
        return Err(AppError::Parse(format!(
            "文件 {}：不是汉测 bin 记录格式",
            source.source_file
        )));
    }
    let start = header_datetime(&header)?;
    let words = semantic_words()?;

    let mut rows = Vec::new();
    let mut invalid_counts = [0_usize; CHANNEL_COUNT];
    let mut previous_elapsed: Option<u32> = None;
    for chunk in bytes[HEADER_SIZE..].chunks_exact(RECORD_SIZE) {
        let elapsed = u32::from_le_bytes(chunk[0..4].try_into().unwrap());
        if let Some(previous) = previous_elapsed {
            if elapsed <= previous {
                return Err(AppError::Parse(format!(
                    "文件 {}：汉测 bin 记录时间必须严格递增",
                    source.source_file
                )));
            }
        }
        previous_elapsed = Some(elapsed);

        let raw: [f32; 4] = read_f32s(chunk, 4);
        let timestamp = start + Duration::seconds(elapsed as i64);
        let mut values = [None; CHANNEL_COUNT];
        for (semantic, word) in words.iter().enumerate() {
            match parse_value(raw[*word]) {
                Some(value) => values[semantic] = Some(value),
                None => invalid_counts[semantic] += 1,
            }
        }
        rows.push(ParsedRow { timestamp, values });
    }

    if rows.is_empty() {
        return Err(AppError::NoDisplayableData(format!(
            "{} 中没有汉测 bin 采样行",
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

pub fn parse_kr_rcd_bin(path: &Path) -> Result<crate::data::model::Dataset, AppError> {
    let source = parse_kr_rcd_bin_rows(path)?;
    merge_sources(vec![source], &KR_RCD_BIN_RULE)
}

fn valid_header(header: &[u8; HEADER_SIZE]) -> bool {
    if u32::from_le_bytes(header[0..4].try_into().unwrap()) != HEADER_SIZE as u32 {
        return false;
    }
    let interval = u16::from_le_bytes(header[0x16..0x18].try_into().unwrap());
    if interval == 0 || interval > 3_600 {
        return false;
    }
    header_datetime(header).is_ok()
}

fn header_datetime(header: &[u8; HEADER_SIZE]) -> Result<NaiveDateTime, AppError> {
    let year = u16::from_le_bytes(header[0x0A..0x0C].try_into().unwrap()) as i32;
    let month = header[0x0E] as u32;
    let day = header[0x0F] as u32;
    let hour = header[0x10] as u32;
    let minute = header[0x11] as u32;
    let second = header[0x12] as u32;
    let date = NaiveDate::from_ymd_opt(year, month, day)
        .ok_or_else(|| AppError::Parse("汉测 bin 表头日期无效".to_string()))?;
    let time = NaiveTime::from_hms_opt(hour, minute, second)
        .ok_or_else(|| AppError::Parse("汉测 bin 表头时间无效".to_string()))?;
    Ok(date.and_time(time))
}

fn semantic_words() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut words = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in KR_RCD_BIN_RULE.series.iter().enumerate() {
        let FieldSourceRule::Word(word) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置二进制字位置",
                KR_RCD_BIN_RULE.id, series.id
            )));
        };
        words[semantic] = word;
    }
    Ok(words)
}

fn read_f32s(bytes: &[u8], offset: usize) -> [f32; 4] {
    let mut values = [0.0_f32; 4];
    for (index, value) in values.iter_mut().enumerate() {
        let start = offset + index * 4;
        *value = f32::from_le_bytes(bytes[start..start + 4].try_into().unwrap());
    }
    values
}

fn parse_value(raw: f32) -> Option<f64> {
    if !raw.is_finite() || raw == MISSING_VALUE {
        return None;
    }
    Some(raw as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::test_support::TempFile;

    fn fixture_bytes() -> Vec<u8> {
        let mut bytes = vec![0_u8; HEADER_SIZE + RECORD_SIZE * 2];
        bytes[0..4].copy_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
        bytes[0x0A..0x0C].copy_from_slice(&2026_u16.to_le_bytes());
        bytes[0x0E] = 6;
        bytes[0x0F] = 23;
        bytes[0x10] = 11;
        bytes[0x11] = 12;
        bytes[0x12] = 19;
        bytes[0x16..0x18].copy_from_slice(&60_u16.to_le_bytes());

        let record_values = [
            (0_u32, [14.77_f32, 100.0, -99999.0, -99999.0]),
            (4_u32, [14.87_f32, 100.0, -99999.0, 3.77]),
        ];
        for (index, (elapsed, values)) in record_values.iter().enumerate() {
            let offset = HEADER_SIZE + index * RECORD_SIZE;
            bytes[offset..offset + 4].copy_from_slice(&elapsed.to_le_bytes());
            for (value_index, value) in values.iter().enumerate() {
                let start = offset + 4 + value_index * 4;
                bytes[start..start + 4].copy_from_slice(&value.to_le_bytes());
            }
        }
        bytes
    }

    #[test]
    fn probe_and_parse_kr_rcd_bin() {
        let fixture = TempFile::new("bin", fixture_bytes());
        assert!(probe_kr_rcd_bin(&fixture.path).unwrap());
        let dataset = parse_kr_rcd_bin(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "kr-rcd-bin");
        assert_eq!(dataset.controller_rule, "kr-rcd-bin-v1");
        assert_eq!(dataset.row_count, 2);
        assert_eq!(dataset.time_range.start, "2026-06-23 11:12:19");
        assert_eq!(dataset.time_range.end, "2026-06-23 11:12:23");
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert!((actual_temp.points[0].1.unwrap() - 14.77).abs() < 1e-6);
        assert!((actual_temp.points[1].1.unwrap() - 14.87).abs() < 1e-6);
        let set_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "set-humidity")
            .unwrap();
        assert!(set_humidity.points[0].1.is_none());
        assert!((set_humidity.points[1].1.unwrap() - 3.77).abs() < 1e-6);
    }

    #[test]
    fn rejects_wrong_header_length() {
        let mut bytes = fixture_bytes();
        bytes[0..4].copy_from_slice(&40_u32.to_le_bytes());
        let fixture = TempFile::new("bin", bytes);
        assert!(!probe_kr_rcd_bin(&fixture.path).unwrap());
    }

    #[test]
    #[ignore = "requires CHAMBER_HANCHE_ROOT with the private Hanche samples"]
    fn external_hanche_bin_parses_every_sample() {
        let root = std::path::PathBuf::from(
            std::env::var_os("CHAMBER_HANCHE_ROOT")
                .expect("set CHAMBER_HANCHE_ROOT to the Hanche sample folder"),
        );
        let mut paths = std::fs::read_dir(root.join("kr_rcd"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("bin"))
            })
            .collect::<Vec<_>>();
        paths.sort();
        assert_eq!(paths.len(), 3);
        for path in paths {
            let dataset = parse_kr_rcd_bin(&path).unwrap();
            assert_eq!(dataset.parser, "kr-rcd-bin");
            assert!(dataset.row_count > 0);
        }
    }
}
