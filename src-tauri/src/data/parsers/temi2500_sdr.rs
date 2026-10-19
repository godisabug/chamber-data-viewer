use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::{Duration, NaiveDate, NaiveDateTime};

use crate::data::controller_rules::{FieldSourceRule, TEMI2500_SDR_RULE};
use crate::data::errors::AppError;
use crate::data::model::{dataset_source, Dataset, DatasetSource};

pub(crate) const PAGE_SIZE: usize = 512;
const PAGE_HEADER_SIZE: usize = 16;
const MAX_DATA_WORDS: usize = 248;
const CHANNEL_COUNT: usize = 4;
const MAGIC: [u8; 4] = [0x4d, 0x03, 0x10, 0x00];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChannelScale {
    pub raw_full_scale: u16,
    pub high_int: i16,
    pub low_int: i16,
    pub decimals: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TemiMetadata {
    pub period_millis: i64,
    pub scales: [ChannelScale; CHANNEL_COUNT],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TemiRow {
    pub timestamp: NaiveDateTime,
    pub raw: [u16; CHANNEL_COUNT],
}

#[derive(Debug, Clone)]
pub(crate) struct TemiSourceRows {
    pub source: DatasetSource,
    pub metadata: TemiMetadata,
    pub rows: Vec<TemiRow>,
    pub overrange_counts: [usize; CHANNEL_COUNT],
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TemiHeader {
    scales: [ChannelScale; CHANNEL_COUNT],
    physical_to_semantic: [usize; CHANNEL_COUNT],
}

#[derive(Debug)]
struct DataPage {
    number: u32,
    start: NaiveDateTime,
    period_millis: i64,
    raw_rows: Vec<[u16; CHANNEL_COUNT]>,
}

pub fn probe_temi2500_sdr(path: &Path) -> Result<bool, AppError> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < (PAGE_SIZE * 2) as u64 || file_len % PAGE_SIZE as u64 != 0 {
        return Ok(false);
    }

    let mut global_bytes = [0_u8; PAGE_SIZE];
    file.read_exact(&mut global_bytes)?;
    let header = match parse_global_page(&global_bytes) {
        Ok(header) => header,
        Err(_) => return Ok(false),
    };

    let mut first_bytes = [0_u8; PAGE_SIZE];
    file.read_exact(&mut first_bytes)?;
    let first = match parse_data_page(&first_bytes, &header) {
        Ok(page) if page.number == 1 => page,
        _ => return Ok(false),
    };
    let metadata = TemiMetadata {
        period_millis: first.period_millis,
        scales: header.scales,
    };

    if file_len == (PAGE_SIZE * 2) as u64 {
        return Ok(first.raw_rows.len() >= 2);
    }

    let mut second_bytes = [0_u8; PAGE_SIZE];
    file.read_exact(&mut second_bytes)?;
    let second = match parse_data_page(&second_bytes, &header) {
        Ok(page) => page,
        Err(_) => return Ok(false),
    };
    if second.number != 2 || second.period_millis != metadata.period_millis {
        return Ok(false);
    }

    let elapsed = first.period_millis * first.raw_rows.len() as i64;
    let expected = first.start + Duration::milliseconds(elapsed);
    Ok(second.start == expected)
}

pub(crate) fn parse_temi2500_sdr_rows(path: &Path) -> Result<TemiSourceRows, AppError> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let source = dataset_source(path)?;
    if file_len < PAGE_SIZE as u64 {
        return Err(AppError::Parse(format!(
            "文件 {}：TEMI2500 SDR 缺少完整的 {PAGE_SIZE} 字节全局页",
            source.source_file
        )));
    }
    if file_len == PAGE_SIZE as u64 {
        return Err(AppError::Parse(format!(
            "文件 {}：TEMI2500 SDR 至少需要 1 个全局页和 1 个数据页",
            source.source_file
        )));
    }
    if file_len % PAGE_SIZE as u64 != 0 {
        let incomplete_data_page = file_len / PAGE_SIZE as u64;
        return Err(data_page_error(
            &source.source_file,
            incomplete_data_page,
            format!("页长度不足 {PAGE_SIZE} 字节"),
        ));
    }

    let mut global_bytes = [0_u8; PAGE_SIZE];
    file.read_exact(&mut global_bytes).map_err(|error| {
        AppError::Io(format!(
            "文件 {} 的全局页读取失败：{error}",
            source.source_file
        ))
    })?;
    let header = parse_global_page(&global_bytes).map_err(|message| {
        AppError::Parse(format!(
            "文件 {} 的全局页无效：{message}",
            source.source_file
        ))
    })?;

    let data_page_count = file_len / PAGE_SIZE as u64 - 1;
    let mut metadata = None;
    let mut rows = Vec::new();
    let mut overrange_counts = [0_usize; CHANNEL_COUNT];
    let mut previous_page: Option<(NaiveDateTime, usize)> = None;

    for data_page_index in 0..data_page_count {
        let page_number = data_page_index + 1;
        let mut page_bytes = [0_u8; PAGE_SIZE];
        file.read_exact(&mut page_bytes).map_err(|error| {
            AppError::Io(format!(
                "文件 {} 的第 {page_number} 个数据页读取失败：{error}",
                source.source_file
            ))
        })?;
        let page = parse_data_page(&page_bytes, &header)
            .map_err(|message| data_page_error(&source.source_file, page_number, message))?;

        let expected_number = u32::try_from(page_number).map_err(|_| {
            data_page_error(
                &source.source_file,
                page_number,
                "数据页数量超过块编号可表示范围",
            )
        })?;
        if page.number != expected_number {
            return Err(data_page_error(
                &source.source_file,
                page_number,
                format!(
                    "块编号必须严格递增，期望 {expected_number}，实际 {}",
                    page.number
                ),
            ));
        }
        if page.raw_rows.is_empty() {
            return Err(data_page_error(
                &source.source_file,
                page_number,
                "数据页不能没有采样行",
            ));
        }

        match &metadata {
            None => {
                metadata = Some(TemiMetadata {
                    period_millis: page.period_millis,
                    scales: header.scales,
                });
            }
            Some(metadata) if page.period_millis != metadata.period_millis => {
                return Err(data_page_error(
                    &source.source_file,
                    page_number,
                    format!(
                        "采样周期必须保持为 {} 毫秒，实际为 {} 毫秒",
                        metadata.period_millis, page.period_millis
                    ),
                ));
            }
            Some(_) => {}
        }

        if let Some((previous_start, previous_sample_count)) = previous_page {
            let elapsed = page
                .period_millis
                .checked_mul(previous_sample_count as i64)
                .ok_or_else(|| {
                    data_page_error(&source.source_file, page_number, "页间时间跨度溢出")
                })?;
            let expected_start = previous_start
                .checked_add_signed(Duration::milliseconds(elapsed))
                .ok_or_else(|| {
                    data_page_error(&source.source_file, page_number, "页间起始时间溢出")
                })?;
            if page.start != expected_start {
                return Err(data_page_error(
                    &source.source_file,
                    page_number,
                    format!(
                        "起始时间必须为 {}，实际为 {}",
                        expected_start.format("%Y-%m-%d %H:%M:%S"),
                        page.start.format("%Y-%m-%d %H:%M:%S")
                    ),
                ));
            }
        }

        for (row_index, raw) in page.raw_rows.iter().copied().enumerate() {
            let elapsed = page
                .period_millis
                .checked_mul(row_index as i64)
                .ok_or_else(|| {
                    data_page_error(&source.source_file, page_number, "采样时间跨度溢出")
                })?;
            let timestamp = page
                .start
                .checked_add_signed(Duration::milliseconds(elapsed))
                .ok_or_else(|| data_page_error(&source.source_file, page_number, "采样时间溢出"))?;
            for semantic in 0..CHANNEL_COUNT {
                if raw[semantic] > header.scales[semantic].raw_full_scale {
                    overrange_counts[semantic] += 1;
                }
            }
            rows.push(TemiRow { timestamp, raw });
        }

        previous_page = Some((page.start, page.raw_rows.len()));
    }

    if rows.is_empty() {
        return Err(AppError::NoDisplayableData(format!(
            "{} 中没有 TEMI2500 采样行",
            source.source_file
        )));
    }
    let metadata = metadata.ok_or_else(|| {
        AppError::NoDisplayableData(format!("{} 中没有 TEMI2500 数据页", source.source_file))
    })?;

    Ok(TemiSourceRows {
        source,
        metadata,
        rows,
        overrange_counts,
    })
}

pub fn parse_temi2500_sdr(path: &Path) -> Result<Dataset, AppError> {
    let source = parse_temi2500_sdr_rows(path)?;
    crate::data::temi_merge::merge_temi_sources(vec![source])
}

pub(crate) fn engineering_value(raw: u16, scale: ChannelScale) -> Option<f64> {
    if raw > scale.raw_full_scale {
        return None;
    }

    let decimal_factor = 10_f64.powi(i32::from(scale.decimals));
    let low = f64::from(scale.low_int) / decimal_factor;
    let high = f64::from(scale.high_int) / decimal_factor;
    let ratio = f64::from(raw) / f64::from(scale.raw_full_scale);
    let rounded = ((low + ratio * (high - low)) * decimal_factor).round() / decimal_factor;

    Some(if rounded == 0.0 { 0.0 } else { rounded })
}

fn data_page_error(
    source_file: &str,
    page_number: u64,
    message: impl std::fmt::Display,
) -> AppError {
    AppError::Parse(format!(
        "文件 {source_file} 的第 {page_number} 个数据页：{message}"
    ))
}

fn parse_global_page(bytes: &[u8]) -> Result<TemiHeader, String> {
    if bytes.len() != PAGE_SIZE {
        return Err(format!("TEMI2500 全局页长度必须为 {PAGE_SIZE} 字节"));
    }
    if bytes.get(..MAGIC.len()) != Some(MAGIC.as_slice()) {
        return Err("TEMI2500 全局页 magic 不匹配".to_string());
    }
    if le_u32(bytes, 0x20)? != CHANNEL_COUNT as u32 {
        return Err("TEMI2500 全局页通道数必须为 4".to_string());
    }

    let physical_scales = [
        parse_channel_scale(bytes, 0)?,
        parse_channel_scale(bytes, 1)?,
        parse_channel_scale(bytes, 2)?,
        parse_channel_scale(bytes, 3)?,
    ];

    if TEMI2500_SDR_RULE.series.len() != CHANNEL_COUNT {
        return Err("TEMI2500 控制器规则必须声明 4 个语义角色".to_string());
    }
    let mut physical_to_semantic = [0_usize; CHANNEL_COUNT];
    let mut seen_semantic = [false; CHANNEL_COUNT];
    for (physical, semantic_slot) in physical_to_semantic.iter_mut().enumerate() {
        let label_offset = 0x104 + physical * 8;
        let label_bytes = bytes
            .get(label_offset..label_offset + 8)
            .ok_or_else(|| format!("TEMI2500 标签读取越界：offset 0x{label_offset:x}"))?;
        let label_end = label_bytes
            .iter()
            .rposition(|byte| *byte != 0 && !byte.is_ascii_whitespace())
            .map_or(0, |index| index + 1);
        let label = std::str::from_utf8(&label_bytes[..label_end])
            .map_err(|_| format!("TEMI2500 标签 {physical} 不是 ASCII 文本"))?;

        let semantic = TEMI2500_SDR_RULE
            .series
            .iter()
            .enumerate()
            .find_map(|(semantic, series)| match series.source {
                FieldSourceRule::HeaderAliases(aliases) if aliases.contains(&label) => {
                    Some(semantic)
                }
                _ => None,
            })
            .ok_or_else(|| format!("TEMI2500 标签不匹配控制器规则：{label:?}"))?;
        if seen_semantic[semantic] {
            return Err(format!("TEMI2500 标签重复映射语义角色：{label:?}"));
        }
        seen_semantic[semantic] = true;
        *semantic_slot = semantic;
    }
    if seen_semantic.iter().any(|seen| !seen) {
        return Err("TEMI2500 标签未完整覆盖 4 个语义角色".to_string());
    }
    let scale_for_semantic = |semantic| -> Result<ChannelScale, String> {
        let physical = physical_to_semantic
            .iter()
            .position(|mapped| *mapped == semantic)
            .ok_or_else(|| format!("TEMI2500 语义通道 {semantic} 缺少物理量程"))?;
        Ok(physical_scales[physical])
    };
    let scales = [
        scale_for_semantic(0)?,
        scale_for_semantic(1)?,
        scale_for_semantic(2)?,
        scale_for_semantic(3)?,
    ];

    Ok(TemiHeader {
        scales,
        physical_to_semantic,
    })
}

fn parse_channel_scale(bytes: &[u8], channel: usize) -> Result<ChannelScale, String> {
    let word_offset = channel * 2;
    let scale = ChannelScale {
        raw_full_scale: le_u16(bytes, 0x24 + word_offset)?,
        high_int: le_i16(bytes, 0x84 + word_offset)?,
        low_int: le_i16(bytes, 0xa4 + word_offset)?,
        decimals: le_u16(bytes, 0xc4 + word_offset)?,
    };
    if scale.raw_full_scale == 0 {
        return Err(format!("TEMI2500 通道 {channel} 满量程原始值不能为 0"));
    }
    if scale.high_int <= scale.low_int {
        return Err(format!("TEMI2500 通道 {channel} 高量程必须大于低量程"));
    }
    if scale.decimals > 6 {
        return Err(format!("TEMI2500 通道 {channel} 小数位数不能超过 6"));
    }
    Ok(scale)
}

fn parse_data_page(bytes: &[u8], header: &TemiHeader) -> Result<DataPage, String> {
    if bytes.len() != PAGE_SIZE {
        return Err(format!("TEMI2500 数据页长度必须为 {PAGE_SIZE} 字节"));
    }
    if le_u16(bytes, 0)? != 0x0044 {
        return Err("TEMI2500 数据页 marker 不匹配".to_string());
    }

    let year = bytes[2];
    if year > 100 {
        return Err(format!("TEMI2500 数据页年份无效：{year}"));
    }
    let start = NaiveDate::from_ymd_opt(
        2000 + i32::from(year),
        u32::from(bytes[3]),
        u32::from(bytes[4]),
    )
    .and_then(|date| {
        date.and_hms_opt(
            u32::from(bytes[5]),
            u32::from(bytes[6]),
            u32::from(bytes[7]),
        )
    })
    .ok_or_else(|| "TEMI2500 数据页日期时间无效".to_string())?;

    let period_half_seconds = le_u16(bytes, 8)?;
    if period_half_seconds == 0 {
        return Err("TEMI2500 数据页采样周期不能为 0".to_string());
    }
    let period_millis = i64::from(period_half_seconds) * 500;
    let number = le_u32(bytes, 10)?;
    let valid_words = usize::from(le_u16(bytes, 14)?);
    if !(1..=MAX_DATA_WORDS).contains(&valid_words) {
        return Err(format!(
            "TEMI2500 数据页有效字数必须在 1..={MAX_DATA_WORDS}"
        ));
    }
    if valid_words % CHANNEL_COUNT != 0 {
        return Err("TEMI2500 数据页有效字数必须能被 4 整除".to_string());
    }

    let payload_len = valid_words
        .checked_mul(2)
        .ok_or_else(|| "TEMI2500 数据页 payload 长度溢出".to_string())?;
    let payload_end = PAGE_HEADER_SIZE
        .checked_add(payload_len)
        .ok_or_else(|| "TEMI2500 数据页 payload 边界溢出".to_string())?;
    let trailing = bytes
        .get(payload_end..)
        .ok_or_else(|| "TEMI2500 数据页 payload 越界".to_string())?;
    if trailing.iter().any(|byte| *byte != 0) {
        return Err("TEMI2500 数据页 payload 后存在非零字节".to_string());
    }

    let mut raw_rows = Vec::with_capacity(valid_words / CHANNEL_COUNT);
    for row in 0..valid_words / CHANNEL_COUNT {
        let mut semantic_row = [0_u16; CHANNEL_COUNT];
        for physical in 0..CHANNEL_COUNT {
            let word = row * CHANNEL_COUNT + physical;
            let offset = PAGE_HEADER_SIZE + word * 2;
            semantic_row[header.physical_to_semantic[physical]] = le_u16(bytes, offset)?;
        }
        raw_rows.push(semantic_row);
    }

    Ok(DataPage {
        number,
        start,
        period_millis,
        raw_rows,
    })
}

fn le_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| format!("读取 u16 边界溢出：offset 0x{offset:x}"))?;
    let raw = bytes
        .get(offset..end)
        .ok_or_else(|| format!("读取 u16 越界：offset 0x{offset:x}"))?;
    Ok(u16::from_le_bytes([raw[0], raw[1]]))
}

