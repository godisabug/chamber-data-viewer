use std::fs::File;
use std::io::Read;
use std::path::Path;

use chrono::NaiveDateTime;
use csv::StringRecord;

use crate::data::controller_rules::{FieldSourceRule, WEINTEK_EXPORT_RULE};
use crate::data::errors::AppError;
use crate::data::model::{dataset_source, Dataset, DatasetSource};

const CHANNEL_COUNT: usize = 4;
const PROBE_RECORD_LIMIT: usize = 64;
const MAX_TOTAL_PROBE_RECORDS: usize = 256;
const MAX_PROBE_BYTES: u64 = 256 * 1024;
const MIN_PERIOD_MILLIS: i64 = 1_000;
const MAX_PERIOD_MILLIS: i64 = 3_600_000;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WeintekRow {
    pub timestamp: NaiveDateTime,
    /// 语义顺序：设定温度、实测温度、设定湿度、实测湿度。
    pub values: [Option<f64>; CHANNEL_COUNT],
}

#[derive(Debug, Clone)]
pub(crate) struct WeintekSourceRows {
    pub source: DatasetSource,
    pub period_millis: i64,
    pub rows: Vec<WeintekRow>,
    pub invalid_counts: [usize; CHANNEL_COUNT],
}

#[derive(Debug, Clone, Copy)]
struct ParsedNumber {
    value: Option<f64>,
    invalid: bool,
}

pub fn probe_weintek_export(path: &Path) -> Result<bool, AppError> {
    let file = File::open(path)?;
    let mut reader = csv::ReaderBuilder::new().from_reader(file.take(MAX_PROBE_BYTES));
    let headers = match reader.headers() {
        Ok(headers) => headers,
        Err(_) => return Ok(false),
    };
    if !is_weintek_header(headers) {
        return Ok(false);
    }
    let columns = match semantic_columns() {
        Ok(columns) => columns,
        Err(_) => return Ok(false),
    };

    let mut total_records = 0;
    let mut examined_records = 0;
    let mut has_valid_timestamp = false;
    for record_result in reader.records() {
        let record = match record_result {
            Ok(record) => record,
            Err(_) => return Ok(false),
        };
        total_records += 1;
        let date = record.get(0).unwrap_or("").trim();
        let time = record.get(1).unwrap_or("").trim();
        if !date.is_empty() && !time.is_empty() {
            examined_records += 1;
            if parse_timestamp(date, time, record.get(2).unwrap_or("")).is_ok() {
                has_valid_timestamp = true;
                let has_finite_value = columns
                    .iter()
                    .any(|column| parse_number(record.get(*column)).value.is_some());
                if has_finite_value {
                    return Ok(true);
                }
            }
        }

        if total_records == MAX_TOTAL_PROBE_RECORDS || examined_records == PROBE_RECORD_LIMIT {
            break;
        }
    }

    Ok(has_valid_timestamp)
}

pub(crate) fn parse_weintek_export_rows(path: &Path) -> Result<WeintekSourceRows, AppError> {
    WEINTEK_EXPORT_RULE.validate()?;
    let source = dataset_source(path)?;
    let mut reader = csv::ReaderBuilder::new().from_path(path)?;
    let headers = reader.headers()?;
    if !is_weintek_header(headers) {
        return Err(AppError::Parse(format!(
            "文件 {}：不是威纶通 EBPro 导出的标准 7 列 CSV",
            source.source_file
        )));
    }
    let columns = semantic_columns()?;

    let mut rows = Vec::new();
    let mut invalid_counts = [0_usize; CHANNEL_COUNT];
    for (row_index, record_result) in reader.records().enumerate() {
        let record = record_result.map_err(|error| {
            AppError::Parse(format!(
                "文件 {} 的第 {} 行解析失败：{error}",
                source.source_file,
                row_index + 2
            ))
        })?;
        if let Some((row, invalid_flags)) = parse_record(&record, columns)? {
            for (count, invalid) in invalid_counts.iter_mut().zip(invalid_flags) {
                if invalid {
                    *count += 1;
                }
            }
            rows.push(row);
        }
    }

    if rows.is_empty() {
        return Err(AppError::NoDisplayableData(format!(
            "{} 中没有威纶通采样行",
            source.source_file
        )));
    }
    validate_monotonic(&source, &rows)?;
    let period_millis = infer_period_millis(&source.source_file, &rows)?;

    Ok(WeintekSourceRows {
        source,
        period_millis,
        rows,
        invalid_counts,
    })
}

