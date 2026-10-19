use std::collections::HashSet;

use super::errors::AppError;
use super::model::Axis;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FieldSourceRule {
    Word(usize),
    Column(usize),
    HeaderAliases(&'static [&'static str]),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AxisRule {
    pub id: &'static str,
    pub role: &'static str,
    pub name: &'static str,
    pub unit: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SeriesRule {
    pub id: &'static str,
    pub name: &'static str,
    pub unit: &'static str,
    pub role: &'static str,
    pub axis_id: &'static str,
    pub source: FieldSourceRule,
    /// 设定值为 0 表示“未控制/未设置”而非真实 0 值时，按缺失数据处理。
    /// 仅适用于湿度、气压等设定通道；温度设定 0 ℃ 是合法值，不得启用。
    pub zero_as_missing: bool,
}

/// 物理有效值域：(min, max]，即读数须满足 `min < value <= max`。
/// 超出该值域的读数不可能是真实测量值（如 0%RH 或 >100%RH 的湿度），统一按缺失数据处理。
/// 依据物理量单位声明，新控制器格式自动继承该规则，无需逐条配置。
pub fn physical_valid_range(unit: &str) -> Option<(f64, f64)> {
    match unit {
        "%RH" => Some((0.0, 100.0)),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ControllerRule {
    pub id: &'static str,
    pub parser_id: &'static str,
    pub timestamp_headers: &'static [&'static str],
    pub axes: &'static [AxisRule],
    pub series: &'static [SeriesRule],
}

impl ControllerRule {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.axes.is_empty() || self.axes.len() > 3 {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 必须定义 1 至 3 条纵坐标轴",
                self.id
            )));
        }

        let axis_ids: HashSet<&str> = self.axes.iter().map(|axis| axis.id).collect();
        if axis_ids.len() != self.axes.len() {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 存在重复的纵坐标轴 ID",
                self.id
            )));
        }

        let primary_count = self
            .axes
            .iter()
            .filter(|axis| axis.role == "primary")
            .count();
        let secondary_count = self
            .axes
            .iter()
            .filter(|axis| axis.role == "secondary")
            .count();
        if primary_count != 1 || secondary_count > 2 {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 必须定义且只能定义一条主坐标轴，并最多定义两条次坐标轴",
                self.id
            )));
        }
        if primary_count + secondary_count != self.axes.len() {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 存在未知的纵坐标轴角色",
                self.id
            )));
        }

        let series_ids: HashSet<&str> = self.series.iter().map(|series| series.id).collect();
        if series_ids.len() != self.series.len() {
            return Err(AppError::Parse(format!(
                "控制器规则 {} 存在重复的曲线 ID",
                self.id
            )));
        }

        for series in self.series {
            let Some(axis) = self.axes.iter().find(|axis| axis.id == series.axis_id) else {
                return Err(AppError::Parse(format!(
                    "控制器规则 {} 的曲线 {} 引用了不存在的纵坐标轴 {}",
                    self.id, series.id, series.axis_id
                )));
            };
            if axis.unit != series.unit {
                return Err(AppError::Parse(format!(
                    "控制器规则 {} 的曲线 {} 与纵坐标轴 {} 单位不一致",
                    self.id, series.id, series.axis_id
                )));
            }
        }

        Ok(())
    }

    pub fn axis_definitions(&self) -> Vec<Axis> {
        self.axes
            .iter()
            .map(|axis| Axis {
                id: axis.id.to_string(),
                role: axis.role.to_string(),
                name: axis.name.to_string(),
                unit: axis.unit.to_string(),
            })
            .collect()
    }

    pub fn series_rule(&self, id: &str) -> Result<&SeriesRule, AppError> {
        self.series
            .iter()
            .find(|series| series.id == id)
            .ok_or_else(|| AppError::Parse(format!("控制器规则 {} 缺少曲线定义：{}", self.id, id)))
    }
}

const TEMPERATURE_AXIS: AxisRule = AxisRule {
    id: "primary",
    role: "primary",
    name: "温度",
    unit: "degC",
};

