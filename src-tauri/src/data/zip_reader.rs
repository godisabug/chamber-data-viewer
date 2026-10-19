use std::io::Read;

use crate::data::errors::AppError;

const EOCD_SIGNATURE: &[u8] = b"PK\x05\x06";
const CENTRAL_DIR_SIGNATURE: &[u8] = b"PK\x01\x02";
const LOCAL_HEADER_SIGNATURE: &[u8] = b"PK\x03\x04";
const EOCD_MIN_SIZE: usize = 22;
const MAX_EOCD_SCAN: usize = 65_557;
/// 防御性上限：单个 zip 成员解压后不允许超过 512 MiB。
const MAX_MEMBER_BYTES: u64 = 512 * 1024 * 1024;

/// 弗锐德导出的 ZIP 成员（`.HSHBKA` 与 MData zip 都只包含小体积文本）。
/// 仅支持经典 ZIP（无 zip64）：中央目录条目数 < 65,535 且成员尺寸 < 4 GiB。
#[derive(Debug, Clone, PartialEq)]
pub struct ZipEntry {
    pub name: String,
    method: u16,
    compressed_size: u64,
    pub uncompressed_size: u64,
    local_offset: u64,
    crc32: u32,
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("u16 越界"))
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("u32 越界"))
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u32_at(bytes, offset) as u64
}

fn find_eocd(bytes: &[u8]) -> Result<usize, AppError> {
    let scan_start = bytes.len().saturating_sub(MAX_EOCD_SCAN);
    let mut found = None;
    let mut index = bytes.len().saturating_sub(EOCD_MIN_SIZE);
    while index >= scan_start {
        if bytes[index..index + 4] == *EOCD_SIGNATURE {
            found = Some(index);
            break;
        }
        if index == scan_start {
            break;
        }
        index -= 1;
    }
    let offset = found.ok_or_else(|| {
        AppError::Parse("文件不是有效的 ZIP 归档（找不到中央目录结束标记）".to_string())
    })?;
    let disk = u16_at(bytes, offset + 4);
    let cd_disk = u16_at(bytes, offset + 6);
    if disk != 0 || cd_disk != 0 {
        return Err(AppError::Parse(
            "暂不支持分卷 ZIP 归档".to_string(),
        ));
    }
    Ok(offset)
}

