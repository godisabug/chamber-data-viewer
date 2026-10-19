use std::fmt::Write as _;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use chrono::{Datelike, NaiveDate, NaiveDateTime};
use tar::Archive;

use crate::data::controller_rules::{FieldSourceRule, SeriesRule, GUANGWUSUO_000_RULE};
use crate::data::errors::AppError;
use crate::data::model::{dataset_source, DataPoint, Dataset, Diagnostic, Series, TimeRange};
use crate::data::series_builder::effective_reading;

const PARSER_ID: &str = GUANGWUSUO_000_RULE.parser_id;
const SOURCE_MEMBER_PATH: &str = "tmp/usb/espec/SmpData.000";
const HEADER_SIZE: usize = 24;
const RECORD_SIZE: usize = 18;
const PROBE_RECORD_LIMIT: usize = 256;
const PROBE_READ_LIMIT: usize = HEADER_SIZE + PROBE_RECORD_LIMIT * RECORD_SIZE;
const STREAM_RECORD_BATCH: usize = 4_096;
const MIN_TRUSTED_RUN_LENGTH: usize = 3;
const INVALID_SETPOINT_PLACEHOLDER: u16 = 10_000;
const MAX_REASONABLE_INTERVAL_SECONDS: u16 = 3_600;

#[derive(Debug, Clone)]
struct DataRow {
    timestamp: NaiveDateTime,
    source_order: usize,
    set_temp: Option<f64>,
    actual_temp: Option<f64>,
    set_humidity: Option<f64>,
    actual_humidity: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SourceMemberMetadata {
    size: u64,
    raw_file_position: u64,
}

#[derive(Debug, Clone, Copy)]
struct SeriesWordIndices {
    set_temp: usize,
    actual_temp: usize,
    set_humidity: usize,
    actual_humidity: usize,
}

pub fn probe_guangwusuo_000(path: &Path) -> Result<bool, AppError> {
    let file = File::open(path)?;
    Ok(probe_archive(file).unwrap_or(false))
}

fn probe_archive<R: Read + Seek>(mut reader: R) -> std::io::Result<bool> {
    let archive_len = reader_len(&mut reader)?;
    let mut archive = Archive::new(reader);
    let entries = match archive.entries_with_seek() {
        Ok(entries) => entries.raw(true),
        Err(_) => return Ok(false),
    };
    let mut found_source = false;

    for entry_result in entries {
        let mut entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => return Ok(false),
        };
        let entry_path = match entry.path() {
            Ok(entry_path) => entry_path,
            Err(_) => return Ok(false),
        };
        if !is_source_member(&entry_path) {
            continue;
        }
        let Some(metadata) = source_member_metadata(&entry, archive_len) else {
            return Ok(false);
        };
        if found_source {
            return Ok(false);
        }

        if !probe_source_prefix(&mut entry, metadata.size)? {
            return Ok(false);
        }
        found_source = true;
    }

    Ok(found_source)
}

pub fn parse_guangwusuo_000(path: &Path) -> Result<Dataset, AppError> {
    GUANGWUSUO_000_RULE.validate()?;
    let mut rows = read_smp_rows(path)?;

    if rows.is_empty() {
        return Err(AppError::NoDisplayableData(
            "未找到有效的数据记录".to_string(),
        ));
    }

    let was_non_monotonic = rows
        .windows(2)
        .any(|pair| pair[1].timestamp < pair[0].timestamp);
    sort_rows_for_display(&mut rows);

    build_dataset(path, rows, was_non_monotonic)
}

fn sort_rows_for_display(rows: &mut [DataRow]) {
    rows.sort_unstable_by(|left, right| {
        left.timestamp
            .cmp(&right.timestamp)
            .then_with(|| left.source_order.cmp(&right.source_order))
    });
}

fn is_source_member(path: &Path) -> bool {
    if path.has_root() {
        return false;
    }
    let path = path.to_string_lossy().replace('\\', "/");
    if path.starts_with('/') {
        return false;
    }
    let mut normalized_parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => continue,
            ".." => return false,
            _ => normalized_parts.push(part),
        }
    }
    normalized_parts
        .join("/")
        .eq_ignore_ascii_case(SOURCE_MEMBER_PATH)
}

fn read_smp_rows(path: &Path) -> Result<Vec<DataRow>, AppError> {
    let mut file = File::open(path)?;
    let archive_len = reader_len(&mut file)?;
    let mut archive = Archive::new(file);
    let mut source_metadata = None;

    for entry_result in archive.entries_with_seek()?.raw(true) {
        let entry = entry_result?;
        let entry_path = entry
            .path()
            .map_err(|error| AppError::Parse(error.to_string()))?;
        if !is_source_member(&entry_path) {
            continue;
        }
        if source_metadata.is_some() {
            return Err(AppError::Parse(format!(
                "文件中存在多个 {SOURCE_MEMBER_PATH} 数据成员"
            )));
        }
        let Some(metadata) = source_member_metadata(&entry, archive_len) else {
            return Err(AppError::UnsupportedFormat(
                "广五所 .000 数据成员类型、大小或正文边界无效".to_string(),
            ));
        };
        source_metadata = Some(metadata);
    }

    let source_metadata = source_metadata.ok_or_else(|| {
        AppError::NoDisplayableData(format!("未找到 {SOURCE_MEMBER_PATH} 数据成员"))
    })?;
    let mut file = File::open(path)?;
    let second_archive_len = reader_len(&mut file)?;
    let mut archive = Archive::new(file);

    for entry_result in archive.entries_with_seek()?.raw(true) {
        let mut entry = entry_result?;
        let entry_path = entry
            .path()
            .map_err(|error| AppError::Parse(error.to_string()))?;
        if !is_source_member(&entry_path) {
            continue;
        }
        if source_member_metadata(&entry, second_archive_len) != Some(source_metadata) {
            return Err(AppError::Parse(
                "广五所 .000 数据成员在解析前发生变化".to_string(),
            ));
        }
        return read_source_rows(&mut entry, source_metadata.size);
    }

    Err(AppError::NoDisplayableData(format!(
        "未找到 {SOURCE_MEMBER_PATH} 数据成员"
    )))
}