const HUMIDITY_AXIS: AxisRule = AxisRule {
    id: "secondary",
    role: "secondary",
    name: "湿度",
    unit: "%RH",
};

const STANDARD_AXES: &[AxisRule] = &[TEMPERATURE_AXIS, HUMIDITY_AXIS];

const PRESSURE_AXIS: AxisRule = AxisRule {
    id: "pressure",
    role: "secondary",
    name: "气压",
    unit: "kPa",
};

/// 温湿高箱（温度/湿度/低气压综合试验）三纵轴布局：
/// 主轴温度、次轴湿度、次轴气压（右轴第二列）。
const FREUD_HISTORY_AXES: &[AxisRule] = &[TEMPERATURE_AXIS, HUMIDITY_AXIS, PRESSURE_AXIS];

const GUANGWUSUO_000_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Word(5),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Word(6),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Word(7),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Word(8),
        zero_as_missing: false,
    },
];

const TEMI2500_SDR_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::HeaderAliases(&["TEMP. SP"]),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::HeaderAliases(&["TEMP. PV"]),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::HeaderAliases(&["HUMI .SP", "HUMI. SP"]),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::HeaderAliases(&["HUMI. PV", "HUMI .PV"]),
        zero_as_missing: false,
    },
];

const GENERIC_CSV_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::HeaderAliases(&["设定温度", "目标温度", "温度设定值"]),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::HeaderAliases(&["实测温度", "当前温度", "温度测量值"]),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::HeaderAliases(&["设定湿度", "目标湿度", "湿度设定值"]),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::HeaderAliases(&["实测湿度", "当前湿度", "湿度测量值"]),
        zero_as_missing: false,
    },
];

const WEINTEK_EXPORT_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Column(5),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Column(3),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Column(6),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Column(4),
        zero_as_missing: false,
    },
];

pub const GUANGWUSUO_000_RULE: ControllerRule = ControllerRule {
    id: "guangwusuo-000-v1",
    parser_id: "guangwusuo-000",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: GUANGWUSUO_000_SERIES,
};

pub const TEMI2500_SDR_RULE: ControllerRule = ControllerRule {
    id: "samwontech-temi2500-sdr-v1",
    parser_id: "samwontech-temi2500-sdr",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: TEMI2500_SDR_SERIES,
};

pub const GENERIC_CSV_RULE: ControllerRule = ControllerRule {
    id: "csv-standard-v1",
    parser_id: "generic-csv",
    timestamp_headers: &["timestamp", "时间", "时间戳"],
    axes: STANDARD_AXES,
    series: GENERIC_CSV_SERIES,
};

pub const WEINTEK_EXPORT_RULE: ControllerRule = ControllerRule {
    id: "weintek-export-v1",
    parser_id: "weintek-export",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: WEINTEK_EXPORT_SERIES,
};

const TEMPERATURE_ONLY_AXES: &[AxisRule] = &[TEMPERATURE_AXIS];

const INT16_7COL_CSV_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Column(5),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Column(3),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Column(6),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Column(4),
        zero_as_missing: false,
    },
];

const UTF8_11COL_HMI_CSV_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Column(4),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Column(2),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Column(5),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Column(3),
        zero_as_missing: false,
    },
];

const GBK_4COL_TEMP_CSV_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Column(3),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Column(2),
        zero_as_missing: false,
    },
];

const KR_TSV_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Column(2),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Column(1),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Column(4),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Column(3),
        zero_as_missing: false,
    },
];

const KR_RCD_BIN_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Word(1),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Word(0),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Word(3),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Word(2),
        zero_as_missing: false,
    },
];

pub const INT16_7COL_CSV_RULE: ControllerRule = ControllerRule {
    id: "16bit-7col-csv-v1",
    parser_id: "16bit-7col-csv",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: INT16_7COL_CSV_SERIES,
};

pub const UTF8_11COL_HMI_CSV_RULE: ControllerRule = ControllerRule {
    id: "utf8-11col-hmi-csv-v1",
    parser_id: "utf8-11col-hmi-csv",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: UTF8_11COL_HMI_CSV_SERIES,
};

