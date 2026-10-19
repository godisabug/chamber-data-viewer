use chrono::NaiveDateTime;
use std::collections::HashMap;

use crate::data::controller_rules::ControllerRule;
use crate::data::errors::AppError;
use crate::data::model::{Dataset, DatasetSource, Diagnostic, TimeRange};
use crate::data::series_builder::make_optional_series;

/// 语义顺序采样行：`values[i]` 对应 `rule.series[i]`。
#[derive(Clone)]
pub struct TimedRow {
    pub timestamp: NaiveDateTime,
    pub values: Vec<Option<f64>>,
    /// 合成断点行（用于停录间断），不参与 row_count 统计。
    pub synthetic: bool,
}

pub fn format_seconds(timestamp: NaiveDateTime) -> String {
    timestamp.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 解析 `2026/4/21` 与 `10:02:03` 形式的日期时间（允许非零填充）。
pub fn parse_slash_date_time(date: &str, time: &str) -> Result<NaiveDateTime, AppError> {
    let mut date_parts = date.split('/');
    let year = parse_slash_part(date_parts.next())? as i32;
    let month = parse_slash_part(date_parts.next())?;
    let day = parse_slash_part(date_parts.next())?;
    if date_parts.next().is_some() {
        return Err(AppError::Parse(format!("日期字段无法解析：{date:?}")));
    }
    let mut time_parts = time.split(':');
    let hour = parse_slash_part(time_parts.next())?;
    let minute = parse_slash_part(time_parts.next())?;
    let second = parse_slash_part(time_parts.next())?;
    if time_parts.next().is_some() {
        return Err(AppError::Parse(format!("时间字段无法解析：{time:?}")));
    }
    let date = chrono::NaiveDate::from_ymd_opt(year, month, day)
        .ok_or_else(|| AppError::Parse(format!("日期超出范围：{date:?}")))?;
    let time = chrono::NaiveTime::from_hms_opt(hour, minute, second)
        .ok_or_else(|| AppError::Parse(format!("时间超出范围：{time:?}")))?;
    Ok(date.and_time(time))
}

/// 解析 `2026/05/29 03:41:40` 形式的单个时间戳字段。
pub fn parse_slash_datetime(value: &str) -> Result<NaiveDateTime, AppError> {
    let (date, time) = value
        .trim()
        .split_once(' ')
        .ok_or_else(|| AppError::Parse(format!("时间戳缺少日期与时间分隔：{value:?}")))?;
    parse_slash_date_time(date, time)
}

fn parse_slash_part(value: Option<&str>) -> Result<u32, AppError> {
    value
        .ok_or_else(|| AppError::Parse("日期时间字段缺失".to_string()))?
        .trim()
        .parse::<u32>()
        .map_err(|_| AppError::Parse("日期时间字段无法解析".to_string()))
}

/// 按内容推断主导采样周期（四舍五入到整秒），无稳定周期时返回 None。
pub fn infer_period_millis(rows: &[TimedRow]) -> Option<i64> {
    if rows.len() < 2 {
        return None;
    }
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for pair in rows.windows(2) {
        let delta = pair[1]
            .timestamp
            .signed_duration_since(pair[0].timestamp)
            .num_milliseconds();
        if delta <= 0 {
            continue;
        }
        let rounded = ((delta as f64 / 1_000.0).round() as i64) * 1_000;
        if (1_000..=3_600_000).contains(&rounded) {
            *counts.entry(rounded).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(period, _)| period)
}

pub fn build_dataset(
    source: DatasetSource,
    sources: Vec<DatasetSource>,
    rule: &ControllerRule,
    rows: &[TimedRow],
    diagnostics: Vec<Diagnostic>,
) -> Result<Dataset, AppError> {
    rule.validate()?;
    let Some(first) = rows.first() else {
        return Err(AppError::NoDisplayableData(format!(
            "{} 中没有采样行",
            source.source_file
        )));
    };
    let last = rows.last().expect("rows 已确认非空");

    let mut series = Vec::with_capacity(rule.series.len());
    for (index, series_rule) in rule.series.iter().enumerate() {
        if let Some(item) = make_optional_series(
            series_rule,
            rows,
            |row| format_seconds(row.timestamp),
            |row| row.values.get(index).copied().flatten(),
        ) {
            series.push(item);
        }
    }
    if series.is_empty() {
        return Err(AppError::NoDisplayableData(format!(
            "{} 中没有任何有效的温湿度数值",
            source.source_file
        )));
    }

    Ok(Dataset {
        source_id: source.source_id,
        source_file: source.source_file,
        sources,
        parser: rule.parser_id.to_string(),
        controller_rule: rule.id.to_string(),
        time_range: TimeRange {
            start: format_seconds(first.timestamp),
            end: format_seconds(last.timestamp),
        },
        row_count: rows.iter().filter(|row| !row.synthetic).count(),
        axes: rule.axis_definitions(),
        series,
        diagnostics,
    })
}
