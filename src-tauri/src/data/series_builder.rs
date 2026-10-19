use super::controller_rules::{physical_valid_range, SeriesRule};
use super::model::{DataPoint, Series};

/// 将原始读数按系列规则解析为有效读数：
/// - 规则声明 0 为缺失（`zero_as_missing`，如设定通道“未控制/未设置”）时按缺失处理；
/// - 超出物理有效值域 (min, max] 的读数按缺失处理（如 0%RH、>100%RH 的湿度不可能是真实测量值）。
///
/// 所有曲线构建路径（含广五所解析器）共用此函数，保证规则一致。
pub fn effective_reading(rule: &SeriesRule, raw: Option<f64>) -> Option<f64> {
    let value = raw?;
    if rule.zero_as_missing && value == 0.0 {
        return None;
    }
    if let Some((min, max)) = physical_valid_range(rule.unit) {
        if value <= min || value > max {
            return None;
        }
    }
    Some(value)
}

pub fn make_optional_series<T>(
    rule: &SeriesRule,
    rows: &[T],
    timestamp: impl Fn(&T) -> String,
    value: impl Fn(&T) -> Option<f64>,
) -> Option<Series> {
    let effective_value = |row: &T| effective_reading(rule, value(row));
    if !rows.iter().any(|row| effective_value(row).is_some()) {
        return None;
    }
    let points: Vec<DataPoint> = rows
        .iter()
        .map(|row| DataPoint(timestamp(row), effective_value(row)))
        .collect();
    Some(Series {
        id: rule.id.to_string(),
        name: rule.name.to_string(),
        unit: rule.unit.to_string(),
        role: rule.role.to_string(),
        axis_id: rule.axis_id.to_string(),
        points,
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::data::controller_rules::{FieldSourceRule, GUANGWUSUO_000_RULE};

    const HUMIDITY_RULE: SeriesRule = SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Word(0),
        zero_as_missing: false,
    };

    const TEMPERATURE_RULE: SeriesRule = SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Word(1),
        zero_as_missing: false,
    };

    #[test]
    fn skips_timestamp_formatting_when_every_value_is_missing() {
        let rows = [None, None, None];
        let timestamp_calls = Cell::new(0);
        let rule = GUANGWUSUO_000_RULE.series_rule("set-temp").unwrap();

        let series = make_optional_series(
            rule,
            &rows,
            |_| {
                timestamp_calls.set(timestamp_calls.get() + 1);
                "unused".to_string()
            },
            |value| *value,
        );

        assert_eq!(series, None);
        assert_eq!(timestamp_calls.get(), 0);
    }

    #[test]
    fn zero_setpoint_values_become_missing_only_when_flagged() {
        let set_humidity = GUANGWUSUO_000_RULE.series_rule("set-humidity").unwrap();
        let set_temp = GUANGWUSUO_000_RULE.series_rule("set-temp").unwrap();
        let rows = [Some(0.0), Some(60.0), Some(0.0)];

        let humidity =
            make_optional_series(set_humidity, &rows, |_| "t".to_string(), |value| *value).unwrap();
        assert_eq!(
            humidity
                .points
                .iter()
                .map(|point| point.1)
                .collect::<Vec<_>>(),
            [None, Some(60.0), None]
        );

        let temperature =
            make_optional_series(set_temp, &rows, |_| "t".to_string(), |value| *value).unwrap();
        assert_eq!(
            temperature
                .points
                .iter()
                .map(|point| point.1)
                .collect::<Vec<_>>(),
            [Some(0.0), Some(60.0), Some(0.0)]
        );
    }

    #[test]
    fn omits_a_series_whose_zero_setpoints_are_all_missing() {
        let set_humidity = GUANGWUSUO_000_RULE.series_rule("set-humidity").unwrap();
        let rows = [Some(0.0), Some(0.0)];

        let series = make_optional_series(set_humidity, &rows, |_| "t".to_string(), |value| *value);
        assert_eq!(series, None);
    }

    #[test]
    fn out_of_physical_range_humidity_readings_become_missing() {
        let rows = [
            Some(0.0),
            Some(-0.5),
            Some(45.0),
            Some(100.0),
            Some(100.5),
            None,
        ];

        let series =
            make_optional_series(&HUMIDITY_RULE, &rows, |_| "t".to_string(), |value| *value)
                .unwrap();

        assert_eq!(
            series
                .points
                .iter()
                .map(|point| point.1)
                .collect::<Vec<_>>(),
            [None, None, Some(45.0), Some(100.0), None, None]
        );
    }

    #[test]
    fn omits_humidity_series_when_every_reading_is_out_of_physical_range() {
        let rows = [Some(0.0), Some(-0.5), Some(100.5), None];

        let series =
            make_optional_series(&HUMIDITY_RULE, &rows, |_| "t".to_string(), |value| *value);

        assert_eq!(series, None);
    }

    #[test]
    fn zero_and_negative_temperature_readings_stay_valid() {
        let rows = [Some(0.0), Some(-40.0), Some(35.0)];

        let series = make_optional_series(
            &TEMPERATURE_RULE,
            &rows,
            |_| "t".to_string(),
            |value| *value,
        )
        .unwrap();

        assert_eq!(
            series
                .points
                .iter()
                .map(|point| point.1)
                .collect::<Vec<_>>(),
            [Some(0.0), Some(-40.0), Some(35.0)]
        );
    }
}