pub const GBK_4COL_TEMP_CSV_RULE: ControllerRule = ControllerRule {
    id: "gbk-4col-temp-csv-v1",
    parser_id: "gbk-4col-temp-csv",
    timestamp_headers: &[],
    axes: TEMPERATURE_ONLY_AXES,
    series: GBK_4COL_TEMP_CSV_SERIES,
};

pub const KR_TSV_RULE: ControllerRule = ControllerRule {
    id: "kr-tsv-v1",
    parser_id: "kr-tsv",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: KR_TSV_SERIES,
};

pub const KR_RCD_BIN_RULE: ControllerRule = ControllerRule {
    id: "kr-rcd-bin-v1",
    parser_id: "kr-rcd-bin",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: KR_RCD_BIN_SERIES,
};

const ATEC_H12_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Word(0),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Word(1),
        zero_as_missing: false,
    },
];

const ATEC_6COL_CSV_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Column(3),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Column(2),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Column(4),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Column(5),
        zero_as_missing: false,
    },
];

const MCGS_5COL_CSV_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Column(2),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Column(1),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Column(4),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Column(3),
        zero_as_missing: false,
    },
];

const FREUD_S1_HISTORY_CSV_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Column(4),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Column(2),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Column(5),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Column(3),
        zero_as_missing: false,
    },
];

const FREUD_HISTORY_CSV_SERIES: &[SeriesRule] = &[
    SeriesRule {
        id: "set-temp",
        name: "设定温度",
        unit: "degC",
        role: "setpoint",
        axis_id: "primary",
        source: FieldSourceRule::Column(4),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-temp",
        name: "实测温度",
        unit: "degC",
        role: "measured",
        axis_id: "primary",
        source: FieldSourceRule::Column(1),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-humidity",
        name: "设定湿度",
        unit: "%RH",
        role: "setpoint",
        axis_id: "secondary",
        source: FieldSourceRule::Column(5),
        zero_as_missing: true,
    },
    SeriesRule {
        id: "actual-humidity",
        name: "实测湿度",
        unit: "%RH",
        role: "measured",
        axis_id: "secondary",
        source: FieldSourceRule::Column(2),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "actual-pressure",
        name: "实测气压",
        unit: "kPa",
        role: "measured",
        axis_id: "pressure",
        source: FieldSourceRule::Column(3),
        zero_as_missing: false,
    },
    SeriesRule {
        id: "set-pressure",
        name: "设定气压",
        unit: "kPa",
        role: "setpoint",
        axis_id: "pressure",
        source: FieldSourceRule::Column(6),
        zero_as_missing: true,
    },
];

pub const ATEC_H12_RULE: ControllerRule = ControllerRule {
    id: "atec-h12-v1",
    parser_id: "atec-h12",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: ATEC_H12_SERIES,
};

pub const ATEC_6COL_CSV_RULE: ControllerRule = ControllerRule {
    id: "atec-6col-csv-v1",
    parser_id: "atec-6col-csv",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: ATEC_6COL_CSV_SERIES,
};

pub const MCGS_5COL_CSV_RULE: ControllerRule = ControllerRule {
    id: "mcgs-5col-csv-v1",
    parser_id: "mcgs-5col-csv",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: MCGS_5COL_CSV_SERIES,
};

pub const FREUD_S1_HISTORY_CSV_RULE: ControllerRule = ControllerRule {
    id: "freud-s1-history-csv-v1",
    parser_id: "freud-s1-history-csv",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: FREUD_S1_HISTORY_CSV_SERIES,
};

pub const FREUD_HSHBKA_RULE: ControllerRule = ControllerRule {
    id: "freud-hshbka-v1",
    parser_id: "freud-hshbka",
    timestamp_headers: &[],
    axes: STANDARD_AXES,
    series: FREUD_S1_HISTORY_CSV_SERIES,
};

pub const FREUD_HISTORY_CSV_RULE: ControllerRule = ControllerRule {
    id: "freud-history-csv-v1",
    parser_id: "freud-history-csv",
    timestamp_headers: &[],
    axes: FREUD_HISTORY_AXES,
    series: FREUD_HISTORY_CSV_SERIES,
};

