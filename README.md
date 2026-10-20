# 实验箱数据查看器

Windows 离线桌面软件，打开各品牌试验箱控制器 / HMI 导出的历史数据文件，展示温度、湿度（部分格式含气压）曲线。基于 Tauri 2、React 与 ECharts。

## 支持的数据格式

按文件内容特征识别格式，扩展名不决定解析器；未知或无法唯一识别的内容会被明确拒绝。

| 来源 | 格式 |
| --- | --- |
| 广五所 | `.000`（TAR 容器内的 `SmpData.000`） |
| SAMWONTECH TEMI2500 | `.SDR` |
| 威纶通 EBPro | 趋势导出 CSV（`Date`、`Time`、`Millisecond` 加 4 个 `32-bit Float` 列） |
| 阿泰可 | 16 位 7 列 CSV、11 列中文头 CSV、GBK 4 列温度 CSV、6 列中文头 CSV、`.h12` 二进制 |
| 三志 MCGS | 5 列 CSV |
| 弗锐德 | `.HSHBKA` 与 MData zip，以及解压后的 `s1_history.csv` / `history_data.csv`；Windows 11 下也可直接在 zip 文件夹中选择内部文件 |
| 汉测记录仪 | TSV（`.xls` 扩展名）与 bin |

各格式的结构、通道映射、缺失值语义与采样周期见 [`docs/格式注册表.md`](docs/格式注册表.md)。阿泰可 16 位 7 列与 11 列中文头 CSV 的通道语义为初步映射（数值按 ×0.1 折算），尚待对照确认。

## 功能

- 直接选择或拖入数据文件；同一文件夹内同一格式的多个文件可多选合并为一个数据组（暂不支持跨文件夹合并）。相同时间点、相同原始值去重，存在冲突时拒绝整组加载。
- 采样周期按内容推断，停录间断生成诊断并断开曲线；缺失、无效或超满量程值作为断点，不以 `0` 代替；全为空值的曲线不显示。
- 多文件切换与更换、缩放、平移、悬浮读数、图例显隐、纵轴锁定与 PNG 导出；载入数据后按 `F1` 或命令带问号查看图表操作速查。
- 侧栏只显示文件名（合并组显示来源文件列表），悬停可查看完整路径。

## 下载与运行

在 [Releases](https://github.com/godisabug/chamber-data-viewer/releases) 下载，两种形式任选其一：

- **安装版**（`chamber-data-viewer-<版本>-windows-x64-setup.exe`）：安装到当前用户目录，无需管理员权限，创建开始菜单快捷方式，可在系统“应用”中卸载；缺少 WebView2 Runtime 时会自动下载安装。
- **绿色版**（`chamber-data-viewer-<版本>-windows-x64.exe`）：单文件，无需安装，直接运行；需要系统已有 WebView2 Runtime（Windows 11 与较新的 Windows 10 已自带）。

两种形式共用同一份本地设置。程序未做代码签名，首次运行时 Windows SmartScreen 可能提示“未知发布者”，选择“仍要运行”即可。

## 开发

```powershell
npm install
npm run tauri dev
```

## 验证

```powershell
npm test
npm run build
cargo test --manifest-path .\src-tauri\Cargo.toml
npm run lint
```

真实样本回归测试默认忽略（`#[ignore]`），需要通过环境变量（如 `CHAMBER_RAW_SAMPLES_ROOT`）指向本地样本目录后用 `cargo test -- --ignored` 运行；真实样本不入库。

## 打包

```powershell
npm run build:portable   # 绿色版
npm run build:installer  # 安装版（NSIS）
```

`CARGO_TARGET_DIR` 决定 Rust 产物根目录。未设置该变量时，绿色版位于 `src-tauri\target\release\实验箱数据查看器.exe`，安装版位于 `src-tauri\target\release\bundle\nsis\`；设置后应从相应 target 根目录取用。

## 新增数据格式

新增解析器前先在 [`docs/格式注册表.md`](docs/格式注册表.md) 登记，再按其中的“新增格式流程”实现互斥的内容探测与解析规则，并提供最小化合成夹具。

提交样本文件或在 Issue 中附带数据前，请先去除设备出厂编号、客户与试验信息等敏感内容；能复现结构即可，不需要完整数据。

## 声明

本项目与文中提及的各试验箱、控制器与 HMI 厂商均无关联。厂商与产品名称仅用于说明数据格式兼容性，相关商标归各自所有者所有。数据格式的解析均基于对导出文件的独立分析。

## 许可证

[GPL-3.0](LICENSE)
