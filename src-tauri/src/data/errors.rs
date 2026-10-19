use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("无法读取文件：{0}")]
    Io(String),
    #[error("暂不支持该文件格式：{0}")]
    UnsupportedFormat(String),
    #[error("文件中没有可显示的数据：{0}")]
    NoDisplayableData(String),
    #[error("文件已识别，但解析失败：{0}")]
    Parse(String),
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<csv::Error> for AppError {
    fn from(value: csv::Error) -> Self {
        Self::Parse(value.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