pub const FREUD_MDATA_ZIP_RULE: ControllerRule = ControllerRule {
    id: "freud-mdata-zip-v1",
    parser_id: "freud-mdata-zip",
    timestamp_headers: &[],
    axes: FREUD_HISTORY_AXES,
    series: FREUD_HISTORY_CSV_SERIES,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_controller_rules_are_valid_and_identified() {
        GUANGWUSUO_000_RULE.validate().unwrap();
        TEMI2500_SDR_RULE.validate().unwrap();
        GENERIC_CSV_RULE.validate().unwrap();
        WEINTEK_EXPORT_RULE.validate().unwrap();
        INT16_7COL_CSV_RULE.validate().unwrap();
        UTF8_11COL_HMI_CSV_RULE.validate().unwrap();
        GBK_4COL_TEMP_CSV_RULE.validate().unwrap();
        KR_TSV_RULE.validate().unwrap();
        KR_RCD_BIN_RULE.validate().unwrap();
        ATEC_H12_RULE.validate().unwrap();
        ATEC_6COL_CSV_RULE.validate().unwrap();
        MCGS_5COL_CSV_RULE.validate().unwrap();
        FREUD_S1_HISTORY_CSV_RULE.validate().unwrap();
        FREUD_HSHBKA_RULE.validate().unwrap();
        FREUD_HISTORY_CSV_RULE.validate().unwrap();
        FREUD_MDATA_ZIP_RULE.validate().unwrap();
        assert_eq!(GUANGWUSUO_000_RULE.id, "guangwusuo-000-v1");
        assert_eq!(GUANGWUSUO_000_RULE.parser_id, "guangwusuo-000");
        assert_eq!(TEMI2500_SDR_RULE.id, "samwontech-temi2500-sdr-v1");
        assert_eq!(TEMI2500_SDR_RULE.parser_id, "samwontech-temi2500-sdr");
        assert_eq!(GENERIC_CSV_RULE.id, "csv-standard-v1");
        assert_eq!(WEINTEK_EXPORT_RULE.id, "weintek-export-v1");
        assert_eq!(WEINTEK_EXPORT_RULE.parser_id, "weintek-export");
        assert_eq!(INT16_7COL_CSV_RULE.id, "16bit-7col-csv-v1");
        assert_eq!(UTF8_11COL_HMI_CSV_RULE.id, "utf8-11col-hmi-csv-v1");
        assert_eq!(GBK_4COL_TEMP_CSV_RULE.id, "gbk-4col-temp-csv-v1");
        assert_eq!(GBK_4COL_TEMP_CSV_RULE.axes.len(), 1);
        assert_eq!(KR_TSV_RULE.id, "kr-tsv-v1");
        assert_eq!(KR_RCD_BIN_RULE.id, "kr-rcd-bin-v1");
        assert_eq!(ATEC_H12_RULE.id, "atec-h12-v1");
        assert_eq!(ATEC_6COL_CSV_RULE.id, "atec-6col-csv-v1");
        assert_eq!(MCGS_5COL_CSV_RULE.id, "mcgs-5col-csv-v1");
        assert_eq!(FREUD_S1_HISTORY_CSV_RULE.id, "freud-s1-history-csv-v1");
        assert_eq!(FREUD_HSHBKA_RULE.id, "freud-hshbka-v1");
        assert_eq!(FREUD_HISTORY_CSV_RULE.id, "freud-history-csv-v1");
        assert_eq!(FREUD_HISTORY_CSV_RULE.axes.len(), 3);
        assert_eq!(FREUD_MDATA_ZIP_RULE.id, "freud-mdata-zip-v1");
    }

    #[test]
    fn weintek_rule_maps_four_anonymous_float_columns_to_semantic_roles() {
        let expected_columns = [5_usize, 3, 6, 4];

        for (series, expected_column) in WEINTEK_EXPORT_RULE.series.iter().zip(expected_columns) {
            assert_eq!(
                series.source,
                FieldSourceRule::Column(expected_column),
                "{}",
                series.id
            );
        }
    }

    #[test]
    fn rules_define_axis_names_and_series_axis_membership() {
        let axes = GUANGWUSUO_000_RULE.axis_definitions();
        assert_eq!(axes[0].name, "温度");
        assert_eq!(axes[1].name, "湿度");
        assert_eq!(
            GUANGWUSUO_000_RULE
                .series_rule("actual-humidity")
                .unwrap()
                .axis_id,
            "secondary"
        );
        let history_axes = FREUD_HISTORY_CSV_RULE.axis_definitions();
        assert_eq!(history_axes[2].name, "气压");
        assert_eq!(history_axes[2].role, "secondary");
        assert_eq!(
            FREUD_HISTORY_CSV_RULE
                .series_rule("set-pressure")
                .unwrap()
                .axis_id,
            "pressure"
        );
        assert!(
            FREUD_HISTORY_CSV_RULE
                .series_rule("set-pressure")
                .unwrap()
                .zero_as_missing
        );
        assert!(
            !FREUD_HISTORY_CSV_RULE
                .series_rule("set-temp")
                .unwrap()
                .zero_as_missing
        );
    }

    #[test]
    fn humidity_has_a_physical_range_while_temperature_and_pressure_do_not() {
        assert_eq!(physical_valid_range("%RH"), Some((0.0, 100.0)));
        assert_eq!(physical_valid_range("degC"), None);
        assert_eq!(physical_valid_range("kPa"), None);
    }

    #[test]
    fn rejects_a_rule_without_exactly_one_primary_axis() {
        const INVALID_AXES: &[AxisRule] = &[AxisRule {
            id: "secondary",
            role: "secondary",
            name: "压力",
            unit: "kPa",
        }];
        const INVALID_RULE: ControllerRule = ControllerRule {
            id: "invalid-v1",
            parser_id: "invalid",
            timestamp_headers: &[],
            axes: INVALID_AXES,
            series: &[],
        };

        assert!(INVALID_RULE.validate().is_err());
    }

    #[test]
    fn accepts_one_primary_with_two_secondary_axes() {
        const THREE_AXES: &[AxisRule] = &[TEMPERATURE_AXIS, HUMIDITY_AXIS, PRESSURE_AXIS];
        const THREE_SERIES: &[SeriesRule] = &[
            SeriesRule {
                id: "actual-temp",
                name: "实测温度",
                unit: "degC",
                role: "measured",
                axis_id: "primary",
                source: FieldSourceRule::Column(1),
                zero_as_missing: false,
            },
            SeriesRule {
                id: "actual-humidity",
                name: "实测湿度",
                unit: "%RH",
                role: "measured",
                axis_id: "secondary",
                source: FieldSourceRule::Column(2),
                zero_as_missing: false,
            },
            SeriesRule {
                id: "actual-pressure",
                name: "实测气压",
                unit: "kPa",
                role: "measured",
                axis_id: "pressure",
                source: FieldSourceRule::Column(3),
                zero_as_missing: false,
            },
        ];
        const THREE_AXIS_RULE: ControllerRule = ControllerRule {
            id: "three-axis-v1",
            parser_id: "three-axis",
            timestamp_headers: &[],
            axes: THREE_AXES,
            series: THREE_SERIES,
        };

        THREE_AXIS_RULE.validate().unwrap();
    }

    #[test]
    fn rejects_more_than_two_secondary_axes() {
        const FOUR_AXES: &[AxisRule] = &[
            TEMPERATURE_AXIS,
            HUMIDITY_AXIS,
            PRESSURE_AXIS,
            AxisRule {
                id: "extra",
                role: "secondary",
                name: "额外",
                unit: "unit",
            },
        ];
        const FOUR_AXIS_RULE: ControllerRule = ControllerRule {
            id: "four-axis-v1",
            parser_id: "four-axis",
            timestamp_headers: &[],
            axes: FOUR_AXES,
            series: &[],
        };

        assert!(FOUR_AXIS_RULE.validate().is_err());
    }
}