pub fn parse_weintek_export(path: &Path) -> Result<Dataset, AppError> {
    let source = parse_weintek_export_rows(path)?;
    crate::data::weintek_merge::merge_weintek_sources(vec![source])
}

pub(crate) fn format_weintek_timestamp(timestamp: NaiveDateTime) -> String {
    if timestamp.and_utc().timestamp_subsec_millis() == 0 {
        timestamp.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        timestamp.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
    }
}

fn is_weintek_header(headers: &StringRecord) -> bool {
    headers.len() == 7
        && headers.iter().enumerate().all(|(index, header)| {
            let normalized = header.trim_start_matches('\u{feff}').trim();
            match index {
                0 => normalized == "Date",
                1 => normalized == "Time",
                2 => normalized == "Millisecond",
                _ => normalized == "32-bit Float",
            }
        })
}

fn semantic_columns() -> Result<[usize; CHANNEL_COUNT], AppError> {
    let mut columns = [0_usize; CHANNEL_COUNT];
    for (semantic, series) in WEINTEK_EXPORT_RULE.series.iter().enumerate() {
        let FieldSourceRule::Column(column) = series.source else {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 的曲线 {} 未配置 CSV 列号",
                WEINTEK_EXPORT_RULE.id, series.id
            )));
        };
        columns[semantic] = column;
    }
    Ok(columns)
}

fn parse_record(
    record: &StringRecord,
    columns: [usize; CHANNEL_COUNT],
) -> Result<Option<(WeintekRow, [bool; CHANNEL_COUNT])>, AppError> {
    let date = record.get(0).unwrap_or("").trim();
    let time = record.get(1).unwrap_or("").trim();
    if date.is_empty() || time.is_empty() {
        return Ok(None);
    }

    let timestamp = parse_timestamp(date, time, record.get(2).unwrap_or(""))?;
    let mut values = [None; CHANNEL_COUNT];
    let mut invalid = [false; CHANNEL_COUNT];
    for semantic in 0..CHANNEL_COUNT {
        let parsed = parse_number(record.get(columns[semantic]));
        values[semantic] = parsed.value;
        invalid[semantic] = parsed.invalid;
    }

    Ok(Some((WeintekRow { timestamp, values }, invalid)))
}

fn parse_timestamp(date: &str, time: &str, millisecond: &str) -> Result<NaiveDateTime, AppError> {
    let millisecond = millisecond.trim();
    let millisecond: u32 = millisecond
        .parse()
        .map_err(|_| AppError::Parse(format!("毫秒字段无法解析：{millisecond:?}")))?;
    if millisecond > 999 {
        return Err(AppError::Parse(format!("毫秒字段超出范围：{millisecond}")));
    }
    NaiveDateTime::parse_from_str(
        &format!("{date} {time}.{millisecond:03}"),
        "%Y/%m/%d %H:%M:%S%.3f",
    )
    .map_err(|error| AppError::Parse(format!("时间戳解析失败：{error}")))
}

fn parse_number(value: Option<&str>) -> ParsedNumber {
    let text = value.unwrap_or("").trim();
    if text.is_empty() {
        return ParsedNumber {
            value: None,
            invalid: false,
        };
    }

    match text.parse::<f64>() {
        Ok(value) if value.is_finite() => ParsedNumber {
            value: Some(value),
            invalid: false,
        },
        _ => ParsedNumber {
            value: None,
            invalid: true,
        },
    }
}

fn validate_monotonic(source: &DatasetSource, rows: &[WeintekRow]) -> Result<(), AppError> {
    for pair in rows.windows(2) {
        if pair[0].timestamp >= pair[1].timestamp {
            return Err(AppError::Parse(format!(
                "文件 {}：威纶通采样时间必须严格递增，{} 后出现 {}",
                source.source_file,
                format_weintek_timestamp(pair[0].timestamp),
                format_weintek_timestamp(pair[1].timestamp)
            )));
        }
    }
    Ok(())
}

