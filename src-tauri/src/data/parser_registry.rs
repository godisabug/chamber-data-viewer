use std::path::Path;

use super::controller_rules::{
    ATEC_6COL_CSV_RULE, ATEC_H12_RULE, ControllerRule, FREUD_HISTORY_CSV_RULE, FREUD_HSHBKA_RULE,
    FREUD_MDATA_ZIP_RULE, FREUD_S1_HISTORY_CSV_RULE, GBK_4COL_TEMP_CSV_RULE, GUANGWUSUO_000_RULE,
    INT16_7COL_CSV_RULE, KR_RCD_BIN_RULE, KR_TSV_RULE, MCGS_5COL_CSV_RULE, TEMI2500_SDR_RULE,
    UTF8_11COL_HMI_CSV_RULE, WEINTEK_EXPORT_RULE,
};
use super::errors::AppError;
use super::model::Dataset;
use super::parsers::atec_6col_csv::{parse_atec_6col_csv, probe_atec_6col_csv};
use super::parsers::atec_h12::{parse_atec_h12, probe_atec_h12};
use super::parsers::freud_history_csv::{parse_freud_history_csv, probe_freud_history_csv};
use super::parsers::freud_s1_history_csv::{
    parse_freud_s1_history_csv, probe_freud_s1_history_csv,
};
use super::parsers::freud_zip::{
    parse_freud_hshbka, parse_freud_mdata_zip, probe_freud_hshbka, probe_freud_mdata_zip,
};
use super::parsers::gbk_4col_temp_csv::{parse_gbk_4col_temp_csv, probe_gbk_4col_temp_csv};
use super::parsers::guangwusuo_000::{parse_guangwusuo_000, probe_guangwusuo_000};
use super::parsers::int16_7col_csv::{parse_int16_7col_csv, probe_int16_7col_csv};
use super::parsers::kr_rcd_bin::{parse_kr_rcd_bin, probe_kr_rcd_bin};
use super::parsers::kr_tsv::{parse_kr_tsv, probe_kr_tsv};
use super::parsers::mcgs_5col_csv::{parse_mcgs_5col_csv, probe_mcgs_5col_csv};
use super::parsers::temi2500_sdr::{parse_temi2500_sdr, probe_temi2500_sdr};
use super::parsers::utf8_11col_hmi_csv::{parse_utf8_11col_hmi_csv, probe_utf8_11col_hmi_csv};
use super::parsers::weintek_export::{parse_weintek_export, probe_weintek_export};

type ProbeFn = fn(&Path) -> Result<bool, AppError>;
type ParseFn = fn(&Path) -> Result<Dataset, AppError>;

#[derive(Clone, Copy)]
struct ParserDescriptor {
    rule: &'static ControllerRule,
    probe: ProbeFn,
    parse: ParseFn,
}

