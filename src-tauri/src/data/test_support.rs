use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

pub struct TempFile {
    pub path: PathBuf,
}

impl TempFile {
    pub fn new(extension: &str, bytes: Vec<u8>) -> Self {
        let sequence = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "chamber-data-viewer-{}-{sequence}.{extension}",
            std::process::id()
        ));
        std::fs::write(&path, bytes).unwrap();
        Self { path }
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub fn decode_sparse_hex(source: &str) -> Vec<u8> {
    let mut lines = source.lines().filter_map(|line| {
        let content = line
            .split_once('#')
            .map_or(line, |(before, _)| before)
            .trim();
        (!content.is_empty()).then_some(content)
    });

    let size_line = lines.next().expect("fixture 缺少 size 行");
    let mut size_parts = size_line.split_whitespace();
    assert_eq!(size_parts.next(), Some("size"), "fixture 首行必须是 size N");
    let size = size_parts
        .next()
        .expect("fixture 缺少 size 数值")
        .parse::<usize>()
        .expect("fixture size 必须是十进制整数");
    assert!(size_parts.next().is_none(), "fixture size 行包含多余字段");
    let mut bytes = vec![0_u8; size];

    for line in lines {
        let (offset, values) = line
            .split_once(':')
            .expect("fixture 数据行必须使用 HEXOFFSET: HEX BYTE...");
        let offset =
            usize::from_str_radix(offset.trim(), 16).expect("fixture offset 必须是十六进制");
        let values = values
            .split_whitespace()
            .map(|value| u8::from_str_radix(value, 16).expect("fixture byte 必须是十六进制"))
            .collect::<Vec<_>>();
        let end = offset
            .checked_add(values.len())
            .expect("fixture offset 与数据长度相加溢出");
        assert!(end <= bytes.len(), "fixture 数据越界");
        bytes[offset..end].copy_from_slice(&values);
    }

    bytes
}
