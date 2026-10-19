use std::io;
use std::path::Path;

use serde::Serialize;


pub fn normalized_source_id(path: &Path) -> io::Result<String> {
    let canonical_path = std::fs::canonicalize(path)?;
    source_id_from_canonical_path(&canonical_path, cfg!(windows))
}

pub fn dataset_source(path: &Path) -> io::Result<DatasetSource> {
    Ok(DatasetSource {
        source_id: normalized_source_id(path)?,
        source_file: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_string(),
    })
}

fn source_id_from_canonical_path(path: &Path, windows: bool) -> io::Result<String> {
    let value = path.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "source path is not valid UTF-8")
    })?;

    Ok(if windows {
        normalize_windows_canonical_path(value)
            .replace('\\', "/")
            .to_lowercase()
    } else {
        value.to_string()
    })
}

/// `std::fs::canonicalize` 在 Windows 上返回带 `\\?\` 扩展长度前缀的 verbatim 路径
/// （本地盘形如 `\\?\C:\...`，UNC 形如 `\\?\UNC\host\share`）。该前缀是文件系统
/// API 语法而不是路径内容，展示给用户前需要去掉；否则规范化后会变成 `//?/c:/...`。
fn normalize_windows_canonical_path(value: &str) -> String {
    const VERBATIM_PREFIX: &str = r"\\?\";
    const UNC_MARKER: &str = "UNC\\";
    let Some(rest) = value.strip_prefix(VERBATIM_PREFIX) else {
        return value.to_string();
    };
    if let Some(share) = rest.strip_prefix(UNC_MARKER) {
        format!("//{share}")
    } else {
        rest.to_string()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSource {
    pub source_id: String,
    pub source_file: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    pub source_id: String,
    pub source_file: String,
    pub sources: Vec<DatasetSource>,
    pub parser: String,
    pub controller_rule: String,
    pub time_range: TimeRange,
    pub row_count: usize,
    pub axes: Vec<Axis>,
    pub series: Vec<Series>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Axis {
    pub id: String,
    pub role: String,
    pub name: String,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub id: String,
    pub name: String,
    pub unit: String,
    pub role: String,
    pub axis_id: String,
    pub points: Vec<DataPoint>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DataPoint(pub String, pub Option<f64>);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    InvalidMeasurement,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<DiagnosticCode>,
    pub level: String,
    pub message: String,
}

impl Diagnostic {
    pub fn info(message: impl Into<String>) -> Self {
        Self {
            code: None,
            level: "info".to_string(),
            message: message.into(),
        }
    }

    pub fn warning(message: impl Into<String>) -> Self {
        Self {
            code: None,
            level: "warning".to_string(),
            message: message.into(),
        }
    }

    pub fn invalid_measurement(message: impl Into<String>) -> Self {
        Self {
            code: Some(DiagnosticCode::InvalidMeasurement),
            level: "warning".to_string(),
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_source_id_preserves_backslashes() {
        let source_id = source_id_from_canonical_path(Path::new(r"/tmp/a\b.csv"), false).unwrap();

        assert_eq!(source_id, r"/tmp/a\b.csv");
    }

    #[test]
    fn windows_source_id_normalizes_separators_and_case() {
        let source_id =
            source_id_from_canonical_path(Path::new(r"C:\Fixtures\MixedCase\Sample.CSV"), true)
                .unwrap();

        assert_eq!(source_id, "c:/fixtures/mixedcase/sample.csv");
    }

    #[test]
    fn windows_source_id_strips_the_verbatim_extended_length_prefix() {
        let drive_path = source_id_from_canonical_path(
            Path::new(r"\\?\C:\Users\Home-PC\Desktop\Sample.000"),
            true,
        )
        .unwrap();
        assert_eq!(drive_path, "c:/users/home-pc/desktop/sample.000");

        let unc_path =
            source_id_from_canonical_path(Path::new(r"\\?\UNC\server\share\a.SDR"), true).unwrap();
        assert_eq!(unc_path, "//server/share/a.sdr");
    }

    #[test]
    fn invalid_measurement_serializes_with_a_stable_code() {
        let diagnostic = Diagnostic::invalid_measurement("实测湿度有 2 个无效值，已按缺失数据处理");
        let json = serde_json::to_value(diagnostic).unwrap();

        assert_eq!(json["code"], "invalid_measurement");
        assert_eq!(json["level"], "warning");
    }

    #[test]
    fn routine_diagnostics_do_not_serialize_a_code() {
        let diagnostic = Diagnostic::info("时间顺序已整理");
        let json = serde_json::to_value(diagnostic).unwrap();

        assert!(json.get("code").is_none());
    }

    #[test]
    fn normalized_source_id_propagates_missing_path_errors() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "chamber-data-viewer-{}-{unique}-missing.csv",
            std::process::id()
        ));

        let error = normalized_source_id(&path).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn dataset_source_uses_canonical_identity_and_file_name() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("csv-standard-minimal.csv");
        let source = dataset_source(&path).unwrap();

        assert!(source
            .source_id
            .ends_with("/src-tauri/tests/fixtures/csv-standard-minimal.csv"));
        assert_eq!(source.source_file, "csv-standard-minimal.csv");
        assert_eq!(
            serde_json::to_value(&source).unwrap()["sourceFile"],
            "csv-standard-minimal.csv"
        );
    }
}