fn reader_len<R: Seek>(reader: &mut R) -> std::io::Result<u64> {
    let len = reader.seek(SeekFrom::End(0))?;
    reader.seek(SeekFrom::Start(0))?;
    Ok(len)
}

fn source_member_metadata<R: Read>(
    entry: &tar::Entry<'_, R>,
    archive_len: u64,
) -> Option<SourceMemberMetadata> {
    if !entry.header().entry_type().is_file() || !has_valid_source_geometry(entry.size()) {
        return None;
    }
    let raw_file_position = entry.raw_file_position();
    let body_end = raw_file_position.checked_add(entry.size())?;
    if body_end > archive_len {
        return None;
    }
    Some(SourceMemberMetadata {
        size: entry.size(),
        raw_file_position,
    })
}

fn read_source_rows<R: Read>(reader: &mut R, source_size: u64) -> Result<Vec<DataRow>, AppError> {
    let payload_size = source_size
        .checked_sub(HEADER_SIZE as u64)
        .ok_or_else(|| AppError::Parse("广五所 .000 数据长度不足".to_string()))?;
    let record_count_u64 = payload_size / RECORD_SIZE as u64;
    let record_count = usize::try_from(record_count_u64)
        .map_err(|_| AppError::Parse("广五所 .000 记录数量超出当前平台可处理范围".to_string()))?;
    let prefix_record_count = record_count.min(PROBE_RECORD_LIMIT);
    let prefix_len = HEADER_SIZE + prefix_record_count * RECORD_SIZE;
    let mut prefix = zeroed_buffer(prefix_len, "探测前缀")?;
    reader.read_exact(&mut prefix)?;
    if !has_trusted_record_run(&prefix) {
        return Err(AppError::UnsupportedFormat(
            "数据记录未形成可信的广五所 .000 连续采样序列".to_string(),
        ));
    }

    let indices = series_word_indices()?;
    let mut rows = Vec::new();
    append_rows(&prefix[HEADER_SIZE..], indices, &mut rows)?;

    let mut remaining_records = record_count - prefix_record_count;
    let batch_record_capacity = remaining_records.min(STREAM_RECORD_BATCH);
    let mut batch = zeroed_buffer(batch_record_capacity * RECORD_SIZE, "流式记录缓冲区")?;
    while remaining_records > 0 {
        let batch_record_count = remaining_records.min(STREAM_RECORD_BATCH);
        let batch_len = batch_record_count * RECORD_SIZE;
        reader.read_exact(&mut batch[..batch_len])?;
        append_rows(&batch[..batch_len], indices, &mut rows)?;
        remaining_records -= batch_record_count;
    }

    Ok(rows)
}

fn zeroed_buffer(len: usize, purpose: &str) -> Result<Vec<u8>, AppError> {
    let mut buffer = Vec::new();
    try_reserve_exact(&mut buffer, len, purpose)?;
    buffer.resize(len, 0);
    Ok(buffer)
}

fn try_reserve_additional<T>(
    items: &mut Vec<T>,
    additional: usize,
    purpose: &str,
) -> Result<(), AppError> {
    items
        .try_reserve(additional)
        .map_err(|_| allocation_error(purpose))
}

fn try_reserve_exact<T>(
    items: &mut Vec<T>,
    additional: usize,
    purpose: &str,
) -> Result<(), AppError> {
    items
        .try_reserve_exact(additional)
        .map_err(|_| allocation_error(purpose))
}

fn empty_string_with_capacity(capacity: usize, purpose: &str) -> Result<String, AppError> {
    let mut value = String::new();
    value
        .try_reserve_exact(capacity)
        .map_err(|_| allocation_error(purpose))?;
    Ok(value)
}

fn allocation_error(purpose: &str) -> AppError {
    AppError::Parse(format!("内存不足，无法分配广五所 .000 {purpose}"))
}

fn series_word_indices() -> Result<SeriesWordIndices, AppError> {
    Ok(SeriesWordIndices {
        set_temp: series_word("set-temp")?,
        actual_temp: series_word("actual-temp")?,
        set_humidity: series_word("set-humidity")?,
        actual_humidity: series_word("actual-humidity")?,
    })
}

