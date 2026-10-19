use std::fs::File;
use std::io::Read;
use std::path::Path;

use super::freud_history_csv::{
    parse_freud_history_csv_bytes, probe_freud_history_csv_bytes,
};
use super::freud_s1_history_csv::{parse_freud_s1_history_bytes, probe_freud_s1_history_bytes};
use crate::data::controller_rules::{FREUD_HSHBKA_RULE, FREUD_MDATA_ZIP_RULE};
use crate::data::errors::AppError;
use crate::data::merge_sources::{merge_sources, SourceRows};
use crate::data::model::dataset_source;
use crate::data::zip_reader::{extract_member, has_member, read_member_head};

const S1_HISTORY_MEMBER: &str = "s1_history.csv";
const HISTORY_DATA_MEMBER: &str = "history_data.csv";
const MAX_PROBE_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const PROBE_MEMBER_HEAD: usize = 256 * 1024;

pub fn probe_freud_hshbka(path: &Path) -> Result<bool, AppError> {
    probe_zip_member(path, S1_HISTORY_MEMBER, probe_freud_s1_history_bytes)
}

pub fn probe_freud_mdata_zip(path: &Path) -> Result<bool, AppError> {
    probe_zip_member(path, HISTORY_DATA_MEMBER, probe_freud_history_csv_bytes)
}

pub(crate) fn parse_freud_hshbka_rows(path: &Path) -> Result<SourceRows, AppError> {
    let source = dataset_source(path)?;
    let bytes = read_archive(path)?;
    let member = extract_member(&bytes, S1_HISTORY_MEMBER)?;
    parse_freud_s1_history_bytes(&source, &member)
}

pub(crate) fn parse_freud_mdata_zip_rows(path: &Path) -> Result<SourceRows, AppError> {
    let source = dataset_source(path)?;
    let bytes = read_archive(path)?;
    let member = extract_member(&bytes, HISTORY_DATA_MEMBER)?;
    parse_freud_history_csv_bytes(&source, &member)
}

pub fn parse_freud_hshbka(path: &Path) -> Result<crate::data::model::Dataset, AppError> {
    let source = parse_freud_hshbka_rows(path)?;
    merge_sources(vec![source], &FREUD_HSHBKA_RULE)
}

pub fn parse_freud_mdata_zip(path: &Path) -> Result<crate::data::model::Dataset, AppError> {
    let source = parse_freud_mdata_zip_rows(path)?;
    merge_sources(vec![source], &FREUD_MDATA_ZIP_RULE)
}

fn read_archive(path: &Path) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    File::open(path)?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn probe_zip_member(
    path: &Path,
    member: &str,
    probe_content: fn(&[u8]) -> bool,
) -> Result<bool, AppError> {
    let file_len = std::fs::metadata(path)?.len();
    if file_len == 0 || file_len > MAX_PROBE_ARCHIVE_BYTES {
        return Ok(false);
    }
    let mut bytes = Vec::with_capacity(file_len as usize);
    File::open(path)?.read_to_end(&mut bytes)?;
    if !has_member(&bytes, member) {
        return Ok(false);
    }
    let Ok(head) = read_member_head(&bytes, member, PROBE_MEMBER_HEAD) else {
        return Ok(false);
    };
    Ok(probe_content(&head))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::test_support::TempFile;
    use crate::data::zip_reader::build_test_zip;

    const S1_CSV: &[u8] =
        b"1,1771902019754,16.7,49.8,16.7,49.8,0.0,0.0,139\n\
2,1771902024755,16.7,49.8,16.8,49.8,0.0,0.0,139\n\
3,1771902029757,17.0,49.8,16.9,49.8,0.0,0.0,139\n";
    const HISTORY_CSV: &[u8] =
        "\u{feff}时间,CH1_PV,CH2_PV,CH3_PV,CH1_SV,CH2_SV,CH3_SV,CH4_SV\n\
2026-07-15 14:14:18,35.7,46.4,99.4,35.7,46.5,99.4,3194.7\n\
2026-07-15 14:14:50,36.0,46.5,99.3,34.4,41.6,99.4,2858.2\n"
            .as_bytes();

    #[test]
    fn probes_and_parses_hshbka_container() {
        let archive = build_test_zip(&[
            ("add_info.dat", br#"{"vendorName":"SHBK"}"#),
            ("s1_history.csv", S1_CSV),
        ]);
        let fixture = TempFile::new("HSHBKA", archive);
        assert!(probe_freud_hshbka(&fixture.path).unwrap());
        assert!(!probe_freud_mdata_zip(&fixture.path).unwrap());

        let dataset = parse_freud_hshbka(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "freud-hshbka");
        assert_eq!(dataset.controller_rule, "freud-hshbka-v1");
        assert_eq!(dataset.row_count, 3);
        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        assert_eq!(actual_temp.points[2].1, Some(17.0));
    }

    #[test]
    fn probes_and_parses_mdata_container() {
        let archive = build_test_zip(&[("history_data.csv", HISTORY_CSV)]);
        let fixture = TempFile::new("zip", archive);
        assert!(probe_freud_mdata_zip(&fixture.path).unwrap());
        assert!(!probe_freud_hshbka(&fixture.path).unwrap());

        let dataset = parse_freud_mdata_zip(&fixture.path).unwrap();
        assert_eq!(dataset.parser, "freud-mdata-zip");
        assert_eq!(dataset.controller_rule, "freud-mdata-zip-v1");
        assert_eq!(dataset.row_count, 2);
        let actual_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-humidity")
            .unwrap();
        assert_eq!(actual_humidity.points[1].1, Some(46.5));
    }

    #[test]
    fn rejects_non_zip_and_unrelated_zips() {
        let plain = TempFile::new("HSHBKA", b"not a zip".to_vec());
        assert!(!probe_freud_hshbka(&plain.path).unwrap());
        assert!(!probe_freud_mdata_zip(&plain.path).unwrap());

        let unrelated = build_test_zip(&[("other.csv", b"1,2,3\n")]);
        let fixture = TempFile::new("HSHBKA", unrelated);
        assert!(!probe_freud_hshbka(&fixture.path).unwrap());
        assert!(!probe_freud_mdata_zip(&fixture.path).unwrap());
    }
}