fn infer_period_millis(source_file: &str, rows: &[WeintekRow]) -> Result<i64, AppError> {
    if rows.len() < 2 {
        return Err(AppError::Parse(format!(
            "文件 {source_file}：威纶通 CSV 至少需要 2 个采样行才能推断采样周期"
        )));
    }

    let mut rounded_deltas = rows
        .windows(2)
        .map(|pair| {
            let delta_millis = pair[1]
                .timestamp
                .signed_duration_since(pair[0].timestamp)
                .num_milliseconds();
            ((delta_millis + 500) / 1_000 * 1_000).max(MIN_PERIOD_MILLIS)
        })
        .collect::<Vec<_>>();
    rounded_deltas.sort_unstable();

    let mut best_period = 0;
    let mut best_count = 0;
    let mut index = 0;
    while index < rounded_deltas.len() {
        let period = rounded_deltas[index];
        let mut count = 1;
        while index + count < rounded_deltas.len() && rounded_deltas[index + count] == period {
            count += 1;
        }
        if count > best_count {
            best_count = count;
            best_period = period;
        }
        index += count;
    }

    if !(MIN_PERIOD_MILLIS..=MAX_PERIOD_MILLIS).contains(&best_period) {
        return Err(AppError::Parse(format!(
            "文件 {source_file}：推断的威纶通采样周期 {best_period} 毫秒超出合理范围"
        )));
    }
    Ok(best_period)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    static NEXT_TEMP_WEINTEK_ID: AtomicU64 = AtomicU64::new(0);

    struct TempWeintek {
        path: PathBuf,
    }

    impl TempWeintek {
        fn write(contents: &str) -> Self {
            let sequence = NEXT_TEMP_WEINTEK_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "chamber-data-viewer-weintek-{}-{sequence}.csv",
                std::process::id()
            ));
            std::fs::write(&path, contents).unwrap();
            Self { path }
        }
    }

    impl Drop for TempWeintek {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    #[test]
    fn repository_fixture_parses_with_expected_series_and_values() {
        let dataset = parse_weintek_export(&fixture_path("weintek-export-minimal.csv")).unwrap();

        assert_eq!(dataset.parser, "weintek-export");
        assert_eq!(dataset.controller_rule, "weintek-export-v1");
        assert_eq!(dataset.sources.len(), 1);
        assert_eq!(dataset.source_file, "weintek-export-minimal.csv");
        assert_eq!(dataset.row_count, 3);
        assert_eq!(dataset.time_range.start, "2026-06-08 00:14:16.690");
        assert_eq!(dataset.time_range.end, "2026-06-08 00:15:16.550");

        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        let set_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "set-temp")
            .unwrap();
        let actual_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-humidity")
            .unwrap();
        let set_humidity = dataset
            .series
            .iter()
            .find(|series| series.id == "set-humidity")
            .unwrap();
        assert_eq!(actual_temp.points[0].1, Some(20.50898));
        assert_eq!(set_temp.points[0].1, Some(20.93333));
        assert_eq!(actual_humidity.points[0].1, Some(84.43545));
        assert_eq!(set_humidity.points[1].1, Some(59.995));
    }

    #[test]
    fn probe_recognizes_the_repository_fixture_without_relying_on_extension() {
        let fixture = TempWeintek::write(include_str!(
            "../../../tests/fixtures/weintek-export-minimal.csv"
        ));

        assert!(probe_weintek_export(&fixture.path).unwrap());
    }

    #[test]
    fn probe_rejects_headers_without_a_credible_data_record() {
        let fixture = TempWeintek::write(
            "\"Date\",\"Time\",\"Millisecond\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\"\n\
             \"2026/06/08\",\"not-a-time\",\"690\",\"20.5\",\"84.4\",\"20.9\",\"0\"\n",
        );

        assert!(!probe_weintek_export(&fixture.path).unwrap());
    }

    #[test]
    fn probe_rejects_other_csv_structures() {
        let generic = TempWeintek::write(
            "时间戳,目标温度,当前温度,目标湿度,当前湿度\n\
             2026-01-01 00:00:00,25,24,60,59\n",
        );
        let wrong_column_count = TempWeintek::write(
            "\"Date\",\"Time\",\"Millisecond\",\"32-bit Float\"\n\
             \"2026/06/08\",\"00:14:16\",\"690\",\"20.5\"\n",
        );

        assert!(!probe_weintek_export(&generic.path).unwrap());
        assert!(!probe_weintek_export(&wrong_column_count.path).unwrap());
    }

    #[test]
    fn parse_rejects_unequal_record_widths() {
        let fixture = TempWeintek::write(
            "\"Date\",\"Time\",\"Millisecond\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\"\n\
             \"2026/06/08\",\"00:14:16\",\"690\",\"20.5\",\"84.4\"\n",
        );

        assert!(matches!(
            parse_weintek_export(&fixture.path),
            Err(AppError::Parse(message)) if message.contains("第 2 行")
        ));
    }

    #[test]
    fn millisecond_field_is_padded_to_three_digits() {
        let fixture = TempWeintek::write(
            "\"Date\",\"Time\",\"Millisecond\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\"\n\
             \"2026/06/08\",\"00:14:16\",\"0\",\"20.5\",\"84.4\",\"20.9\",\"0\"\n\
             \"2026/06/08\",\"00:14:46\",\"60\",\"21.7\",\"85.3\",\"20.9\",\"0\"\n",
        );
        let dataset = parse_weintek_export(&fixture.path).unwrap();

        assert_eq!(dataset.time_range.start, "2026-06-08 00:14:16");
        assert_eq!(dataset.time_range.end, "2026-06-08 00:14:46.060");
    }

    #[test]
    fn invalid_or_non_finite_numeric_cells_become_gaps_with_diagnostics() {
        let fixture = TempWeintek::write(
            "\"Date\",\"Time\",\"Millisecond\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\"\n\
             \"2026/06/08\",\"00:14:16\",\"690\",\"invalid\",\"84.4\",\"NaN\",\"0\"\n\
             \"2026/06/08\",\"00:14:46\",\"500\",\"21.7\",\"inf\",\"20.9\",\"59.995\"\n",
        );
        let dataset = parse_weintek_export(&fixture.path).unwrap();

        let actual_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "actual-temp")
            .unwrap();
        let set_temp = dataset
            .series
            .iter()
            .find(|series| series.id == "set-temp")
            .unwrap();
        assert_eq!(actual_temp.points[0].1, None);
        assert_eq!(set_temp.points[0].1, None);
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message == "实测温度有 1 个无效值（涉及 1 个文件），已按缺失数据处理"
        }));
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message == "设定温度有 1 个无效值（涉及 1 个文件），已按缺失数据处理"
        }));
    }

    #[test]
    fn all_invalid_or_non_finite_values_return_no_displayable_data() {
        let fixture = TempWeintek::write(
            "\"Date\",\"Time\",\"Millisecond\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\"\n\
             \"2026/06/08\",\"00:14:16\",\"690\",\"invalid\",\"NaN\",\"inf\",\"garbage\"\n\
             \"2026/06/08\",\"00:14:46\",\"500\",\"NaN\",\"+inf\",\"-inf\",\"garbage\"\n",
        );

        assert!(matches!(
            parse_weintek_export(&fixture.path),
            Err(AppError::NoDisplayableData(message)) if message.contains("没有任何有效的温湿度数值")
        ));
    }

    #[test]
    fn rejects_non_monotonic_rows_with_the_file_name() {
        let fixture = TempWeintek::write(
            "\"Date\",\"Time\",\"Millisecond\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\",\"32-bit Float\"\n\
             \"2026/06/08\",\"00:14:46\",\"500\",\"21.7\",\"85.3\",\"20.9\",\"0\"\n\
             \"2026/06/08\",\"00:14:16\",\"690\",\"20.5\",\"84.4\",\"20.9\",\"0\"\n",
        );

        assert!(matches!(
            parse_weintek_export(&fixture.path),
            Err(AppError::Parse(message))
                if message.contains("严格递增") && message.contains("weintek")
        ));
    }

    #[test]
    fn period_inference_rounds_the_dominant_delta_to_a_second() {
        let source = WeintekSourceRows {
            source: DatasetSource {
                source_id: "canonical:/fixtures/a.csv".to_string(),
                source_file: "a.csv".to_string(),
            },
            period_millis: 0,
            rows: vec![
                WeintekRow {
                    timestamp: NaiveDateTime::parse_from_str(
                        "2026-06-08 00:14:16.690",
                        "%Y-%m-%d %H:%M:%S%.3f",
                    )
                    .unwrap(),
                    values: [Some(20.0); 4],
                },
                WeintekRow {
                    timestamp: NaiveDateTime::parse_from_str(
                        "2026-06-08 00:14:46.500",
                        "%Y-%m-%d %H:%M:%S%.3f",
                    )
                    .unwrap(),
                    values: [Some(20.0); 4],
                },
                WeintekRow {
                    timestamp: NaiveDateTime::parse_from_str(
                        "2026-06-08 00:15:46.550",
                        "%Y-%m-%d %H:%M:%S%.3f",
                    )
                    .unwrap(),
                    values: [Some(20.0); 4],
                },
            ],
            invalid_counts: [0; 4],
        };

        assert_eq!(infer_period_millis("a.csv", &source.rows).unwrap(), 30_000);
    }

    #[test]
    fn rejects_a_period_outside_the_reasonable_range() {
        let rows = vec![
            WeintekRow {
                timestamp: NaiveDateTime::parse_from_str(
                    "2026-06-08 00:00:00",
                    "%Y-%m-%d %H:%M:%S",
                )
                .unwrap(),
                values: [Some(20.0); 4],
            },
            WeintekRow {
                timestamp: NaiveDateTime::parse_from_str(
                    "2026-06-09 00:00:00",
                    "%Y-%m-%d %H:%M:%S",
                )
                .unwrap(),
                values: [Some(20.0); 4],
            },
        ];

        assert!(infer_period_millis("a.csv", &rows).is_err());
    }

    #[test]
    #[ignore = "requires CHAMBER_WEINTEK_ROOT with the private Weintek production samples"]
    fn external_weintek_folder_parses_and_merges_every_sample() {
        let root = std::env::var_os("CHAMBER_WEINTEK_ROOT")
            .expect("请设置 CHAMBER_WEINTEK_ROOT 指向真实威纶通样本根目录后再运行此 ignored 测试");
        let root = PathBuf::from(root);
        assert!(
            root.is_dir(),
            "CHAMBER_WEINTEK_ROOT 不是目录：{}",
            root.display()
        );

        let mut paths = std::fs::read_dir(&root)
            .expect("无法读取威纶通样本根目录")
            .map(|entry| entry.expect("无法读取威纶通样本目录项"))
            .filter(|entry| {
                let path = entry.path();
                entry
                    .file_type()
                    .expect("无法读取威纶通样本文件类型")
                    .is_file()
                    && path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"))
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        paths.sort();
        assert_eq!(paths.len(), 90, "威纶通样本目录的 CSV 文件数量不符合预期");

        let started = Instant::now();
        let mut sources = Vec::with_capacity(paths.len());
        for path in &paths {
            let source = parse_weintek_export_rows(path)
                .unwrap_or_else(|error| panic!("威纶通文件 {} 解析失败：{error}", path.display()));
            assert_eq!(
                source.period_millis, 30_000,
                "文件 {} 的采样周期不是 30 秒",
                source.source.source_file
            );
            sources.push(source);
        }
        let dataset = crate::data::weintek_merge::merge_weintek_sources(sources).unwrap();
        let elapsed = started.elapsed();
        eprintln!(
            "external Weintek merge: files={}, rows={}, elapsed={elapsed:?}",
            paths.len(),
            dataset.row_count
        );

        assert_eq!(dataset.sources.len(), 90);
        assert_eq!(dataset.row_count, 149_152);
        assert_eq!(dataset.time_range.start, "2026-06-08 00:14:16.690");
        assert_eq!(dataset.time_range.end, "2026-08-07 16:48:46.750");
        assert!(dataset.diagnostics.iter().any(|diagnostic| {
            diagnostic.message.contains("9 个停录间断")
                && diagnostic.message.contains("25,636 个采样点")
        }));
        assert!(
            !dataset
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.contains("去重")),
            "真实样本不应存在重复时间点"
        );
    }
}