fn append_rows(
    payload: &[u8],
    indices: SeriesWordIndices,
    rows: &mut Vec<DataRow>,
) -> Result<(), AppError> {
    let record_slots = payload.len() / RECORD_SIZE;
    try_reserve_additional(rows, record_slots, "数据行")?;
    for record in payload.chunks_exact(RECORD_SIZE) {
        let words = read_words(record)?;
        let Some(timestamp) = decode_dos_datetime(words[2], words[3]) else {
            continue;
        };
        if !(2000..=2100).contains(&timestamp.year()) || !is_plausible_interval(words[4]) {
            continue;
        }

        let source_order = rows.len();
        rows.push(DataRow {
            timestamp,
            source_order,
            set_temp: setpoint_tenths(words[indices.set_temp]),
            actual_temp: measurement_tenths(words[indices.actual_temp]),
            set_humidity: setpoint_tenths(words[indices.set_humidity]),
            actual_humidity: measurement_tenths(words[indices.actual_humidity]),
        });
    }
    Ok(())
}

fn series_word(series_id: &str) -> Result<usize, AppError> {
    let rule = GUANGWUSUO_000_RULE.series_rule(series_id)?;
    let FieldSourceRule::Word(index) = rule.source else {
        return Err(AppError::Parse(format!(
            "控制器规则 {} 的曲线 {} 未配置二进制字段位置",
            GUANGWUSUO_000_RULE.id, series_id
        )));
    };
    if index >= 9 {
        return Err(AppError::Parse(format!(
            "控制器规则 {} 的曲线 {} 字段位置超出记录范围",
            GUANGWUSUO_000_RULE.id, series_id
        )));
    }
    Ok(index)
}

fn is_plausible_interval(value: u16) -> bool {
    (1..=MAX_REASONABLE_INTERVAL_SECONDS).contains(&value)
}

fn has_valid_source_geometry(size: u64) -> bool {
    if size < (HEADER_SIZE + MIN_TRUSTED_RUN_LENGTH * RECORD_SIZE) as u64 {
        return false;
    }
    (size - HEADER_SIZE as u64) % RECORD_SIZE as u64 == 0
}

fn probe_source_prefix<R: Read>(reader: &mut R, source_size: u64) -> std::io::Result<bool> {
    let prefix_len = usize::try_from(source_size.min(PROBE_READ_LIMIT as u64)).unwrap();
    let mut prefix = vec![0_u8; prefix_len];
    reader.read_exact(&mut prefix)?;
    Ok(has_trusted_record_run(&prefix))
}

fn has_trusted_record_run(source: &[u8]) -> bool {
    if source.len() < HEADER_SIZE + MIN_TRUSTED_RUN_LENGTH * RECORD_SIZE {
        return false;
    }

    let payload = &source[HEADER_SIZE..];
    if payload.len() % RECORD_SIZE != 0 {
        return false;
    }

    let mut previous = None;
    let mut run_start = None;
    let mut run_length = 0;

    for record in payload.chunks_exact(RECORD_SIZE) {
        let Ok(words) = read_words(record) else {
            previous = None;
            run_start = None;
            run_length = 0;
            continue;
        };
        let Some(timestamp) = decode_dos_datetime(words[2], words[3]) else {
            previous = None;
            run_start = None;
            run_length = 0;
            continue;
        };
        let interval = words[4];

        if !(2000..=2100).contains(&timestamp.year()) || !is_plausible_interval(interval) {
            previous = None;
            run_start = None;
            run_length = 0;
            continue;
        }

        let continues_run = previous.is_some_and(|(previous_timestamp, previous_interval)| {
            if previous_interval != interval || timestamp < previous_timestamp {
                return false;
            }
            let delta = (timestamp - previous_timestamp).num_seconds();
            (delta - i64::from(interval)).abs() <= 1
        });
        if continues_run {
            run_length += 1;
        } else {
            run_length = 1;
            run_start = Some(timestamp);
        }
        previous = Some((timestamp, interval));

        if run_length >= MIN_TRUSTED_RUN_LENGTH && run_start.is_some_and(|start| timestamp > start)
        {
            return true;
        }
    }

    false
}

fn read_words(record: &[u8]) -> Result<[u16; 9], AppError> {
    if record.len() != RECORD_SIZE {
        return Err(AppError::Parse(format!(
            "数据记录长度应为 {} 字节，实际为 {} 字节",
            RECORD_SIZE,
            record.len()
        )));
    }

    let mut words = [0_u16; 9];
    for (index, chunk) in record.chunks_exact(2).enumerate() {
        words[index] = u16::from_le_bytes([chunk[0], chunk[1]]);
    }
    Ok(words)
}

fn decode_dos_datetime(date_word: u16, time_word: u16) -> Option<NaiveDateTime> {
    let year = 1980 + i32::from(date_word >> 9);
    let month = u32::from((date_word >> 5) & 0x0f);
    let day = u32::from(date_word & 0x1f);
    let hour = u32::from((time_word >> 11) & 0x1f);
    let minute = u32::from((time_word >> 5) & 0x3f);
    let second = u32::from(time_word & 0x1f) * 2;

    NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, second)
}

fn signed_value(raw: u16) -> Option<i16> {
    if raw == 0xffff {
        return None;
    }
    Some(raw as i16)
}