fn le_i16(bytes: &[u8], offset: usize) -> Result<i16, String> {
    Ok(le_u16(bytes, offset)? as i16)
}

fn le_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| format!("读取 u32 边界溢出：offset 0x{offset:x}"))?;
    let raw = bytes
        .get(offset..end)
        .ok_or_else(|| format!("读取 u32 越界：offset 0x{offset:x}"))?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    use crate::data::controller_rules::TEMI2500_SDR_RULE;
    use crate::data::temi_merge::merge_temi_sources;
    use crate::data::test_support::decode_sparse_hex;

    use super::{
        parse_data_page, parse_global_page, parse_temi2500_sdr, parse_temi2500_sdr_rows,
        probe_temi2500_sdr, ChannelScale, PAGE_SIZE,
    };
    use crate::data::errors::AppError;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempSdr {
        path: PathBuf,
    }

    impl TempSdr {
        fn new(extension: &str, bytes: &[u8]) -> Self {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "chamber-data-viewer-temi2500-{}-{id}.{extension}",
                std::process::id()
            ));
            fs::write(&path, bytes).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempSdr {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    fn fixture_bytes() -> Vec<u8> {
        decode_sparse_hex(include_str!(
            "../../../tests/fixtures/temi2500-sdr-minimal.hex"
        ))
    }

    fn external_temi_root() -> PathBuf {
        let root = std::env::var_os("CHAMBER_TEMI2500_ROOT").expect(
            "请设置 CHAMBER_TEMI2500_ROOT 指向真实 TEMI2500 样本根目录后再运行此 ignored 测试",
        );
        let root = PathBuf::from(root);
        assert!(
            root.is_dir(),
            "CHAMBER_TEMI2500_ROOT 不是目录：{}",
            root.display()
        );
        root
    }

    fn external_temi_paths() -> Vec<PathBuf> {
        let root = external_temi_root();
        let mut paths = Vec::new();
        for date_entry in fs::read_dir(&root).expect("无法读取 TEMI2500 样本根目录") {
            let date_entry = date_entry.expect("无法读取 TEMI2500 样本根目录项");
            if !date_entry
                .file_type()
                .expect("无法读取 TEMI2500 日期目录类型")
                .is_dir()
            {
                continue;
            }
            for file_entry in fs::read_dir(date_entry.path()).expect("无法读取 TEMI2500 日期目录")
            {
                let file_entry = file_entry.expect("无法读取 TEMI2500 样本文件目录项");
                let path = file_entry.path();
                if file_entry
                    .file_type()
                    .expect("无法读取 TEMI2500 样本文件类型")
                    .is_file()
                    && path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("sdr"))
                {
                    paths.push(path);
                }
            }
        }
        paths.sort();
        assert_eq!(
            paths.len(),
            11,
            "真实 TEMI2500 样本必须恰好包含 11 个 SDR 文件"
        );
        paths
    }

    #[test]
    #[ignore = "requires CHAMBER_TEMI2500_ROOT with the private TEMI2500 production samples"]
    fn external_temi_all_production_samples_parse_and_merge() {
        let paths = external_temi_paths();
        let actual_humidity_semantic = TEMI2500_SDR_RULE
            .series
            .iter()
            .position(|rule| rule.id == "actual-humidity")
            .expect("TEMI2500 rule must define actual-humidity");
        assert_eq!(actual_humidity_semantic, 3);

        let started = Instant::now();
        let mut individually_parsed_rows = 0_usize;
        let mut raw_source_rows = 0_usize;
        let mut actual_humidity_overrange = 0_usize;
        let mut sources = Vec::with_capacity(paths.len());
        for path in &paths {
            individually_parsed_rows += parse_temi2500_sdr(path).unwrap().row_count;
            let source = parse_temi2500_sdr_rows(path).unwrap();
            raw_source_rows += source.rows.len();
            actual_humidity_overrange += source.overrange_counts[actual_humidity_semantic];
            sources.push(source);
        }
        let merged = merge_temi_sources(sources).unwrap();
        let elapsed = started.elapsed();
        eprintln!(
            "external TEMI2500 aggregate: files={}, rows={}, actual_humidity_overrange={}, elapsed={elapsed:?}",
            paths.len(),
            raw_source_rows,
            actual_humidity_overrange
        );

        assert_eq!(paths.len(), 11);
        assert_eq!(individually_parsed_rows, 159_453);
        assert_eq!(raw_source_rows, 159_453);
        assert_eq!(actual_humidity_overrange, 3_863);
        assert_eq!(merged.row_count, raw_source_rows);
        assert_eq!(merged.sources.len(), 11);
        assert_eq!(merged.time_range.start, "2026-06-15 14:04:39");
        assert_eq!(merged.time_range.end, "2026-07-09 14:25:59");
        assert!(merged.diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains("检测到 10 个停录间断")
                && diagnostic.message.contains("缺少 48,036 个采样点")
        }));
    }

    #[test]
    fn parses_interleaved_channels_times_scaling_and_missing_values() {
        let fixture = TempSdr::new("sdr", &fixture_bytes());

        let dataset = parse_temi2500_sdr(fixture.path()).unwrap();

        assert_eq!(dataset.parser, "samwontech-temi2500-sdr");
        assert_eq!(dataset.controller_rule, "samwontech-temi2500-sdr-v1");
        assert_eq!(dataset.sources.len(), 1);
        assert_eq!(dataset.row_count, 6);
        assert_eq!(dataset.time_range.start, "2026-06-15 14:04:39");
        assert_eq!(dataset.time_range.end, "2026-06-15 14:05:29");

        let values = |series_id: &str| {
            dataset
                .series
                .iter()
                .find(|series| series.id == series_id)
                .unwrap()
                .points
                .iter()
                .map(|point| point.1)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            values("set-temp"),
            [
                Some(160.0),
                Some(42.5),
                Some(-75.0),
                Some(19.0),
                Some(-28.0),
                Some(-4.5),
            ]
        );
        assert_eq!(
            values("actual-temp"),
            [
                Some(-75.0),
                Some(42.5),
                Some(160.0),
                Some(19.0),
                Some(-28.0),
                Some(-4.5),
            ]
        );
        assert_eq!(
            values("set-humidity"),
            [Some(100.0), None, Some(50.0), Some(40.0), Some(20.0), None,]
        );
        assert_eq!(
            values("actual-humidity"),
            [None, None, None, None, Some(50.0), None]
        );
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message == "实测湿度有 5 个无效测量值（涉及 1 个文件），已按缺失数据处理"
                && diagnostic.code == Some(crate::data::model::DiagnosticCode::InvalidMeasurement)
        }));
    }

    #[test]
    fn complete_parser_rejects_corruption_after_the_probe_window() {
        let mut bytes = fixture_bytes();
        bytes.extend_from_slice(&[0_u8; PAGE_SIZE]);
        bytes[PAGE_SIZE * 3] = 0x44;
        let fixture = TempSdr::new("sdr", &bytes);

        assert!(probe_temi2500_sdr(fixture.path()).unwrap());
        assert!(matches!(
            parse_temi2500_sdr(fixture.path()),
            Err(AppError::Parse(message)) if message.contains("第 3 个数据页")
        ));
    }

    #[test]
    fn complete_parser_reports_the_first_truncated_data_page() {
        let mut bytes = fixture_bytes();
        bytes.extend_from_slice(&[0_u8; 32]);
        let fixture = TempSdr::new("sdr", &bytes);
        let source_file = fixture.path().file_name().unwrap().to_str().unwrap();

        assert!(matches!(
            parse_temi2500_sdr(fixture.path()),
            Err(AppError::Parse(message))
                if message.contains(source_file) && message.contains("第 3 个数据页")
        ));
    }

    #[test]
    fn complete_parser_reports_a_truncated_first_data_page() {
        let bytes = fixture_bytes();
        let fixture = TempSdr::new("sdr", &bytes[..PAGE_SIZE + 32]);
        let source_file = fixture.path().file_name().unwrap().to_str().unwrap();

        assert!(matches!(
            parse_temi2500_sdr(fixture.path()),
            Err(AppError::Parse(message))
                if message.contains(source_file) && message.contains("第 1 个数据页")
        ));
    }

    #[test]
    fn global_scales_follow_semantic_channel_order() {
        let mut bytes = fixture_bytes();
        let temperature_pv: [u8; 8] = bytes[0x104..0x10c].try_into().unwrap();
        let humidity_pv: [u8; 8] = bytes[0x114..0x11c].try_into().unwrap();
        bytes[0x104..0x10c].copy_from_slice(&humidity_pv);
        bytes[0x114..0x11c].copy_from_slice(&temperature_pv);

        let physical_scales = [
            ChannelScale {
                raw_full_scale: 1001,
                high_int: 101,
                low_int: -101,
                decimals: 0,
            },
            ChannelScale {
                raw_full_scale: 2002,
                high_int: 202,
                low_int: -202,
                decimals: 1,
            },
            ChannelScale {
                raw_full_scale: 3003,
                high_int: 303,
                low_int: -303,
                decimals: 2,
            },
            ChannelScale {
                raw_full_scale: 4004,
                high_int: 404,
                low_int: -404,
                decimals: 3,
            },
        ];
        for (physical, scale) in physical_scales.iter().enumerate() {
            let word_offset = physical * 2;
            bytes[0x24 + word_offset..0x26 + word_offset]
                .copy_from_slice(&scale.raw_full_scale.to_le_bytes());
            bytes[0x84 + word_offset..0x86 + word_offset]
                .copy_from_slice(&scale.high_int.to_le_bytes());
            bytes[0xa4 + word_offset..0xa6 + word_offset]
                .copy_from_slice(&scale.low_int.to_le_bytes());
            bytes[0xc4 + word_offset..0xc6 + word_offset]
                .copy_from_slice(&scale.decimals.to_le_bytes());
        }

        for (physical, raw) in [101_u16, 202, 303, 404].iter().enumerate() {
            let offset = PAGE_SIZE + 16 + physical * 2;
            bytes[offset..offset + 2].copy_from_slice(&raw.to_le_bytes());
        }

        let header = parse_global_page(&bytes[..PAGE_SIZE]).unwrap();
        assert_eq!(header.physical_to_semantic, [3, 0, 1, 2]);
        let page = parse_data_page(&bytes[PAGE_SIZE..PAGE_SIZE * 2], &header).unwrap();
        assert_eq!(page.raw_rows[0], [202, 303, 404, 101]);
        assert_eq!(
            header.scales,
            [
                physical_scales[1],
                physical_scales[2],
                physical_scales[3],
                physical_scales[0],
            ]
        );
        let aligned_pairs = header
            .scales
            .iter()
            .zip(page.raw_rows[0])
            .map(|(scale, raw)| (scale.raw_full_scale, raw))
            .collect::<Vec<_>>();
        assert_eq!(
            aligned_pairs,
            [(2002, 202), (3003, 303), (4004, 404), (1001, 101)]
        );
    }

    #[test]
    fn probe_recognizes_sdr_content_with_an_unrelated_extension() {
        let fixture = TempSdr::new("dat", &fixture_bytes());
        assert!(probe_temi2500_sdr(fixture.path()).unwrap());
    }

    #[test]
    fn probe_rejects_random_bytes_with_an_sdr_extension() {
        let fixture = TempSdr::new("SDR", &vec![0x53; PAGE_SIZE * 2]);
        assert!(!probe_temi2500_sdr(fixture.path()).unwrap());
    }

    #[test]
    fn probe_rejects_invalid_global_and_page_structure() {
        let mutations = [
            (0x000, 0x00),
            (0x020, 0x03),
            (0x104, b'X'),
            (0x085, 0xe0),
            (0x0c4, 0x20),
            (0x200, 0x00),
            (0x208, 0x00),
            (0x20a, 0x03),
            (0x20e, 0xfa),
            (0x22f, 0x01),
            (0x40a, 0x03),
            (0x407, 0x08),
        ];

        for (offset, value) in mutations {
            let mut bytes = fixture_bytes();
            bytes[offset] = value;
            let fixture = TempSdr::new("sdr", &bytes);
            assert!(
                !probe_temi2500_sdr(fixture.path()).unwrap(),
                "offset 0x{offset:03x} 应被拒绝"
            );
        }
    }

    #[test]
    fn probe_rejects_non_page_aligned_and_single_sample_files() {
        let mut unaligned = fixture_bytes();
        unaligned.pop();
        let fixture = TempSdr::new("sdr", &unaligned);
        assert!(!probe_temi2500_sdr(fixture.path()).unwrap());

        let mut single_sample = fixture_bytes();
        single_sample.truncate(PAGE_SIZE * 2);
        single_sample[0x20e..0x210].copy_from_slice(&4_u16.to_le_bytes());
        single_sample[0x218..0x400].fill(0);
        let fixture = TempSdr::new("sdr", &single_sample);
        assert!(!probe_temi2500_sdr(fixture.path()).unwrap());
    }

    #[test]
    fn probe_rejects_duplicate_roles_and_non_divisible_word_counts() {
        let mut duplicate_role = fixture_bytes();
        duplicate_role.copy_within(0x104..0x10c, 0x10c);
        let fixture = TempSdr::new("sdr", &duplicate_role);
        assert!(!probe_temi2500_sdr(fixture.path()).unwrap());

        let mut non_divisible = fixture_bytes();
        non_divisible[0x20e..0x210].copy_from_slice(&10_u16.to_le_bytes());
        let fixture = TempSdr::new("sdr", &non_divisible);
        assert!(!probe_temi2500_sdr(fixture.path()).unwrap());
    }
}