const PARSERS: &[ParserDescriptor] = &[
    ParserDescriptor {
        rule: &GUANGWUSUO_000_RULE,
        probe: probe_guangwusuo_000,
        parse: parse_guangwusuo_000,
    },
    ParserDescriptor {
        rule: &TEMI2500_SDR_RULE,
        probe: probe_temi2500_sdr,
        parse: parse_temi2500_sdr,
    },
    ParserDescriptor {
        rule: &WEINTEK_EXPORT_RULE,
        probe: probe_weintek_export,
        parse: parse_weintek_export,
    },
    ParserDescriptor {
        rule: &INT16_7COL_CSV_RULE,
        probe: probe_int16_7col_csv,
        parse: parse_int16_7col_csv,
    },
    ParserDescriptor {
        rule: &UTF8_11COL_HMI_CSV_RULE,
        probe: probe_utf8_11col_hmi_csv,
        parse: parse_utf8_11col_hmi_csv,
    },
    ParserDescriptor {
        rule: &GBK_4COL_TEMP_CSV_RULE,
        probe: probe_gbk_4col_temp_csv,
        parse: parse_gbk_4col_temp_csv,
    },
    ParserDescriptor {
        rule: &KR_TSV_RULE,
        probe: probe_kr_tsv,
        parse: parse_kr_tsv,
    },
    ParserDescriptor {
        rule: &KR_RCD_BIN_RULE,
        probe: probe_kr_rcd_bin,
        parse: parse_kr_rcd_bin,
    },
    ParserDescriptor {
        rule: &ATEC_H12_RULE,
        probe: probe_atec_h12,
        parse: parse_atec_h12,
    },
    ParserDescriptor {
        rule: &ATEC_6COL_CSV_RULE,
        probe: probe_atec_6col_csv,
        parse: parse_atec_6col_csv,
    },
    ParserDescriptor {
        rule: &MCGS_5COL_CSV_RULE,
        probe: probe_mcgs_5col_csv,
        parse: parse_mcgs_5col_csv,
    },
    ParserDescriptor {
        rule: &FREUD_S1_HISTORY_CSV_RULE,
        probe: probe_freud_s1_history_csv,
        parse: parse_freud_s1_history_csv,
    },
    ParserDescriptor {
        rule: &FREUD_HSHBKA_RULE,
        probe: probe_freud_hshbka,
        parse: parse_freud_hshbka,
    },
    ParserDescriptor {
        rule: &FREUD_HISTORY_CSV_RULE,
        probe: probe_freud_history_csv,
        parse: parse_freud_history_csv,
    },
    ParserDescriptor {
        rule: &FREUD_MDATA_ZIP_RULE,
        probe: probe_freud_mdata_zip,
        parse: parse_freud_mdata_zip,
    },
];

pub fn parse_file(path: &Path) -> Result<Dataset, AppError> {
    let parser = detect_parser(path)?;
    let dataset = (parser.parse)(path)?;

    if dataset.parser != parser.rule.parser_id || dataset.controller_rule != parser.rule.id {
        return Err(AppError::Parse(format!(
            "解析器 {} 返回了不一致的控制器规则",
            parser.rule.parser_id
        )));
    }

    Ok(dataset)
}

pub(crate) fn detected_rule_id(path: &Path) -> Result<&'static str, AppError> {
    Ok(detect_parser(path)?.rule.id)
}

fn detect_parser(path: &Path) -> Result<&'static ParserDescriptor, AppError> {
    let mut candidates = Vec::new();
    for (index, parser) in PARSERS.iter().enumerate() {
        if (parser.probe)(path)? {
            candidates.push(index);
        }
    }

    let Some(index) = unique_match_index(&candidates)? else {
        return Err(AppError::UnsupportedFormat(
            "无法可靠识别文件内容；当前支持广五所 .000、SAMWONTECH TEMI2500 .SDR、威纶通 EBPro 导出 CSV、阿泰可 CSV/.h12、三志 MCGS CSV、弗锐德 HSHBKA/MData zip 和汉测记录仪数据"
                .to_string(),
        ));
    };
    Ok(&PARSERS[index])
}

