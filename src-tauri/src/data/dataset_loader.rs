use std::fs::File;
use std::path::{Path, PathBuf};

use super::controller_rules::{
    ATEC_6COL_CSV_RULE, ATEC_H12_RULE, ControllerRule, FREUD_HISTORY_CSV_RULE, FREUD_HSHBKA_RULE,
    FREUD_MDATA_ZIP_RULE, FREUD_S1_HISTORY_CSV_RULE, GBK_4COL_TEMP_CSV_RULE, INT16_7COL_CSV_RULE,
    KR_RCD_BIN_RULE, KR_TSV_RULE, MCGS_5COL_CSV_RULE, TEMI2500_SDR_RULE, UTF8_11COL_HMI_CSV_RULE,
    WEINTEK_EXPORT_RULE,
};
use super::errors::AppError;
use super::merge_sources::{merge_sources, SourceRows};
use super::model::{normalized_source_id, Dataset, DatasetSource};
use super::parser_registry::{detected_rule_id, parse_file};
use super::parsers::atec_6col_csv::parse_atec_6col_csv_rows;
use super::parsers::atec_h12::parse_atec_h12_rows;
use super::parsers::freud_history_csv::{
    parse_freud_history_csv_bytes, parse_freud_history_csv_rows, probe_freud_history_csv_bytes,
};
use super::parsers::freud_s1_history_csv::{
    parse_freud_s1_history_bytes, parse_freud_s1_history_csv_rows, probe_freud_s1_history_bytes,
};
use super::parsers::gbk_4col_temp_csv::parse_gbk_4col_temp_csv_rows;
use super::parsers::int16_7col_csv::parse_int16_7col_csv_rows;
use super::parsers::kr_rcd_bin::parse_kr_rcd_bin_rows;
use super::parsers::kr_tsv::parse_kr_tsv_rows;
use super::parsers::mcgs_5col_csv::parse_mcgs_5col_csv_rows;
use super::parsers::temi2500_sdr::parse_temi2500_sdr_rows;
use super::parsers::utf8_11col_hmi_csv::parse_utf8_11col_hmi_csv_rows;
use super::parsers::weintek_export::parse_weintek_export_rows;
use super::temi_merge::merge_temi_sources;
use super::weintek_merge::merge_weintek_sources;
use super::zip_reader::{extract_member, read_member_head};