fn measurement_tenths(raw: u16) -> Option<f64> {
    signed_value(raw).map(|value| f64::from(value) / 10.0)
}

fn setpoint_tenths(raw: u16) -> Option<f64> {
    if raw == 0xffff || raw == INVALID_SETPOINT_PLACEHOLDER {
        return None;
    }
    Some(f64::from(raw as i16) / 10.0)
}

fn build_dataset(
    path: &Path,
    rows: Vec<DataRow>,
    was_non_monotonic: bool,
) -> Result<Dataset, AppError> {
    let start = rows.first().unwrap().timestamp;
    let end = rows.last().unwrap().timestamp;
    let row_count = rows.len();
    let source = dataset_source(path)?;
    let has_missing_setpoint = rows
        .iter()
        .any(|row| row.set_temp.is_none() || row.set_humidity.is_none());
    let set_temp_rule = GUANGWUSUO_000_RULE.series_rule("set-temp")?;
    let actual_temp_rule = GUANGWUSUO_000_RULE.series_rule("actual-temp")?;
    let set_humidity_rule = GUANGWUSUO_000_RULE.series_rule("set-humidity")?;
    let actual_humidity_rule = GUANGWUSUO_000_RULE.series_rule("actual-humidity")?;
    let mut diagnostics = diagnostics(was_non_monotonic, has_missing_setpoint);
    for (rule, value) in [
        (
            actual_temp_rule,
            (|row: &DataRow| row.actual_temp) as fn(&DataRow) -> Option<f64>,
        ),
        (actual_humidity_rule, |row: &DataRow| row.actual_humidity),
    ] {
        if let Some(diagnostic) = invalid_measurement_diagnostic(rule, &rows, value) {
            diagnostics.push(diagnostic);
        }
    }
    let mut series = Vec::new();
    try_reserve_exact(&mut series, 4, "曲线集合")?;
    if let Some(item) = make_series(set_temp_rule, &rows, |row| row.set_temp)? {
        series.push(item);
    }
    if let Some(item) = make_series(actual_temp_rule, &rows, |row| row.actual_temp)? {
        series.push(item);
    }
    if let Some(item) = make_series(set_humidity_rule, &rows, |row| row.set_humidity)? {
        series.push(item);
    }
    if let Some(item) = make_series(actual_humidity_rule, &rows, |row| row.actual_humidity)? {
        series.push(item);
    }

    if series.is_empty() {
        return Err(AppError::NoDisplayableData(
            "未找到任何有效的温湿度数值".to_string(),
        ));
    }
    let start = format_timestamp(start)?;
    let end = format_timestamp(end)?;

    Ok(Dataset {
        source_id: source.source_id.clone(),
        source_file: source.source_file.clone(),
        sources: vec![source],
        parser: PARSER_ID.to_string(),
        controller_rule: GUANGWUSUO_000_RULE.id.to_string(),
        time_range: TimeRange { start, end },
        row_count,
        axes: GUANGWUSUO_000_RULE.axis_definitions(),
        series,
        diagnostics,
    })
}

fn make_series(
    rule: &SeriesRule,
    rows: &[DataRow],
    value: fn(&DataRow) -> Option<f64>,
) -> Result<Option<Series>, AppError> {
    let effective_value = |row: &DataRow| effective_reading(rule, value(row));
    if !rows.iter().any(|row| effective_value(row).is_some()) {
        return Ok(None);
    }

    let mut points = Vec::new();
    try_reserve_exact(&mut points, rows.len(), "曲线点")?;
    for row in rows {
        points.push(DataPoint(
            format_timestamp(row.timestamp)?,
            effective_value(row),
        ));
    }

    Ok(Some(Series {
        id: rule.id.to_string(),
        name: rule.name.to_string(),
        unit: rule.unit.to_string(),
        role: rule.role.to_string(),
        axis_id: rule.axis_id.to_string(),
        points,
    }))
}

fn diagnostics(was_non_monotonic: bool, has_missing_setpoint: bool) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    if has_missing_setpoint {
        diagnostics.push(Diagnostic::info("无效设定值已按缺失数据处理"));
    }

    if was_non_monotonic {
        diagnostics.push(Diagnostic::info("检测到环形缓存回绕，已按时间升序显示"));
    }

    diagnostics
}

fn invalid_measurement_diagnostic(
    rule: &SeriesRule,
    rows: &[DataRow],
    value: fn(&DataRow) -> Option<f64>,
) -> Option<Diagnostic> {
    let has_valid = rows
        .iter()
        .any(|row| effective_reading(rule, value(row)).is_some());
    if !has_valid {
        return None;
    }

    let invalid_count = rows
        .iter()
        .filter(|row| effective_reading(rule, value(row)).is_none())
        .count();
    (invalid_count > 0).then(|| {
        Diagnostic::invalid_measurement(format!(
            "{}有 {invalid_count} 个无效测量值，已按缺失数据处理",
            rule.name
        ))
    })
}

