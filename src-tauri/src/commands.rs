use std::path::PathBuf;

use crate::data::dataset_loader::load_dataset_paths;
use crate::data::errors::AppError;
use crate::data::model::Dataset;

#[tauri::command]
pub async fn load_dataset(paths: Vec<String>) -> Result<Dataset, AppError> {
    let paths = paths.into_iter().map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || load_dataset_paths(paths))
        .await
        .map_err(|error| AppError::Parse(format!("后台数据读取任务失败：{error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

    struct TempFixture {
        path: PathBuf,
    }

    impl TempFixture {
        fn copy_from_repository(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "chamber-data-viewer-command-{}-{unique}-{sequence}.dat",
                std::process::id()
            ));
            let fixture = Self { path };
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join(name);

            std::fs::copy(source, &fixture.path).unwrap();
            fixture
        }

        fn command_path(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    #[test]
    fn command_auto_detects_supported_content_with_a_non_original_extension() {
        let fixture = TempFixture::copy_from_repository("weintek-export-minimal.csv");

        let dataset =
            tauri::async_runtime::block_on(load_dataset(vec![fixture.command_path()])).unwrap();

        assert_eq!(dataset.row_count, 3);
        assert_eq!(dataset.parser, "weintek-export");
        assert_eq!(dataset.controller_rule, "weintek-export-v1");
    }

    #[test]
    fn command_reports_missing_files() {
        let result =
            tauri::async_runtime::block_on(load_dataset(vec!["missing-file.000".to_string()]));
        assert!(matches!(result, Err(AppError::Io(_))));
    }

    #[test]
    fn command_rejects_an_empty_path_group() {
        let result = tauri::async_runtime::block_on(load_dataset(Vec::new()));

        assert!(matches!(
            result,
            Err(AppError::UnsupportedFormat(message)) if message.contains("未选择")
        ));
    }
}