pub fn load_dataset_paths(paths: Vec<PathBuf>) -> Result<Dataset, AppError> {
    if paths.is_empty() {
        return Err(AppError::UnsupportedFormat("未选择数据文件".to_string()));
    }

    let mut resolved_sources = Vec::with_capacity(paths.len());
    for path in paths {
        let source = SourcePath::resolve(path);
        source.validate()?;
        let identity = source.identity()?;
        resolved_sources.push((identity, source));
    }
    let resolved_sources = deduplicate_sources(resolved_sources);

    if let [(_, source)] = resolved_sources.as_slice() {
        return parse_source_path(source);
    }

    let first_parent_id = resolved_sources[0].1.parent_identity()?;
    for (_, source) in &resolved_sources[1..] {
        if source.parent_identity()? != first_parent_id {
            return Err(AppError::UnsupportedFormat(
                "本版本仅支持同一文件夹内多选同一格式的数据文件".to_string(),
            ));
        }
    }

    let mut detected_rules = Vec::with_capacity(resolved_sources.len());
    for (_, source) in &resolved_sources {
        match detected_rule_id_for_source(source) {
            Ok(rule_id) => detected_rules.push(rule_id),
            Err(error) => {
                return Err(AppError::UnsupportedFormat(format!(
                    "多文件合并仅支持同一文件夹内的同一格式数据文件；文件 {} 识别失败：{error}",
                    source.display_name()
                )));
            }
        }
    }
    let first_rule = detected_rules[0];
    if detected_rules.iter().any(|rule_id| *rule_id != first_rule) {
        return Err(AppError::UnsupportedFormat(
            "多文件合并不允许混用不同数据格式".to_string(),
        ));
    }

    if first_rule == TEMI2500_SDR_RULE.id {
        let mut sources = Vec::with_capacity(resolved_sources.len());
        for (_, source) in &resolved_sources {
            let rows = parse_temi2500_sdr_rows(source.physical_path()?)?;
            sources.push(rows);
        }
        return merge_temi_sources(sources);
    }
    if first_rule == WEINTEK_EXPORT_RULE.id {
        let mut sources = Vec::with_capacity(resolved_sources.len());
        for (_, source) in &resolved_sources {
            let rows = parse_weintek_export_rows(source.physical_path()?)?;
            sources.push(rows);
        }
        return merge_weintek_sources(sources);
    }

    let mut sources = Vec::with_capacity(resolved_sources.len());
    for (_, source) in &resolved_sources {
        let rows = match source {
            SourcePath::File(path) => parse_rows_for_rule(first_rule, path)?,
            SourcePath::ZipMember { archive, member } => {
                parse_zip_member_rows(archive, member)?
            }
        };
        sources.push(rows);
    }
    let rule = rule_for_id(first_rule)?;
    merge_sources(sources, rule)
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum SourcePath {
    File(PathBuf),
    ZipMember { archive: PathBuf, member: String },
}

impl SourcePath {
    fn resolve(path: PathBuf) -> SourcePath {
        if path.is_file() {
            return SourcePath::File(path);
        }
        if let Some((archive, member)) = split_zip_member_path(&path) {
            return SourcePath::ZipMember { archive, member };
        }
        SourcePath::File(path)
    }

    fn validate(&self) -> Result<(), AppError> {
        match self {
            SourcePath::File(path) => {
                let source_file = source_file(path);
                File::open(path).map_err(|error| io_with_source_file(error, &source_file))?;
            }
            SourcePath::ZipMember { archive, .. } => {
                let source_file = source_file(archive);
                File::open(archive).map_err(|error| io_with_source_file(error, &source_file))?;
            }
        }
        Ok(())
    }

    fn identity(&self) -> Result<String, AppError> {
        match self {
            SourcePath::File(path) => normalized_source_id(path).map_err(AppError::from),
            SourcePath::ZipMember { archive, member } => {
                let archive_id = normalized_source_id(archive).map_err(AppError::from)?;
                Ok(format!("zip:{archive_id}::{}", member.to_ascii_lowercase()))
            }
        }
    }

    fn parent_identity(&self) -> Result<String, AppError> {
        match self {
            SourcePath::File(path) => normalized_parent_id(path),
            SourcePath::ZipMember { archive, .. } => {
                let archive_id = normalized_source_id(archive).map_err(AppError::from)?;
                Ok(format!("zip:{archive_id}"))
            }
        }
    }

    fn display_name(&self) -> String {
        match self {
            SourcePath::File(path) => source_file(path),
            SourcePath::ZipMember { member, .. } => member
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or(member)
                .to_string(),
        }
    }

    fn physical_path(&self) -> Result<&Path, AppError> {
        match self {
            SourcePath::File(path) => Ok(path),
            SourcePath::ZipMember { .. } => Err(AppError::Parse(
                "该文件位于 ZIP 容器内部，不支持此合并路径".to_string(),
            )),
        }
    }
}

/// Windows 11 将 ZIP 视为文件夹，用户可能在资源管理器或文件对话框中直接选中
/// zip 内部的成员，路径形如 `xxx.HSHBKA\s1_history.csv`（物理路径不存在）。
/// 找到最深层存在的 zip-like 文件前缀，其余部分作为压缩成员路径。
fn split_zip_member_path(path: &Path) -> Option<(PathBuf, String)> {
    let mut member_parts: Vec<String> = Vec::new();
    let mut probe = path.to_path_buf();
    loop {
        let name = probe.file_name()?.to_string_lossy().into_owned();
        member_parts.push(name);
        let parent = probe.parent()?;
        if parent.is_file() && is_zip_like(parent) {
            member_parts.reverse();
            return Some((parent.to_path_buf(), member_parts.join("/")));
        }
        probe = parent.to_path_buf();
    }
}

fn is_zip_like(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("zip") || extension.eq_ignore_ascii_case("hshbka")
        })
}

fn parse_source_path(source: &SourcePath) -> Result<Dataset, AppError> {
    match source {
        SourcePath::File(path) => parse_file(path),
        SourcePath::ZipMember { archive, member } => {
            let source = zip_member_source(archive, member)?;
            let bytes = std::fs::read(archive)?;
            let member_bytes = extract_member(&bytes, member)?;
            let (rows, rule) = if member.eq_ignore_ascii_case("s1_history.csv")
                && probe_freud_s1_history_bytes(&member_bytes)
            {
                (
                    parse_freud_s1_history_bytes(&source, &member_bytes)?,
                    &FREUD_S1_HISTORY_CSV_RULE,
                )
            } else if member.eq_ignore_ascii_case("history_data.csv")
                && probe_freud_history_csv_bytes(&member_bytes)
            {
                (
                    parse_freud_history_csv_bytes(&source, &member_bytes)?,
                    &FREUD_HISTORY_CSV_RULE,
                )
            } else {
                return Err(AppError::UnsupportedFormat(format!(
                    "ZIP 成员 {member:?} 不是受支持的弗锐德历史数据"
                )));
            };
            merge_sources(vec![rows], rule)
        }
    }
}

fn parse_zip_member_rows(archive: &Path, member: &str) -> Result<SourceRows, AppError> {
    let source = zip_member_source(archive, member)?;
    let bytes = std::fs::read(archive)?;
    let member_bytes = extract_member(&bytes, member)?;
    if member.eq_ignore_ascii_case("s1_history.csv") {
        if probe_freud_s1_history_bytes(&member_bytes) {
            return parse_freud_s1_history_bytes(&source, &member_bytes);
        }
        return Err(AppError::Parse(format!(
            "ZIP 成员 {member:?} 内容不是弗锐德 s1_history 数据"
        )));
    }
    if member.eq_ignore_ascii_case("history_data.csv") {
        if probe_freud_history_csv_bytes(&member_bytes) {
            return parse_freud_history_csv_bytes(&source, &member_bytes);
        }
        return Err(AppError::Parse(format!(
            "ZIP 成员 {member:?} 内容不是弗锐德温湿高箱历史数据"
        )));
    }
    Err(AppError::UnsupportedFormat(format!(
        "ZIP 成员 {member:?} 不是受支持的弗锐德历史数据"
    )))
}