fn format_timestamp(value: NaiveDateTime) -> Result<String, AppError> {
    let mut formatted = empty_string_with_capacity(19, "时间戳")?;
    write!(&mut formatted, "{}", value.format("%Y-%m-%d %H:%M:%S"))
        .map_err(|_| AppError::Parse("无法格式化广五所 .000 时间戳".to_string()))?;
    Ok(formatted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, SeekFrom, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct TempArchive(PathBuf);

    struct CountingReader<R> {
        inner: R,
        bytes_read: usize,
        read_calls: usize,
    }

    impl<R> CountingReader<R> {
        fn new(inner: R) -> Self {
            Self {
                inner,
                bytes_read: 0,
                read_calls: 0,
            }
        }
    }

    impl<R: Read> Read for CountingReader<R> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.read_calls += 1;
            let count = self.inner.read(buffer)?;
            self.bytes_read += count;
            Ok(count)
        }
    }

    impl<R: Seek> Seek for CountingReader<R> {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(position)
        }
    }

    impl Drop for TempArchive {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join(name)
    }

    fn external_710_path() -> PathBuf {
        std::env::var_os("CHAMBER_710_000_FIXTURE")
            .map(PathBuf::from)
            .unwrap_or_else(|| fixture_path("710.000"))
    }

    fn decode_hex_fixture() -> Vec<u8> {
        include_str!("../../../tests/fixtures/guangwusuo-000-minimal.hex")
            .lines()
            .filter(|line| !line.trim_start().starts_with('#'))
            .flat_map(|line| line.split_whitespace())
            .map(|byte| u8::from_str_radix(byte, 16).unwrap())
            .collect()
    }

    fn write_archive(members: &[(&str, &[u8])], extension: &str) -> TempArchive {
        let sequence = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "chamber-data-viewer-{}-{sequence}.{extension}",
            std::process::id()
        ));
        let file = std::fs::File::create(&path).unwrap();
        let mut archive = tar::Builder::new(file);
        for (name, payload) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, *name, *payload).unwrap();
        }
        archive.finish().unwrap();
        TempArchive(path)
    }

    fn write_raw_archive(bytes: &[u8], extension: &str) -> TempArchive {
        let sequence = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "chamber-data-viewer-{}-{sequence}.{extension}",
            std::process::id()
        ));
        std::fs::write(&path, bytes).unwrap();
        TempArchive(path)
    }

    fn write_sparse_source_archive(source_size: u64, prefix: &[u8]) -> TempArchive {
        let sequence = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "chamber-data-viewer-{}-{sequence}.000",
            std::process::id()
        ));
        let mut header = tar::Header::new_gnu();
        header.set_path(SOURCE_MEMBER_PATH).unwrap();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(source_size);
        header.set_mode(0o644);
        header.set_cksum();
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(header.as_bytes()).unwrap();
        file.write_all(prefix).unwrap();
        let padded_source_size = source_size.checked_add(511).unwrap() / 512 * 512;
        file.set_len(512 + padded_source_size + 1_024).unwrap();
        TempArchive(path)
    }

    fn archive_bytes(member_name: &str, payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut bytes);
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive
                .append_data(&mut header, member_name, payload)
                .unwrap();
            archive.finish().unwrap();
        }
        bytes
    }

    fn raw_member_archive_bytes(
        member_name: &str,
        entry_type: tar::EntryType,
        declared_size: u64,
        physical_body: &[u8],
    ) -> Vec<u8> {
        let mut header = tar::Header::new_gnu();
        header.set_path(member_name).unwrap();
        header.set_entry_type(entry_type);
        header.set_size(declared_size);
        header.set_mode(0o644);
        header.set_cksum();
        let mut bytes = header.as_bytes().to_vec();
        bytes.extend_from_slice(physical_body);
        bytes
    }

    fn source_with_timeline(interval: u16, time_words: &[u16]) -> Vec<u8> {
        let mut source = vec![0_u8; HEADER_SIZE + time_words.len() * RECORD_SIZE];
        for (record, &time_word) in source[HEADER_SIZE..]
            .chunks_exact_mut(RECORD_SIZE)
            .zip(time_words)
        {
            let words = [0_u16, 0, 0x5c21, time_word, interval, 250, 245, 600, 590];
            for (target, word) in record.chunks_exact_mut(2).zip(words) {
                target.copy_from_slice(&word.to_le_bytes());
            }
        }
        source
    }

    #[test]
    fn repository_fixture_parses_without_external_files() {
        let payload = decode_hex_fixture();
        let fixture = write_archive(&[("tmp/usb/espec/SmpData.000", payload.as_slice())], "000");
        let dataset = parse_guangwusuo_000(&fixture.0).unwrap();

        assert_eq!(dataset.parser, "guangwusuo-000");
        assert_eq!(dataset.controller_rule, GUANGWUSUO_000_RULE.id);
        assert_eq!(dataset.sources.len(), 1);
        assert_eq!(dataset.sources[0].source_id, dataset.source_id);
        assert_eq!(dataset.sources[0].source_file, dataset.source_file);
        let json = serde_json::to_value(&dataset).unwrap();
        assert!(json.get("controllerVendor").is_none());
        assert!(json.get("controllerModel").is_none());
        assert!(json.get("chambers").is_none());
        assert!(json.get("vendorRule").is_none());
        assert_eq!(dataset.row_count, 3);
        assert_eq!(dataset.series[0].points[1].1, None);
        assert_eq!(json["series"][0]["points"][1][1], serde_json::Value::Null);
        assert_eq!(dataset.series[3].points[1].1, None);
        assert!(dataset
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message == "无效设定值已按缺失数据处理"));
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message == "实测湿度有 1 个无效测量值，已按缺失数据处理"
                && diagnostic.code == Some(crate::data::model::DiagnosticCode::InvalidMeasurement)
        }));
    }

    #[test]
    fn probe_requires_one_member_with_valid_record_geometry() {
        let payload = decode_hex_fixture();
        let valid = write_archive(&[("tmp/usb/espec/SmpData.000", payload.as_slice())], "dat");
        assert!(probe_guangwusuo_000(&valid.0).unwrap());

        let invalid_payload = vec![0_u8; HEADER_SIZE + RECORD_SIZE - 1];
        let invalid = write_archive(
            &[("tmp/usb/espec/SmpData.000", invalid_payload.as_slice())],
            "000",
        );
        assert!(!probe_guangwusuo_000(&invalid.0).unwrap());

        let duplicate = write_archive(
            &[
                ("tmp/usb/espec/SmpData.000", payload.as_slice()),
                ("TMP/USB/ESPEC/SMPDATA.000", payload.as_slice()),
            ],
            "000",
        );
        assert!(!probe_guangwusuo_000(&duplicate.0).unwrap());
    }

    #[test]
    fn probe_rejects_correct_geometry_without_a_plausible_record() {
        let payload = vec![0_u8; HEADER_SIZE + RECORD_SIZE];
        let fixture = write_archive(&[("tmp/usb/espec/SmpData.000", payload.as_slice())], "000");
        assert!(!probe_guangwusuo_000(&fixture.0).unwrap());
    }

    #[test]
    fn probe_rejects_a_matching_basename_outside_the_controller_export_path() {
        let payload = decode_hex_fixture();
        let fixture = write_archive(&[("other/SmpData.000", payload.as_slice())], "000");

        assert!(!probe_guangwusuo_000(&fixture.0).unwrap());
    }

    #[test]
    fn source_member_path_normalization_stays_relative_and_exact() {
        assert!(is_source_member(Path::new(
            ".\\TMP\\USB\\ESPEC\\SMPDATA.000"
        )));
        assert!(!is_source_member(Path::new("/tmp/usb/espec/SmpData.000")));
        assert!(!is_source_member(Path::new(
            "\\tmp\\usb\\espec\\SmpData.000"
        )));
        assert!(!is_source_member(Path::new(
            "tmp/usb/other/../espec/SmpData.000"
        )));
    }

    fn payload_with_only_one_plausible_record() -> Vec<u8> {
        let mut payload = vec![0_u8; HEADER_SIZE + 3 * RECORD_SIZE];
        let record = &mut payload[HEADER_SIZE..HEADER_SIZE + RECORD_SIZE];
        let words = [0_u16, 0, 0x5c21, 0, 60, 250, 245, 600, 590];
        for (target, word) in record.chunks_exact_mut(2).zip(words) {
            target.copy_from_slice(&word.to_le_bytes());
        }
        payload
    }

    #[test]
    fn probe_rejects_correct_geometry_with_only_one_plausible_record() {
        let payload = payload_with_only_one_plausible_record();
        let fixture = write_archive(&[("tmp/usb/espec/SmpData.000", payload.as_slice())], "000");

        assert!(!probe_guangwusuo_000(&fixture.0).unwrap());
    }

    #[test]
    fn probe_reads_only_the_fixed_record_prefix_from_a_large_source_member() {
        let fixture = decode_hex_fixture();
        let mut payload = vec![0_u8; HEADER_SIZE + 10_000 * RECORD_SIZE];
        payload[..fixture.len()].copy_from_slice(&fixture);
        let archive = archive_bytes(SOURCE_MEMBER_PATH, &payload);
        let mut reader = CountingReader::new(Cursor::new(archive));

        assert!(probe_archive(&mut reader).unwrap());
        assert!(
            reader.bytes_read <= PROBE_READ_LIMIT + 2 * 512,
            "probe read {} bytes, expected no more than the fixed prefix plus TAR headers",
            reader.bytes_read
        );
    }

    #[test]
    fn streaming_parser_buffers_record_reads() {
        let fixture = decode_hex_fixture();
        let mut source = vec![0_u8; HEADER_SIZE + 1_000 * RECORD_SIZE];
        source[..fixture.len()].copy_from_slice(&fixture);
        let mut reader = CountingReader::new(Cursor::new(source));

        let rows =
            read_source_rows(&mut reader, (HEADER_SIZE + 1_000 * RECORD_SIZE) as u64).unwrap();

        assert_eq!(rows.len(), 3);
        assert!(
            reader.read_calls < 100,
            "streaming parser made {} small reads",
            reader.read_calls
        );
    }

    #[test]
    fn probe_does_not_expand_declared_large_gnu_or_pax_extension_bodies() {
        for entry_type in [tar::EntryType::GNULongName, tar::EntryType::XHeader] {
            let physical_body = vec![b'x'; PROBE_READ_LIMIT + 4_096];
            let archive = raw_member_archive_bytes(
                "././@Extension",
                entry_type,
                32 * 1024 * 1024,
                &physical_body,
            );
            let mut reader = CountingReader::new(Cursor::new(archive));

            assert!(!probe_archive(&mut reader).unwrap_or(false));
            assert!(
                reader.bytes_read <= 512,
                "raw probe expanded {entry_type:?} and read {} bytes",
                reader.bytes_read
            );
        }
    }

    #[test]
    fn probe_and_parser_reject_a_non_regular_source_member() {
        let payload = decode_hex_fixture();
        let archive = raw_member_archive_bytes(
            SOURCE_MEMBER_PATH,
            tar::EntryType::Symlink,
            payload.len() as u64,
            &payload,
        );
        let fixture = write_raw_archive(&archive, "000");

        assert!(!probe_guangwusuo_000(&fixture.0).unwrap());
        assert!(matches!(
            parse_guangwusuo_000(&fixture.0),
            Err(AppError::UnsupportedFormat(_))
        ));
    }

    #[test]
    fn probe_and_parser_reject_a_truncated_source_after_a_trusted_prefix() {
        let fixture_source = decode_hex_fixture();
        let declared_size = HEADER_SIZE as u64 + 10_000 * RECORD_SIZE as u64;
        let mut physical_body = vec![0_u8; PROBE_READ_LIMIT];
        physical_body[..fixture_source.len()].copy_from_slice(&fixture_source);
        let archive = raw_member_archive_bytes(
            SOURCE_MEMBER_PATH,
            tar::EntryType::Regular,
            declared_size,
            &physical_body,
        );
        let fixture = write_raw_archive(&archive, "000");

        assert!(!probe_guangwusuo_000(&fixture.0).unwrap());
        assert!(matches!(
            parse_guangwusuo_000(&fixture.0),
            Err(AppError::UnsupportedFormat(_))
        ));
    }

    #[test]
    fn probe_and_parser_accept_a_complete_source_larger_than_sixteen_mib() {
        let source_size = HEADER_SIZE as u64 + 1_000_000 * RECORD_SIZE as u64;
        assert!(source_size > 16 * 1024 * 1024);
        let fixture_source = decode_hex_fixture();
        let mut prefix = vec![0_u8; PROBE_READ_LIMIT];
        prefix[..fixture_source.len()].copy_from_slice(&fixture_source);
        let fixture = write_sparse_source_archive(source_size, &prefix);
        let mut reader = CountingReader::new(std::fs::File::open(&fixture.0).unwrap());

        assert!(has_valid_source_geometry(source_size));
        assert!(probe_archive(&mut reader).unwrap());
        assert!(reader.bytes_read <= PROBE_READ_LIMIT + 2 * 512);
        let dataset = parse_guangwusuo_000(&fixture.0).unwrap();
        assert_eq!(dataset.row_count, 3);
    }

    #[test]
    fn trusted_run_accepts_one_second_samples_after_dos_quantization() {
        assert!(has_trusted_record_run(&source_with_timeline(1, &[0, 0, 1])));
        assert!(has_trusted_record_run(&source_with_timeline(1, &[0, 1, 1])));
    }

    #[test]
    fn trusted_run_requires_net_time_progress() {
        assert!(!has_trusted_record_run(&source_with_timeline(
            1,
            &[0, 0, 0]
        )));
    }

    #[test]
    fn trusted_run_accepts_fourteen_and_sixteen_second_dos_deltas() {
        assert!(has_trusted_record_run(&source_with_timeline(
            15,
            &[0, 7, 15]
        )));
    }

    #[test]
    fn trusted_run_recovers_after_a_ring_buffer_wrap_inside_the_probe_window() {
        assert!(has_trusted_record_run(&source_with_timeline(
            60,
            &[0x40, 0, 0x20, 0x40]
        )));
    }

    #[test]
    fn allocation_free_sort_preserves_source_order_for_equal_timestamps_after_wrap() {
        let early = NaiveDate::from_ymd_opt(2026, 7, 25)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        let late = NaiveDate::from_ymd_opt(2026, 7, 25)
            .unwrap()
            .and_hms_opt(10, 1, 0)
            .unwrap();
        let mut rows = vec![
            DataRow {
                timestamp: late,
                source_order: 0,
                set_temp: None,
                actual_temp: Some(30.0),
                set_humidity: None,
                actual_humidity: None,
            },
            DataRow {
                timestamp: early,
                source_order: 1,
                set_temp: None,
                actual_temp: Some(10.0),
                set_humidity: None,
                actual_humidity: None,
            },
            DataRow {
                timestamp: early,
                source_order: 2,
                set_temp: None,
                actual_temp: Some(20.0),
                set_humidity: None,
                actual_humidity: None,
            },
        ];

        sort_rows_for_display(&mut rows);

        assert_eq!(
            rows.iter().map(|row| row.timestamp).collect::<Vec<_>>(),
            vec![early, early, late]
        );
        assert_eq!(
            rows.iter().map(|row| row.actual_temp).collect::<Vec<_>>(),
            vec![Some(10.0), Some(20.0), Some(30.0)]
        );
        assert_eq!(
            rows.iter().map(|row| row.source_order).collect::<Vec<_>>(),
            vec![1, 2, 0]
        );
    }

    #[test]
    fn fallible_capacity_helpers_map_overflow_to_parse() {
        let mut rows = Vec::<DataRow>::new();
        let rows_error = try_reserve_additional(&mut rows, usize::MAX, "数据行").unwrap_err();
        assert!(matches!(
            rows_error,
            AppError::Parse(message) if message.contains("数据行") && message.contains("内存不足")
        ));

        let mut points = Vec::<crate::data::model::DataPoint>::new();
        let points_error = try_reserve_exact(&mut points, usize::MAX, "曲线点").unwrap_err();
        assert!(matches!(
            points_error,
            AppError::Parse(message) if message.contains("曲线点") && message.contains("内存不足")
        ));

        let timestamp_error = empty_string_with_capacity(usize::MAX, "时间戳").unwrap_err();
        assert!(matches!(
            timestamp_error,
            AppError::Parse(message) if message.contains("时间戳") && message.contains("内存不足")
        ));
    }

    #[test]
    fn binary_series_and_timestamp_formatting_are_fallible() {
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 25)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        assert_eq!(format_timestamp(timestamp).unwrap(), "2026-07-25 10:00:00");

        let rows = [DataRow {
            timestamp,
            source_order: 0,
            set_temp: Some(25.0),
            actual_temp: None,
            set_humidity: None,
            actual_humidity: None,
        }];
        let rule = GUANGWUSUO_000_RULE.series_rule("set-temp").unwrap();
        let result: Result<Option<Series>, AppError> = make_series(rule, &rows, |row| row.set_temp);
        let series = result.unwrap().unwrap();
        assert_eq!(series.points[0].0, "2026-07-25 10:00:00");
    }

    #[test]
    fn parser_rejects_correct_geometry_with_only_one_plausible_record() {
        let payload = payload_with_only_one_plausible_record();
        let fixture = write_archive(&[("tmp/usb/espec/SmpData.000", payload.as_slice())], "000");

        assert!(matches!(
            parse_guangwusuo_000(&fixture.0),
            Err(AppError::UnsupportedFormat(_))
        ));
    }

    #[test]
    #[ignore = "requires external 710 fixture"]
    fn external_710_time_range() {
        let fixture = external_710_path();
        assert!(probe_guangwusuo_000(&fixture).unwrap());
        let dataset = parse_guangwusuo_000(&fixture).unwrap();
        assert_eq!(dataset.parser, PARSER_ID);
        assert_eq!(dataset.row_count, 336_000);
        assert_eq!(dataset.time_range.start, "2026-05-04 02:09:18");
        assert_eq!(dataset.time_range.end, "2026-07-01 16:31:52");
        assert_eq!(dataset.controller_rule, GUANGWUSUO_000_RULE.id);
        assert_eq!(dataset.axes[0].name, "温度");
        assert_eq!(dataset.axes[1].name, "湿度");
        assert_eq!(dataset.series.len(), 4);
        assert_eq!(dataset.series[0].name, "设定温度");
        assert_eq!(dataset.series[1].name, "实测温度");
        assert_eq!(dataset.series[2].name, "设定湿度");
        assert_eq!(dataset.series[3].name, "实测湿度");
        assert_eq!(dataset.series[0].axis_id, "primary");
        assert_eq!(dataset.series[3].axis_id, "secondary");
    }

    #[test]
    fn preserves_missing_setpoints_without_fabricating_zero() {
        assert_eq!(setpoint_tenths(0xffff), None);
        assert_eq!(setpoint_tenths(INVALID_SETPOINT_PLACEHOLDER), None);
        assert_eq!(setpoint_tenths(0), Some(0.0));
    }

    #[test]
    fn omits_a_series_when_every_value_is_missing() {
        let fixture = write_archive(&[], "000");
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 25)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        let rows = vec![DataRow {
            timestamp,
            source_order: 0,
            set_temp: None,
            actual_temp: Some(25.0),
            set_humidity: Some(60.0),
            actual_humidity: Some(58.0),
        }];

        let dataset = build_dataset(&fixture.0, rows, false).unwrap();

        assert!(!dataset.series.iter().any(|series| series.id == "set-temp"));
        assert_eq!(dataset.series.len(), 3);
    }

    #[test]
    fn rejects_a_dataset_when_every_series_is_missing() {
        let fixture = write_archive(&[], "000");
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 25)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        let rows = vec![DataRow {
            timestamp,
            source_order: 0,
            set_temp: None,
            actual_temp: None,
            set_humidity: None,
            actual_humidity: None,
        }];

        let error = build_dataset(&fixture.0, rows, false).unwrap_err();

        assert!(matches!(
            error,
            AppError::NoDisplayableData(message) if message == "未找到任何有效的温湿度数值"
        ));
    }

    #[test]
    fn omits_missing_setpoint_diagnostic_when_setpoints_are_complete() {
        let fixture = write_archive(&[], "000");
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 25)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        let rows = vec![DataRow {
            timestamp,
            source_order: 0,
            set_temp: Some(25.0),
            actual_temp: Some(24.5),
            set_humidity: Some(60.0),
            actual_humidity: Some(59.0),
        }];

        let dataset = build_dataset(&fixture.0, rows, false).unwrap();

        assert!(dataset.diagnostics.is_empty());
    }
}