fn unique_match_index(candidates: &[usize]) -> Result<Option<usize>, AppError> {
    match candidates {
        [] => Ok(None),
        [index] => Ok(Some(*index)),
        _ => Err(AppError::UnsupportedFormat(
            "文件特征同时匹配多个解析规则，无法唯一识别".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::test_support::decode_sparse_hex;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

    struct TempFixture {
        path: PathBuf,
    }

    impl TempFixture {
        fn unique(extension: &str) -> Self {
            let sequence = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "chamber-data-viewer-registry-{}-{sequence}.{extension}",
                std::process::id()
            ));
            Self { path }
        }

        fn copy_from_repository(name: &str, extension: &str) -> Self {
            let fixture = Self::unique(extension);
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join(name);
            std::fs::copy(source, &fixture.path).unwrap();
            fixture
        }

        fn write_bytes(bytes: &[u8], extension: &str) -> Self {
            let fixture = Self::unique(extension);
            std::fs::write(&fixture.path, bytes).unwrap();
            fixture
        }

        fn write_guangwusuo(extension: &str, payload: &[u8]) -> Self {
            let fixture = Self::unique(extension);
            let file = std::fs::File::create(&fixture.path).unwrap();
            let mut archive = tar::Builder::new(file);
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive
                .append_data(&mut header, "tmp/usb/espec/SmpData.000", payload)
                .unwrap();
            archive.finish().unwrap();
            fixture
        }
    }

    impl Drop for TempFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn guangwusuo_payload() -> Vec<u8> {
        include_str!("../../tests/fixtures/guangwusuo-000-minimal.hex")
            .lines()
            .filter(|line| !line.trim_start().starts_with('#'))
            .flat_map(|line| line.split_whitespace())
            .map(|byte| u8::from_str_radix(byte, 16).unwrap())
            .collect()
    }

    fn temi2500_fixture_bytes() -> Vec<u8> {
        decode_sparse_hex(include_str!(
            "../../tests/fixtures/temi2500-sdr-minimal.hex"
        ))
    }

    #[test]
    fn detects_temi2500_content_without_relying_on_extension() {
        let fixture = TempFixture::write_bytes(&temi2500_fixture_bytes(), "dat");

        let dataset = parse_file(&fixture.path).unwrap();

        assert_eq!(dataset.parser, "samwontech-temi2500-sdr");
        assert_eq!(dataset.controller_rule, "samwontech-temi2500-sdr-v1");
    }

    #[test]
    fn detects_temi2500_rejects_random_bytes_with_an_sdr_extension() {
        let fixture = TempFixture::write_bytes(&vec![0x53; 512 * 2], "SDR");

        assert!(matches!(
            parse_file(&fixture.path),
            Err(AppError::UnsupportedFormat(_))
        ));
    }

    #[test]
    fn detects_guangwusuo_content_without_relying_on_extension() {
        let fixture = TempFixture::write_guangwusuo("dat", &guangwusuo_payload());
        let dataset = parse_file(&fixture.path).unwrap();

        assert_eq!(dataset.parser, "guangwusuo-000");
        assert_eq!(dataset.controller_rule, "guangwusuo-000-v1");
    }

    #[test]
    fn generic_csv_is_deferred_until_specific_formats_are_parsed() {
        let fixture = TempFixture::copy_from_repository("csv-standard-minimal.csv", "000");
        assert!(matches!(
            parse_file(&fixture.path),
            Err(AppError::UnsupportedFormat(message))
                if !message.contains("结构兼容的 CSV")
        ));
    }

    #[test]
    fn detects_weintek_export_content_without_relying_on_extension() {
        let fixture = TempFixture::copy_from_repository("weintek-export-minimal.csv", "dat");
        let dataset = parse_file(&fixture.path).unwrap();

        assert_eq!(dataset.parser, "weintek-export");
        assert_eq!(dataset.controller_rule, "weintek-export-v1");
    }

    #[test]
    fn detects_new_chamber_formats_by_content() {
        let int16 = TempFixture::write_bytes(
            br#""Date","Time","Millisecond","16-bit Signed","16-bit Signed","16-bit Signed","16-bit Signed"
"2026/08/02","00:00:18","480","500","499","500","496"
"2026/08/02","00:00:48","560","500","302","500","301"
"#
            ,
            "dat",
        );
        let dataset = parse_file(&int16.path).unwrap();
        assert_eq!(dataset.parser, "16bit-7col-csv");

        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(
            "\"Date\",\"Time\",\"控制温度\",\"控制湿度\",\"设定温度\",\"设定温度\",\"工作室温度\",\"TEMP 1\",\"TEMP 2\",\"TEMP 3\",\"TEMP 4\"\n\
             \"2026/07/02\",\"08:55:36\",\"225\",\"576\",\"200\",\"100\",\"0\",\"248\",\"238\",\"32767\",\"32767\"\n"
                .as_bytes(),
        );
        let eleven = TempFixture::write_bytes(&bytes, "csv");
        let dataset = parse_file(&eleven.path).unwrap();
        assert_eq!(dataset.parser, "utf8-11col-hmi-csv");

        let gbk = b"Date,Time,\xD4\xCB\xD0\xD0\xCE\xC2\xB6\xC8,\xC9\xE8\xB6\xA8\xCE\xC2\xB6\xC8\r\n2024/1/20,0:00:10,14.7,20\r\n"
            .to_vec();
        let gbk_fixture = TempFixture::write_bytes(&gbk, "csv");
        let dataset = parse_file(&gbk_fixture.path).unwrap();
        assert_eq!(dataset.parser, "gbk-4col-temp-csv");

        let tsv = TempFixture::write_bytes(
            b"TIME\tTEMP_PV\tTEMP_SV\tHUMI_PV\tHUMI_SV\n2026-06-23 11:12:19\t14.77\t100.00\t-99999.00\t-99999.00\n"
                ,
            "xls",
        );
        let dataset = parse_file(&tsv.path).unwrap();
        assert_eq!(dataset.parser, "kr-tsv");

        let mut bin = vec![0_u8; 48 + 20 * 2];
        bin[0..4].copy_from_slice(&48_u32.to_le_bytes());
        bin[0x0A..0x0C].copy_from_slice(&2026_u16.to_le_bytes());
        bin[0x0E] = 6;
        bin[0x0F] = 23;
        bin[0x10] = 11;
        bin[0x11] = 12;
        bin[0x12] = 19;
        bin[0x16..0x18].copy_from_slice(&60_u16.to_le_bytes());
        for (index, (elapsed, value)) in [(0_u32, 14.77_f32), (4, 14.87)].iter().enumerate() {
            let offset = 48 + index * 20;
            bin[offset..offset + 4].copy_from_slice(&elapsed.to_le_bytes());
            bin[offset + 4..offset + 8].copy_from_slice(&value.to_le_bytes());
            bin[offset + 8..offset + 12].copy_from_slice(&100.0_f32.to_le_bytes());
            bin[offset + 12..offset + 16].copy_from_slice(&(-99999.0_f32).to_le_bytes());
            bin[offset + 16..offset + 20].copy_from_slice(&(-99999.0_f32).to_le_bytes());
        }
        let bin_fixture = TempFixture::write_bytes(&bin, "bin");
        let dataset = parse_file(&bin_fixture.path).unwrap();
        assert_eq!(dataset.parser, "kr-rcd-bin");
    }

    #[test]
    fn deferred_generic_csv_is_rejected_before_any_value_parsing() {
        for extension in ["000", "dat"] {
            let fixture = TempFixture::write_bytes(
                "时间戳,目标温度,当前温度,目标湿度,当前湿度\n\
             2026-01-01 00:00:00,,invalid,NaN,inf\n\
             2026-01-01 00:01:00,NaN,+inf,-inf,garbage\n"
                    .as_bytes(),
                extension,
            );

            assert!(matches!(
                parse_file(&fixture.path),
                Err(AppError::UnsupportedFormat(_))
            ));
        }
    }

    #[test]
    fn rejects_a_fake_000_file_by_content() {
        let fixture = TempFixture::write_bytes(b"not a supported data file", "000");
        let result = parse_file(&fixture.path);

        assert!(matches!(
            result,
            Err(AppError::UnsupportedFormat(message))
                if message.contains("广五所 .000")
                    && message.contains("威纶通")
                    && message.contains("CSV")
                    && message.contains("阿泰可")
                    && message.contains("汉测")
        ));
    }

    #[test]
    fn rejects_binary_archive_without_a_plausible_record() {
        let payload = vec![0_u8; 24 + 18];
        let fixture = TempFixture::write_guangwusuo("000", &payload);
        let result = parse_file(&fixture.path);

        assert!(matches!(result, Err(AppError::UnsupportedFormat(_))));
    }

    #[test]
    fn rejects_multiple_content_matches_instead_of_using_registry_order() {
        assert!(matches!(
            unique_match_index(&[0, 1]),
            Err(AppError::UnsupportedFormat(message)) if message.contains("无法唯一识别")
        ));
    }

    #[test]
    fn no_content_match_returns_none() {
        assert_eq!(unique_match_index(&[]).unwrap(), None);
    }

    #[test]
    fn one_content_match_returns_its_index() {
        assert_eq!(unique_match_index(&[1]).unwrap(), Some(1));
    }

    #[test]
    fn rejects_a_fake_csv_file_by_content() {
        let fixture = TempFixture::write_bytes(b"plain text", "csv");
        assert!(matches!(
            parse_file(&fixture.path),
            Err(AppError::UnsupportedFormat(_))
        ));
    }
}