fn zip_member_source(archive: &Path, member: &str) -> Result<DatasetSource, AppError> {
    let archive_id = normalized_source_id(archive).map_err(AppError::from)?;
    Ok(DatasetSource {
        source_id: format!("zip:{archive_id}::{member}"),
        source_file: member
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(member)
            .to_string(),
    })
}

fn detected_rule_id_for_source(source: &SourcePath) -> Result<&'static str, AppError> {
    match source {
        SourcePath::File(path) => detected_rule_id(path),
        SourcePath::ZipMember { archive, member } => {
            let bytes = std::fs::read(archive)?;
            let head = read_member_head(&bytes, member, 256 * 1024)?;
            if member.eq_ignore_ascii_case("s1_history.csv")
                && probe_freud_s1_history_bytes(&head)
            {
                Ok(FREUD_S1_HISTORY_CSV_RULE.id)
            } else if member.eq_ignore_ascii_case("history_data.csv")
                && probe_freud_history_csv_bytes(&head)
            {
                Ok(FREUD_HISTORY_CSV_RULE.id)
            } else {
                Err(AppError::UnsupportedFormat(format!(
                    "ZIP 成员 {member:?} 不是受支持的弗锐德历史数据"
                )))
            }
        }
    }
}

fn parse_rows_for_rule(rule_id: &str, path: &Path) -> Result<SourceRows, AppError> {
    if rule_id == INT16_7COL_CSV_RULE.id {
        parse_int16_7col_csv_rows(path)
    } else if rule_id == UTF8_11COL_HMI_CSV_RULE.id {
        parse_utf8_11col_hmi_csv_rows(path)
    } else if rule_id == GBK_4COL_TEMP_CSV_RULE.id {
        parse_gbk_4col_temp_csv_rows(path)
    } else if rule_id == KR_TSV_RULE.id {
        parse_kr_tsv_rows(path)
    } else if rule_id == KR_RCD_BIN_RULE.id {
        parse_kr_rcd_bin_rows(path)
    } else if rule_id == ATEC_H12_RULE.id {
        parse_atec_h12_rows(path)
    } else if rule_id == ATEC_6COL_CSV_RULE.id {
        parse_atec_6col_csv_rows(path)
    } else if rule_id == MCGS_5COL_CSV_RULE.id {
        parse_mcgs_5col_csv_rows(path)
    } else if rule_id == FREUD_S1_HISTORY_CSV_RULE.id {
        parse_freud_s1_history_csv_rows(path)
    } else if rule_id == FREUD_HISTORY_CSV_RULE.id {
        parse_freud_history_csv_rows(path)
    } else if rule_id == FREUD_HSHBKA_RULE.id {
        super::parsers::freud_zip::parse_freud_hshbka_rows(path)
    } else if rule_id == FREUD_MDATA_ZIP_RULE.id {
        super::parsers::freud_zip::parse_freud_mdata_zip_rows(path)
    } else {
        Err(AppError::UnsupportedFormat(format!(
            "多文件合并仅支持同一文件夹内的同一格式数据文件；文件识别为规则 {rule_id}"
        )))
    }
}

fn rule_for_id(rule_id: &str) -> Result<&'static ControllerRule, AppError> {
    if rule_id == INT16_7COL_CSV_RULE.id {
        Ok(&INT16_7COL_CSV_RULE)
    } else if rule_id == UTF8_11COL_HMI_CSV_RULE.id {
        Ok(&UTF8_11COL_HMI_CSV_RULE)
    } else if rule_id == GBK_4COL_TEMP_CSV_RULE.id {
        Ok(&GBK_4COL_TEMP_CSV_RULE)
    } else if rule_id == KR_TSV_RULE.id {
        Ok(&KR_TSV_RULE)
    } else if rule_id == KR_RCD_BIN_RULE.id {
        Ok(&KR_RCD_BIN_RULE)
    } else if rule_id == ATEC_H12_RULE.id {
        Ok(&ATEC_H12_RULE)
    } else if rule_id == ATEC_6COL_CSV_RULE.id {
        Ok(&ATEC_6COL_CSV_RULE)
    } else if rule_id == MCGS_5COL_CSV_RULE.id {
        Ok(&MCGS_5COL_CSV_RULE)
    } else if rule_id == FREUD_S1_HISTORY_CSV_RULE.id {
        Ok(&FREUD_S1_HISTORY_CSV_RULE)
    } else if rule_id == FREUD_HISTORY_CSV_RULE.id {
        Ok(&FREUD_HISTORY_CSV_RULE)
    } else if rule_id == FREUD_HSHBKA_RULE.id {
        Ok(&FREUD_HSHBKA_RULE)
    } else if rule_id == FREUD_MDATA_ZIP_RULE.id {
        Ok(&FREUD_MDATA_ZIP_RULE)
    } else {
        Err(AppError::UnsupportedFormat(format!(
            "多文件合并仅支持同一文件夹内的同一格式数据文件；文件识别为规则 {rule_id}"
        )))
    }
}

fn normalized_parent_id(path: &Path) -> Result<String, AppError> {
    let parent = path.parent().ok_or_else(|| {
        AppError::UnsupportedFormat("本版本仅支持同一文件夹内多选同一格式的数据文件".to_string())
    })?;
    normalized_source_id(parent).map_err(AppError::from)
}