pub fn read_entries(bytes: &[u8]) -> Result<Vec<ZipEntry>, AppError> {
    let eocd = find_eocd(bytes)?;
    let entry_count = u16_at(bytes, eocd + 10) as usize;
    let cd_size = u64_at(bytes, eocd + 12);
    let cd_offset = u64_at(bytes, eocd + 16);
    let cd_end = cd_offset
        .checked_add(cd_size)
        .filter(|end| *end <= bytes.len() as u64)
        .ok_or_else(|| AppError::Parse("ZIP 中央目录越界".to_string()))?;

    let mut entries = Vec::with_capacity(entry_count);
    let mut position = cd_offset as usize;
    for _ in 0..entry_count {
        if position + 46 > cd_end as usize || bytes[position..position + 4] != *CENTRAL_DIR_SIGNATURE {
            return Err(AppError::Parse(
                "ZIP 中央目录结构无效".to_string(),
            ));
        }
        let method = u16_at(bytes, position + 10);
        let crc32 = u32_at(bytes, position + 16);
        let compressed_size = u64_at(bytes, position + 20);
        let uncompressed_size = u64_at(bytes, position + 24);
        let name_len = u16_at(bytes, position + 28) as usize;
        let extra_len = u16_at(bytes, position + 30) as usize;
        let comment_len = u16_at(bytes, position + 32) as usize;
        let local_offset = u64_at(bytes, position + 42);
        let name_bytes = bytes
            .get(position + 46..position + 46 + name_len)
            .ok_or_else(|| AppError::Parse("ZIP 成员名越界".to_string()))?;
        let name = String::from_utf8_lossy(name_bytes).replace('\\', "/");
        entries.push(ZipEntry {
            name,
            method,
            compressed_size,
            uncompressed_size,
            local_offset,
            crc32,
        });
        position += 46 + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

pub fn extract_member(bytes: &[u8], member_name: &str) -> Result<Vec<u8>, AppError> {
    let entries = read_entries(bytes)?;
    let normalized = member_name.replace('\\', "/");
    let entry = entries
        .iter()
        .find(|entry| entry.name.eq_ignore_ascii_case(&normalized))
        .ok_or_else(|| {
            AppError::Parse(format!("ZIP 中找不到成员 {member_name:?}"))
        })?;
    extract(bytes, entry)
}

/// 只读取成员前 `limit` 字节用于内容探测（不校验 CRC 与完整尺寸）。
pub fn read_member_head(
    bytes: &[u8],
    member_name: &str,
    limit: usize,
) -> Result<Vec<u8>, AppError> {
    let entries = read_entries(bytes)?;
    let normalized = member_name.replace('\\', "/");
    let entry = entries
        .iter()
        .find(|entry| entry.name.eq_ignore_ascii_case(&normalized))
        .ok_or_else(|| AppError::Parse(format!("ZIP 中找不到成员 {member_name:?}")))?;
    let local_offset = entry.local_offset as usize;
    if local_offset + 30 > bytes.len()
        || bytes[local_offset..local_offset + 4] != *LOCAL_HEADER_SIGNATURE
    {
        return Err(AppError::Parse(format!(
            "ZIP 成员 {} 的本地头无效",
            entry.name
        )));
    }
    let name_len = u16_at(bytes, local_offset + 26) as usize;
    let extra_len = u16_at(bytes, local_offset + 28) as usize;
    let data_start = local_offset
        .checked_add(30 + name_len + extra_len)
        .ok_or_else(|| AppError::Parse("ZIP 成员数据偏移溢出".to_string()))?;
    let compressed = bytes
        .get(data_start..data_start + entry.compressed_size as usize)
        .ok_or_else(|| AppError::Parse(format!("ZIP 成员 {} 数据越界", entry.name)))?;

    let mut output = Vec::with_capacity(limit.min(entry.uncompressed_size as usize));
    match entry.method {
        0 => output.extend_from_slice(&compressed[..compressed.len().min(limit)]),
        8 => {
            flate2::read::DeflateDecoder::new(compressed)
                .take(limit as u64)
                .read_to_end(&mut output)
                .map_err(|error| {
                    AppError::Parse(format!("ZIP 成员 {} 解压失败：{error}", entry.name))
                })?;
        }
        method => {
            return Err(AppError::Parse(format!(
                "ZIP 成员 {} 使用不支持的压缩方式 {method}",
                entry.name
            )));
        }
    }
    Ok(output)
}

pub fn has_member(bytes: &[u8], member_name: &str) -> bool {
    let Ok(entries) = read_entries(bytes) else {
        return false;
    };
    let normalized = member_name.replace('\\', "/");
    entries
        .iter()
        .any(|entry| entry.name.eq_ignore_ascii_case(&normalized))
}

pub fn extract(bytes: &[u8], entry: &ZipEntry) -> Result<Vec<u8>, AppError> {
    if entry.uncompressed_size > MAX_MEMBER_BYTES {
        return Err(AppError::Parse(format!(
            "ZIP 成员 {} 解压后过大（{} 字节）",
            entry.name, entry.uncompressed_size
        )));
    }
    let local_offset = entry.local_offset as usize;
    if local_offset + 30 > bytes.len()
        || bytes[local_offset..local_offset + 4] != *LOCAL_HEADER_SIGNATURE
    {
        return Err(AppError::Parse(format!(
            "ZIP 成员 {} 的本地头无效",
            entry.name
        )));
    }
    let name_len = u16_at(bytes, local_offset + 26) as usize;
    let extra_len = u16_at(bytes, local_offset + 28) as usize;
    let data_start = local_offset
        .checked_add(30 + name_len + extra_len)
        .ok_or_else(|| AppError::Parse("ZIP 成员数据偏移溢出".to_string()))?;
    let compressed_end = data_start
        .checked_add(entry.compressed_size as usize)
        .ok_or_else(|| AppError::Parse("ZIP 成员尺寸溢出".to_string()))?;
    let compressed = bytes
        .get(data_start..compressed_end)
        .ok_or_else(|| AppError::Parse(format!("ZIP 成员 {} 数据越界", entry.name)))?;

    let uncompressed = match entry.method {
        0 => compressed.to_vec(),
        8 => {
            let mut output = Vec::with_capacity(entry.uncompressed_size as usize);
            flate2::read::DeflateDecoder::new(compressed)
                .read_to_end(&mut output)
                .map_err(|error| {
                    AppError::Parse(format!("ZIP 成员 {} 解压失败：{error}", entry.name))
                })?;
            output
        }
        method => {
            return Err(AppError::Parse(format!(
                "ZIP 成员 {} 使用不支持的压缩方式 {method}",
                entry.name
            )));
        }
    };
    if uncompressed.len() as u64 != entry.uncompressed_size {
        return Err(AppError::Parse(format!(
            "ZIP 成员 {} 解压尺寸与声明不一致",
            entry.name
        )));
    }
    if crc32fast::hash(&uncompressed) != entry.crc32 {
        return Err(AppError::Parse(format!(
            "ZIP 成员 {} 校验和不一致，文件可能已损坏",
            entry.name
        )));
    }
    Ok(uncompressed)
}

#[cfg(test)]
pub(crate) fn build_test_zip(members: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;

    let mut output = Vec::new();
    let mut local_offsets = Vec::new();
    let mut compressed_payloads = Vec::new();
    for (index, (name, content)) in members.iter().enumerate() {
        local_offsets.push(output.len() as u32);
        let mut compressed = Vec::new();
        {
            let mut encoder = flate2::write::DeflateEncoder::new(
                &mut compressed,
                flate2::Compression::default(),
            );
            encoder.write_all(content).unwrap();
            encoder.finish().unwrap();
        }
        compressed_payloads.push(compressed);
        output.extend_from_slice(b"PK\x03\x04");
        output.extend_from_slice(&20_u16.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&8_u16.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&0_u32.to_le_bytes());
        output.extend_from_slice(&0_u32.to_le_bytes());
        output.extend_from_slice(&0_u32.to_le_bytes());
        output.extend_from_slice(&(name.len() as u16).to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(name.as_bytes());
        output.extend_from_slice(&compressed_payloads[index]);
    }
    let central_start = output.len();
    for (index, (name, content)) in members.iter().enumerate() {
        let crc = crc32fast::hash(content);
        output.extend_from_slice(b"PK\x01\x02");
        output.extend_from_slice(&20_u16.to_le_bytes());
        output.extend_from_slice(&20_u16.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&8_u16.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&crc.to_le_bytes());
        output.extend_from_slice(&(compressed_payloads[index].len() as u32).to_le_bytes());
        output.extend_from_slice(&(content.len() as u32).to_le_bytes());
        output.extend_from_slice(&(name.len() as u16).to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&0_u32.to_le_bytes());
        output.extend_from_slice(&local_offsets[index].to_le_bytes());
        output.extend_from_slice(name.as_bytes());
    }
    let central_size = (output.len() - central_start) as u32;
    output.extend_from_slice(b"PK\x05\x06");
    output.extend_from_slice(&0_u16.to_le_bytes());
    output.extend_from_slice(&0_u16.to_le_bytes());
    output.extend_from_slice(&(members.len() as u16).to_le_bytes());
    output.extend_from_slice(&(members.len() as u16).to_le_bytes());
    output.extend_from_slice(&central_size.to_le_bytes());
    output.extend_from_slice(&(central_start as u32).to_le_bytes());
    output.extend_from_slice(&0_u16.to_le_bytes());
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_central_directory_and_extracts_deflated_member() {
        let archive = build_test_zip(&[
            ("add_info.dat", br#"{"a":1}"#),
            ("s1_history.csv", b"1,1771902019754,16.7,49.8,16.7,49.8,0.0,0.0,139\n"),
        ]);
        let entries = read_entries(&archive).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].name, "s1_history.csv");
        assert_eq!(entries[1].uncompressed_size, 48);

        let extracted = extract_member(&archive, "s1_history.csv").unwrap();
        assert_eq!(
            extracted,
            b"1,1771902019754,16.7,49.8,16.7,49.8,0.0,0.0,139\n"
        );
        assert!(has_member(&archive, "S1_HISTORY.CSV"));
        assert!(!has_member(&archive, "missing.csv"));
    }

    #[test]
    fn rejects_corrupt_archive() {
        assert!(read_entries(b"not a zip at all").is_err());
        let archive = build_test_zip(&[("a.csv", b"1\n")]);
        let mut corrupt = archive.clone();
        // 本地头 30 字节 + 文件名 "a.csv" 5 字节后是内容，破坏内容触发 CRC 校验失败。
        corrupt[35] ^= 0xFF;
        assert!(read_entries(&corrupt).is_ok());
        assert!(extract_member(&corrupt, "a.csv").is_err());
    }
}