fn source_file(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".to_string())
}

fn io_with_source_file(error: std::io::Error, source_file: &str) -> AppError {
    AppError::Io(format!("文件 {source_file}：{error}"))
}

fn deduplicate_sources(sources: Vec<(String, SourcePath)>) -> Vec<(String, SourcePath)> {
    let mut keyed_sources = sources
        .into_iter()
        .map(|(source_id, path)| (unicode_lowercase(&source_id), source_id, path))
        .collect::<Vec<_>>();
    keyed_sources.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    keyed_sources.dedup_by(|left, right| left.0 == right.0);
    keyed_sources
        .into_iter()
        .map(|(_, source_id, path)| (source_id, path))
        .collect()
}

// Rust's locale-independent Unicode lowercase mapping gives stable case-insensitive ordering.
fn unicode_lowercase(value: &str) -> String {
    value.chars().flat_map(char::to_lowercase).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::errors::AppError;
    use crate::data::test_support::decode_sparse_hex;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    static NEXT_TEMP_TREE_ID: AtomicU64 = AtomicU64::new(0);

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new() -> Self {
            let sequence = NEXT_TEMP_TREE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "chamber-data-viewer-dataset-loader-{}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }

        fn write(&self, folder: &str, name: &str, bytes: &[u8]) -> PathBuf {
            let folder = self.root.join(folder);
            std::fs::create_dir_all(&folder).unwrap();
            let path = folder.join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        }

        fn write_sdr(&self, folder: &str, name: &str, bytes: &[u8]) -> PathBuf {
            self.write(folder, name, bytes)
        }

        fn write_csv(&self, folder: &str, name: &str) -> PathBuf {
            self.write(
                folder,
                name,
                b"TIME\tTEMP_PV\tTEMP_SV\tHUMI_PV\tHUMI_SV\n2026-06-23 11:12:19\t14.77\t100.00\t50.00\t40.00\n",
            )
        }

        fn write_int16(&self, folder: &str, name: &str, start_second: u32) -> PathBuf {
            let content = format!(
                "\"Date\",\"Time\",\"Millisecond\",\"16-bit Signed\",\"16-bit Signed\",\"16-bit Signed\",\"16-bit Signed\"\n\
                 \"2026/08/02\",\"00:00:{:02}\",\"480\",\"500\",\"499\",\"500\",\"496\"\n\
                 \"2026/08/02\",\"00:00:{:02}\",\"560\",\"302\",\"500\",\"500\",\"301\"\n",
                start_second,
                start_second + 30
            )
            .into_bytes();
            self.write(folder, name, &content)
        }

        fn write_weintek(&self, folder: &str, name: &str) -> PathBuf {
            self.write(
                folder,
                name,
                include_bytes!("../../tests/fixtures/weintek-export-minimal.csv"),
            )
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn temi_fixture_bytes() -> Vec<u8> {
        decode_sparse_hex(include_str!(
            "../../tests/fixtures/temi2500-sdr-minimal.hex"
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

    fn external_temi_folder_paths(folder_name: &str, expected_count: usize) -> Vec<PathBuf> {
        let root = external_temi_root();
        let folder = std::fs::read_dir(&root)
            .expect("无法读取 TEMI2500 样本根目录")
            .map(|entry| entry.expect("无法读取 TEMI2500 样本根目录项"))
            .find(|entry| {
                entry
                    .file_type()
                    .expect("无法读取 TEMI2500 日期目录类型")
                    .is_dir()
                    && entry
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(folder_name)
            })
            .unwrap_or_else(|| panic!("未找到 TEMI2500 日期目录 {folder_name}"));
        let mut paths = std::fs::read_dir(folder.path())
            .expect("无法读取 TEMI2500 日期目录")
            .map(|entry| entry.expect("无法读取 TEMI2500 样本文件目录项"))
            .filter(|entry| {
                let path = entry.path();
                entry
                    .file_type()
                    .expect("无法读取 TEMI2500 样本文件类型")
                    .is_file()
                    && path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("sdr"))
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        paths.sort();
        assert_eq!(
            paths.len(),
            expected_count,
            "TEMI2500 日期目录 {folder_name} 的 SDR 文件数量不符合预期"
        );
        paths
    }

    #[test]
    #[ignore = "requires CHAMBER_TEMI2500_ROOT with the private TEMI2500 production samples"]
    fn external_temi_same_folder_loader_merges_and_rejects_cross_folder_selection() {
        let same_folder_paths = external_temi_folder_paths("SR260615", 4);
        let started = Instant::now();
        let dataset = load_dataset_paths(same_folder_paths.clone()).unwrap();
        let elapsed = started.elapsed();
        eprintln!(
            "external TEMI2500 same-folder loader: files={}, rows={}, elapsed={elapsed:?}",
            same_folder_paths.len(),
            dataset.row_count
        );

        assert_eq!(dataset.sources.len(), 4);
        assert_eq!(dataset.source_file, "已合并 4 个 TEMI2500 文件");
        assert_eq!(dataset.row_count, 95_515);
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains("检测到 3 个停录间断")
                && diagnostic.message.contains("缺少 107 个采样点")
        }));

        let other_folder_paths = external_temi_folder_paths("SR260701", 1);
        assert!(matches!(
            load_dataset_paths(vec![
                same_folder_paths[0].clone(),
                other_folder_paths[0].clone(),
            ]),
            Err(AppError::UnsupportedFormat(message))
                if message == "本版本仅支持同一文件夹内多选同一格式的数据文件"
        ));
    }

    fn assert_unsupported_contains(
        result: Result<crate::data::model::Dataset, AppError>,
        text: &str,
    ) {
        assert!(matches!(
            result,
            Err(AppError::UnsupportedFormat(message)) if message.contains(text)
        ));
    }

    #[test]
    fn deduplicates_the_same_path_and_falls_back_to_single_file_loading() {
        let tree = TempTree::new();
        let path = tree.write_sdr("same", "a.SDR", &temi_fixture_bytes());

        let dataset = load_dataset_paths(vec![path.clone(), path]).unwrap();

        assert_eq!(dataset.sources.len(), 1);
        assert_eq!(dataset.source_file, "a.SDR");
    }

    #[test]
    fn accepts_same_folder_temi_files_in_any_selection_order() {
        let tree = TempTree::new();
        let first_bytes = temi_fixture_bytes();
        let mut later_bytes = first_bytes.clone();
        later_bytes[0x206] = 6;
        later_bytes[0x406] = 7;
        let first = tree.write_sdr("same", "a.SDR", &first_bytes);
        let later = tree.write_sdr("same", "b.SDR", &later_bytes);

        let forward = load_dataset_paths(vec![first.clone(), later.clone()]).unwrap();
        let reverse = load_dataset_paths(vec![later, first]).unwrap();

        assert_eq!(forward, reverse);
        assert_eq!(forward.sources.len(), 2);
    }

    #[test]
    fn rejects_cross_folder_mixed_and_damaged_groups_atomically() {
        let tree = TempTree::new();
        let other_tree = TempTree::new();
        let bytes = temi_fixture_bytes();
        let first = tree.write_sdr("same", "a.SDR", &bytes);
        let other = other_tree.write_sdr("other", "b.SDR", &bytes);
        let csv = tree.write_csv("same", "data.csv");
        let broken = tree.write_sdr("same", "broken.SDR", &[0_u8; 1024]);

        assert_unsupported_contains(
            load_dataset_paths(vec![first.clone(), other]),
            "本版本仅支持同一文件夹内多选同一格式的数据文件",
        );
        assert_unsupported_contains(
            load_dataset_paths(vec![first.clone(), csv]),
            "不允许混用不同数据格式",
        );
        assert_unsupported_contains(load_dataset_paths(vec![first, broken]), "broken.SDR");
    }

    #[test]
    fn merges_same_folder_weintek_files_and_rejects_cross_format_groups() {
        let tree = TempTree::new();
        let weintek_a = tree.write_weintek("weintek", "a.csv");
        let weintek_b = tree.write_weintek("weintek", "b.csv");
        let other_tree = TempTree::new();
        let weintek_other = other_tree.write_weintek("other", "c.csv");
        let csv = tree.write_csv("weintek", "data.csv");

        let dataset = load_dataset_paths(vec![weintek_a.clone(), weintek_b.clone()]).unwrap();
        assert_eq!(dataset.sources.len(), 2);
        assert_eq!(dataset.source_file, "已合并 2 个威纶通文件");
        assert_eq!(dataset.parser, "weintek-export");
        assert!(dataset.source_id.starts_with("weintek-group:"));

        assert_unsupported_contains(
            load_dataset_paths(vec![weintek_a.clone(), weintek_other]),
            "同一文件夹",
        );
        assert_unsupported_contains(load_dataset_paths(vec![weintek_a, csv]), "不允许混用");
    }

    #[test]
    fn merges_same_folder_kr_tsv_and_int16_files() {
        let tree = TempTree::new();
        let tsv_a = tree.write_csv("hanche", "a.xls");
        let tsv_b = tree.write_csv("hanche", "b.xls");
        let dataset = load_dataset_paths(vec![tsv_a, tsv_b]).unwrap();
        assert_eq!(dataset.sources.len(), 2);
        assert_eq!(dataset.source_file, "已合并 2 个文件");
        assert_eq!(dataset.parser, "kr-tsv");
        assert!(dataset.source_id.starts_with("kr-tsv-group:"));

        let int16_a = tree.write_int16("atec", "a.csv", 0);
        let int16_b = tree.write_int16("atec", "b.csv", 1);
        let dataset = load_dataset_paths(vec![int16_a, int16_b]).unwrap();
        assert_eq!(dataset.sources.len(), 2);
        assert_eq!(dataset.source_file, "已合并 2 个文件");
        assert_eq!(dataset.parser, "16bit-7col-csv");
        assert_eq!(dataset.row_count, 4);
    }

    #[test]
    #[ignore = "requires CHAMBER_ATEC_INT16_ROOT with the private Atec 16-bit 7-column CSV samples"]
    fn external_atec_int16_same_folder_merges() {
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

        let dataset = load_dataset_paths(paths).unwrap();
        assert_eq!(dataset.sources.len(), 6);
        assert_eq!(dataset.source_file, "已合并 6 个文件");
        assert_eq!(dataset.row_count, 16_744);
    }

    #[test]
    #[ignore = "requires CHAMBER_HANCHE_ROOT with the private Hanche samples"]
    fn external_hanche_tsv_same_folder_merges_with_breaks() {
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

        let dataset = load_dataset_paths(paths).unwrap();
        assert_eq!(dataset.sources.len(), 3);
        assert_eq!(dataset.row_count, 739);
        assert!(dataset
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.message.contains("停录间断") }));
    }

    #[test]
    #[ignore = "requires CHAMBER_ATEC_GBK_ROOT with Atec shock chamber samples"]
    fn external_atec_gbk_same_folder_merges_without_breaks() {
        let root = std::path::PathBuf::from(
            std::env::var_os("CHAMBER_ATEC_GBK_ROOT")
                .expect("set CHAMBER_ATEC_GBK_ROOT to the Atec shock chamber sample folder"),
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
        assert_eq!(paths.len(), 3);

        let dataset = load_dataset_paths(paths).unwrap();
        assert_eq!(dataset.sources.len(), 3);
        assert_eq!(dataset.row_count, 7_200);
        assert!(!dataset
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.message.contains("停录间断") }));
    }

    #[test]
    fn single_weintek_file_keeps_the_physical_name() {
        let tree = TempTree::new();
        let path = tree.write_weintek("weintek", "single.csv");

        let dataset = load_dataset_paths(vec![path]).unwrap();

        assert_eq!(dataset.sources.len(), 1);
        assert_eq!(dataset.source_file, "single.csv");
        assert_eq!(dataset.row_count, 3);
    }

    #[test]
    fn rejects_an_empty_path_group() {
        assert_unsupported_contains(load_dataset_paths(Vec::new()), "未选择");
    }

    #[test]
    fn preserves_io_errors_for_missing_paths() {
        let tree = TempTree::new();
        let missing = tree.path("missing.SDR");

        assert!(matches!(
            load_dataset_paths(vec![missing]),
            Err(AppError::Io(message)) if message.contains("missing.SDR")
        ));
    }

    #[test]
    fn reports_a_late_temi_parse_failure_with_the_file_name_once() {
        let tree = TempTree::new();
        let valid_bytes = temi_fixture_bytes();
        let mut broken_bytes = valid_bytes.clone();
        broken_bytes.extend_from_slice(&[0_u8; 512]);
        broken_bytes[512 * 3] = 0x44;
        let valid = tree.write_sdr("same", "a.SDR", &valid_bytes);
        let broken = tree.write_sdr("same", "broken.SDR", &broken_bytes);

        let result = load_dataset_paths(vec![valid, broken]);

        match result {
            Err(AppError::Parse(message)) => {
                assert!(message.contains("第 3 个数据页"), "{message}");
                assert_eq!(message.matches("broken.SDR").count(), 1, "{message}");
            }
            unexpected => panic!("{unexpected:?}"),
        }
    }

    #[test]
    fn case_insensitive_identity_deduplication_is_deterministic() {
        let left = (
            "C:/Fixtures/A.SDR".to_string(),
            SourcePath::File(PathBuf::from("first")),
        );
        let right = (
            "c:/fixtures/a.sdr".to_string(),
            SourcePath::File(PathBuf::from("second")),
        );

        let deduplicated = deduplicate_sources(vec![right, left]);

        assert_eq!(deduplicated.len(), 1);
        assert_eq!(deduplicated[0].0, "C:/Fixtures/A.SDR");
        assert!(matches!(&deduplicated[0].1, SourcePath::File(path) if path == Path::new("first")));
    }

    fn h12_fixture(start_second: u32, values: &[(i32, u32)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (index, (temp, humidity)) in values.iter().enumerate() {
            bytes.extend_from_slice(&(start_second + index as u32 * 30).to_le_bytes());
            bytes.extend_from_slice(&((*temp as u32) << 16 | *humidity).to_le_bytes());
        }
        bytes
    }

    #[test]
    fn merges_same_folder_h12_segments() {
        let tree = TempTree::new();
        let start = 1_777_073_147_u32;
        let first = tree.write(
            "atec",
            "1777073147.h12",
            &h12_fixture(start, &[(950, 400), (935, 400), (950, 400)]),
        );
        // 第一段结束于 start+60 秒，第二段从 start+90 秒开始（间隔 30 秒，同一网格）。
        let second = tree.write(
            "atec",
            "1777073267.h12",
            &h12_fixture(start + 90, &[(960, 401), (970, 401)]),
        );

        let dataset = load_dataset_paths(vec![first, second]).unwrap();
        assert_eq!(dataset.parser, "atec-h12");
        assert_eq!(dataset.sources.len(), 2);
        assert_eq!(dataset.row_count, 5);
        assert_eq!(dataset.time_range.start, "2026-04-25 07:25:47");
        assert_eq!(dataset.time_range.end, "2026-04-25 07:27:47");
        assert!(!dataset
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("停录间断")));
    }

    const S1_CSV: &[u8] =
        b"1,1771902019754,16.7,49.8,16.7,49.8,0.0,0.0,139\n\
2,1771902024755,16.7,49.8,16.8,49.8,0.0,0.0,139\n\
3,1771902029757,17.0,49.8,16.9,49.8,0.0,0.0,139\n";

    #[test]
    fn loads_zip_member_virtual_path_from_win11_folder_view() {
        let tree = TempTree::new();
        let archive = crate::data::zip_reader::build_test_zip(&[("s1_history.csv", S1_CSV)]);
        let zip_path = tree.write("freud", "data.HSHBKA", &archive);
        // Windows 11 将 zip 视为文件夹：选中的是 zip 内部成员，物理路径不存在。
        let virtual_path = zip_path.join("s1_history.csv");

        let dataset = load_dataset_paths(vec![virtual_path]).unwrap();

        assert_eq!(dataset.parser, "freud-s1-history-csv");
        assert_eq!(dataset.controller_rule, "freud-s1-history-csv-v1");
        assert_eq!(dataset.sources.len(), 1);
        assert_eq!(dataset.source_file, "s1_history.csv");
        assert_eq!(dataset.row_count, 3);
        assert!(dataset.source_id.starts_with("zip:"));
    }

    #[test]
    fn merges_zip_members_of_the_same_archive() {
        let tree = TempTree::new();
        let archive = crate::data::zip_reader::build_test_zip(&[("s1_history.csv", S1_CSV)]);
        let zip_path = tree.write("freud", "data.HSHBKA", &archive);
        let virtual_path = zip_path.join("s1_history.csv");
        let again = zip_path.join("S1_HISTORY.CSV");

        let dataset = load_dataset_paths(vec![virtual_path, again]).unwrap();

        assert_eq!(dataset.sources.len(), 1, "大小写不同的同一成员应去重");
        assert_eq!(dataset.row_count, 3);
    }

    #[test]
    fn rejects_zip_member_mixed_with_container_or_other_folder() {
        let tree = TempTree::new();
        let archive = crate::data::zip_reader::build_test_zip(&[("s1_history.csv", S1_CSV)]);
        let zip_path = tree.write("freud", "data.HSHBKA", &archive);
        let virtual_path = zip_path.join("s1_history.csv");

        assert_unsupported_contains(
            load_dataset_paths(vec![virtual_path.clone(), zip_path.clone()]),
            "同一文件夹",
        );

        let other_tree = TempTree::new();
        let other_archive = crate::data::zip_reader::build_test_zip(&[("s1_history.csv", S1_CSV)]);
        let other_zip = other_tree.write("other", "data2.HSHBKA", &other_archive);
        assert_unsupported_contains(
            load_dataset_paths(vec![virtual_path, other_zip.join("s1_history.csv")]),
            "同一文件夹",
        );
    }

    #[test]
    fn parses_new_single_file_formats_through_the_registry() {
        let tree = TempTree::new();
        let mcgs = tree.write(
            "sanzhi",
            "CT.csv",
            b"\"MCGS_TIME\",\"TempPV\",\"DisTempSV\",\"HumiPV\",\"DisHumiSV\"\n\
2026/05/29 03:41:40,-5.710000,-4.000000,0.000000,0.000000\n",
        );
        let dataset = load_dataset_paths(vec![mcgs]).unwrap();
        assert_eq!(dataset.parser, "mcgs-5col-csv");

        let h12 = tree.write(
            "atec-h12",
            "1777073147.h12",
            &h12_fixture(1_777_073_147, &[(950, 400), (935, 400)]),
        );
        let dataset = load_dataset_paths(vec![h12]).unwrap();
        assert_eq!(dataset.parser, "atec-h12");
    }

    /// 递归扫描样本根目录，按内容识别出的规则 ID 把文件按所在目录分组。
    /// 只依据文件内容定位样本，代码中不出现样本目录名里的设备信息。
    fn sample_index(
        root: &Path,
    ) -> std::collections::BTreeMap<&'static str, Vec<Vec<PathBuf>>> {
        fn collect(
            dir: &Path,
            groups: &mut std::collections::BTreeMap<(&'static str, PathBuf), Vec<PathBuf>>,
        ) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    collect(&path, groups);
                } else if let Ok(rule_id) = detected_rule_id(&path) {
                    groups
                        .entry((rule_id, dir.to_path_buf()))
                        .or_default()
                        .push(path);
                }
            }
        }

        let mut groups = std::collections::BTreeMap::new();
        collect(root, &mut groups);
        let mut index = std::collections::BTreeMap::<&'static str, Vec<Vec<PathBuf>>>::new();
        for ((rule_id, _), mut paths) in groups {
            paths.sort();
            index.entry(rule_id).or_default().push(paths);
        }
        index
    }

    fn sample_groups<'a>(
        index: &'a std::collections::BTreeMap<&'static str, Vec<Vec<PathBuf>>>,
        rule_id: &str,
    ) -> &'a [Vec<PathBuf>] {
        index
            .get(rule_id)
            .map(Vec::as_slice)
            .unwrap_or_else(|| panic!("样本根目录中没有 {rule_id} 样本"))
    }

    fn single_sample_group(
        index: &std::collections::BTreeMap<&'static str, Vec<Vec<PathBuf>>>,
        rule_id: &str,
    ) -> Vec<PathBuf> {
        let groups = sample_groups(index, rule_id);
        assert_eq!(groups.len(), 1, "{rule_id} 样本应恰好位于一个目录");
        groups[0].clone()
    }

    #[test]
    #[ignore = "requires CHAMBER_RAW_SAMPLES_ROOT with the private raw data samples"]
    fn external_new_raw_samples_parse_end_to_end() {
        use std::fs;

        let root = std::path::PathBuf::from(
            std::env::var_os("CHAMBER_RAW_SAMPLES_ROOT")
                .expect("set CHAMBER_RAW_SAMPLES_ROOT to the raw_data_files folder"),
        );
        assert!(root.is_dir(), "CHAMBER_RAW_SAMPLES_ROOT 不是目录：{}", root.display());
        let index = sample_index(&root);

        // 阿泰可 .h12：同一导出目录的分段文件全选合并。
        let h12_paths = sample_groups(&index, "atec-h12-v1")
            .iter()
            .find(|paths| paths[0].parent().unwrap().ends_with("20260808083516"))
            .expect("缺少 20260808083516 导出批次")
            .clone();
        assert_eq!(h12_paths.len(), 11);
        let dataset = load_dataset_paths(h12_paths).unwrap();
        assert_eq!(dataset.parser, "atec-h12");
        assert_eq!(dataset.row_count, 42_757);
        assert_eq!(dataset.time_range.start, "2026-03-26 22:36:45");
        assert_eq!(dataset.time_range.end, "2026-08-08 07:48:25");
        assert!(dataset
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("停录间断")));

        // 阿泰可 6 列 CSV：同目录 2 个文件合并。
        let atec6_paths = single_sample_group(&index, "atec-6col-csv-v1");
        assert_eq!(atec6_paths.len(), 2);
        let dataset = load_dataset_paths(atec6_paths).unwrap();
        assert_eq!(dataset.parser, "atec-6col-csv");
        assert_eq!(dataset.row_count, 120_000);
        assert_eq!(dataset.time_range.start, "2026-04-21 10:02:03");

        // 三志 MCGS 5 列 CSV：同目录 2 个文件合并。
        let mcgs_paths = single_sample_group(&index, "mcgs-5col-csv-v1");
        assert_eq!(mcgs_paths.len(), 2);
        let dataset = load_dataset_paths(mcgs_paths).unwrap();
        assert_eq!(dataset.parser, "mcgs-5col-csv");
        assert_eq!(dataset.row_count, 1_052);

        // 弗锐德 .HSHBKA 容器：单文件与同目录多选合并。
        // 两台设备各一个导出目录：一个目录 2 个文件（多选合并），另一个 1 个文件（单文件）。
        let hshbka_groups = sample_groups(&index, "freud-hshbka-v1");
        assert_eq!(hshbka_groups.len(), 2);
        let hshbka_paths = hshbka_groups
            .iter()
            .find(|paths| paths.len() == 2)
            .expect("缺少含 2 个 .HSHBKA 的导出目录")
            .clone();
        assert_eq!(hshbka_paths.len(), 2);
        let dataset = load_dataset_paths(hshbka_paths.clone()).unwrap();
        assert_eq!(dataset.parser, "freud-hshbka");
        assert_eq!(dataset.sources.len(), 2);
        assert!(dataset.row_count > 197_790);

        let hshbka_single_paths = hshbka_groups
            .iter()
            .find(|paths| paths.len() == 1)
            .expect("缺少含 1 个 .HSHBKA 的导出目录")
            .clone();
        assert_eq!(hshbka_single_paths.len(), 1);
        let dataset = load_dataset_paths(hshbka_single_paths).unwrap();
        assert_eq!(dataset.parser, "freud-hshbka");
        assert!(dataset.row_count > 0);

        // 弗锐德温湿高箱 MData zip：3 个 zip 同目录合并。
        let mdata_paths = single_sample_group(&index, "freud-mdata-zip-v1");
        assert_eq!(mdata_paths.len(), 3);
        let dataset = load_dataset_paths(mdata_paths).unwrap();
        assert_eq!(dataset.parser, "freud-mdata-zip");
        assert_eq!(dataset.row_count, 208 + 178 + 174);

        // 解压后的 CSV 直接打开。
        let s1_file = hshbka_paths[0].clone();
        let archive = fs::read(&s1_file).unwrap();
        let extracted = crate::data::zip_reader::extract_member(&archive, "s1_history.csv").unwrap();
        let extracted_path = std::env::temp_dir().join(format!(
            "chamber-data-viewer-external-{}-s1_history.csv",
            std::process::id()
        ));
        fs::write(&extracted_path, &extracted).unwrap();
        let dataset = load_dataset_paths(vec![extracted_path.clone()]).unwrap();
        assert_eq!(dataset.parser, "freud-s1-history-csv");
        let _ = fs::remove_file(&extracted_path);

        // Windows 11 zip 虚拟文件夹路径：直接选 zip 内部的 s1_history.csv。
        let virtual_path = s1_file.join("s1_history.csv");
        let dataset = load_dataset_paths(vec![virtual_path]).unwrap();
        assert_eq!(dataset.parser, "freud-s1-history-csv");
        assert_eq!(dataset.source_file, "s1_history.csv");
        assert!(dataset.source_id.starts_with("zip:"));
    }
}
