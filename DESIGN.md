---
name: 实验箱数据查看器
description: 以“试验记录台”统一数据来源、观测轨迹与工程判读的精密桌面界面。
colors:
  white: "#ffffff"
  canvas: "#f7f9fb"
  plot: "#fbfcfd"
  surface-subtle: "#f2f4f6"
  border: "#e1e5e9"
  border-strong: "#c8ced5"
  text: "#24282e"
  muted: "#68717b"
  sidebar: "#1a1f25"
  sidebar-hover: "#20262d"
  sidebar-selected: "#242a32"
  sidebar-border: "#343b44"
  sidebar-text: "#f2f5f8"
  sidebar-muted: "#9ba5b1"
  blue: "#1c69d4"
  blue-hover: "#155bb9"
  danger: "#bd3737"
  chart-grid: "#e4e8ec"
  chart-axis: "#767d85"
  temperature-setpoint: "#75808b"
  humidity-measured: "#30343a"
  humidity-setpoint: "#7b8087"
  cursor-line: "rgba(72, 80, 89, 0.34)"
typography:
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 620
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  data:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "tabular-nums"
  control:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.4
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
rounded:
  xs: "2px"
  sm: "3px"
  md: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  compact: "10px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.blue-hover}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  input-data:
    backgroundColor: "{colors.white}"
    textColor: "{colors.text}"
    typography: "{typography.data}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "36px"
---

# Design System: 实验箱数据查看器

## Overview

**Creative North Star: “试验记录台”**

“试验记录台”把数据来源、观测轨迹与工程判读组织成同一个连续工作面。深色来源台账提供稳定的设备与文件坐标，浅色观测画布承担绝大多数视觉面积；方正控件、细规则线、稀缺的 BMW 蓝与克制的状态反馈共同建立可信、精密、低装饰的气质。

这套世界拒绝卡片式数据看板和装饰性仪表盘。信息层级来自明暗连续面、1px 分界、字重和留白，而不是互相竞争的容器；图表始终是第一视觉，游标、浮动读数、菜单和设置只在任务需要时出现，并主动避让数据。

实现边界：本规范从通过 finish review 的独立浏览器原型 `prototype/index.html`、`prototype/prototype.css` 与 `prototype/prototype.js` 提取并固化，作为后续生产界面收敛的视觉事实源。截至记录时，生产 `src/**` 仍维持原状，本文件不表示原型已落地为生产界面；原型数据明确标注为“合成轨迹”，只用于交互与视觉验收，不代表真实解析结果。

**Key Characteristics:**

- 深色来源台账连接连续浅色观测画布，图表获得剩余全部空间。
- 1px 规则线、2px 当前来源标线与 2–4px 小圆角构成精密、方正的形态语言。
- BMW 蓝只承担当前定位、主操作与温度实测轨迹，其余辅助状态保持中性。
- 实测实线、设定虚线、缺失真实断开；交互反馈短促且不扰动读图。

## Colors

配色以冷白观测面和石墨来源台账建立工作区分工，BMW 蓝以低占比承担明确定位，所有辅助控制与非温度轨迹回到中性灰阶。

### Primary

- **BMW 定位蓝** (`blue`, #1c69d4)：只用于当前来源的 2px 标线、主按钮、焦点提示和温度实测曲线。
- **BMW 深蓝** (`blue-hover`, #155bb9)：只作为主按钮悬停反馈；按下态进一步收至 #104d9c，不扩展成新的大面积表面色。

### Neutral

- **记录台石墨** (`sidebar`, #1a1f25)：来源台账的连续深色底；悬停与选中分别使用 `sidebar-hover` 和 `sidebar-selected`，不拆成卡片。
- **观测冷白** (`canvas`, #f7f9fb) 与 **绘图纸白** (`plot`, #fbfcfd)：承接命令带以下的连续观测区域，并让图表成为主视觉。
- **仪表墨色** (`text`, #24282e) 与 **注释灰** (`muted`, #68717b)：分别承担主要文字和辅助标签、刻度、单位。
- **规则线灰** (`border`, #e1e5e9)、**控件边界灰** (`border-strong`, #c8ced5) 与 **图表网格灰** (`chart-grid`, #e4e8ec)：以 1px 结构线组织空间，不制造容器感。
- **台账前景** (`sidebar-text`, #f2f5f8)、**台账注释** (`sidebar-muted`, #9ba5b1) 与 **台账规则线** (`sidebar-border`, #343b44)：在深色来源面内维持可读但安静的层级。
- **湿度实测石墨** (`humidity-measured`, #30343a)、**温度设定灰** (`temperature-setpoint`, #75808b) 与 **湿度设定灰** (`humidity-setpoint`, #7b8087)：用线宽和虚实建立语义，不借用品牌蓝争夺注意力。
- **轴框灰** (`chart-axis`, #767d85) 与 **游标灰** (`cursor-line`, rgba(72, 80, 89, 0.34))：给读图提供基准，但始终弱于数据轨迹。

### Semantic status

- **拒绝红** (`danger`, #bd3737)：只用于删除操作与范围错误等负向语义，不作为第二强调色。

### Named Rules

**The Single Blue Voice Rule.** BMW 蓝只同时说三件事：当前来源、主操作、温度实测；游标按钮、打开文件图标、设置页签和温度设定虚线必须中性化。

## Typography

**Display Font:** Segoe UI Variable Text（回退至 Segoe UI、Microsoft YaHei UI、system-ui）

**Body Font:** Segoe UI Variable Text（回退至 Segoe UI、Microsoft YaHei UI、system-ui）
**Numeric Style:** 表格数字（`tabular-nums`）用于时间、测量值、文件编号与设备参数。

**Character:** 单一 Windows 原生字族保持工具感和离线桌面环境的一致性；层级通过 11–15px 的紧凑字号、500–620 的克制字重与明暗关系完成，而不依赖展示字体或大标题。

### Hierarchy

- **Title**（620，15px，1.25，-0.015em）：产品名与最高级局部标题，短行且不占据图表高度。
- **Body**（400，14px，1.4）：基础界面文字与空状态。
- **Data**（400，13px，1.4，表格数字）：文件名、时间输入和读数上下文。
- **Control**（550，12px，1.4）：按钮、菜单和紧凑操作标签。
- **Label**（500，11px，1.2）：字段标题、元数据、图例组名、刻度与单位。

### Named Rules

**The Tabular Evidence Rule.** 时间、测量值、设备编号和范围参数一律使用等宽数字特性；数字列不能因字宽变化而抖动。

## Layout

界面使用三列应用骨架：默认 276px 来源台账、4px 可拖动分隔带与占据余量的观测工作区。宽度不高于 1120px 时，台账降为 240px；折叠后为 52px。台账头部与底部操作区各 72px，文件条目以 72px 最小高度连续排列。

工作区顶部是单条 72px 命令带，时间范围在左，游标、重置视图、图表设置与帮助四个纯图标工具在右；下方是 34px 图例带，其余高度全部交给图表。图表水平外边距默认 20px，在 1180px 以下收至 14px、1120px 以下收至 10px。原型 CSS 的硬下限为 980×640px，finish review 的最小验收窗口为 980×680px；在该验收窗口内仍必须保留完整命令带、图例和可读图表。

图表绘图区为左右各 74px、上 43px、下 52px 的轴与刻度内边距。滚轮以指针所在时间为锚点缩放，中键拖动平移时间轴；`Shift` + 滚轮或中键拖动作用于纵轴，`Shift` + 左键单击曲线或图例组名可切换对应轴组锁定；同一时间只锁定一组，锁定另一组时原先的锁定自动解除。所有尺寸变化通过单次绘图调度响应，不能让附加界面挤占或阻塞 Canvas。

### Named Rules

**The Chart Gets the Room Rule.** 来源、命令与图例只占完成核对所需的最小带状空间，剩余空间无条件归图表；不得新增标题横幅、摘要卡片或装饰区。

## Elevation & Depth

系统默认完全扁平，以深浅表面和 1px 规则线区分区域。阴影只出现在脱离文档流的临时覆盖层：文件菜单使用 0 8px 18px rgba(15, 23, 34, 0.18)，游标读数使用 0 8px 18px rgba(26, 31, 37, 0.15)，可拖动设置面板使用 0 12px 28px rgba(15, 23, 34, 0.18)。常驻侧栏、命令带、图例和图表均不使用阴影。

### Shadow Vocabulary

- **菜单浮层** (`0 8px 18px rgba(15, 23, 34, 0.18)`)：文件行的短时上下文菜单。
- **低干扰读数** (`0 8px 18px rgba(26, 31, 37, 0.15)`)：跟随游标、自动左右避让的读数卡片。
- **设置工作层** (`0 12px 28px rgba(15, 23, 34, 0.18)`)：可拖动设置面板，表达其位于观测画布之上。

### Named Rules

**The Flat Until Needed Rule.** 常驻界面没有阴影；只有会遮挡下层内容、且可关闭或随指针消失的覆盖层才获得深度。

## Shapes

形态以近直角和细描边为主：图例控制使用 2px 圆角，图标按钮与台账操作使用 3px，输入、标准按钮、菜单、读数卡片和设置面板统一为 4px。界面不使用胶囊形态；游标显隐这类开关状态用按下态按钮表达，与其他工具按钮同形。

主要空间通过 1px 边界组织；当前来源用贴左 2px 蓝色竖线标记。线性图标使用 1.5px 圆端描边，保持安静、可辨认并与方正容器形成轻微对比。

### Named Rules

**The Squared Precision Rule.** 所有工作控件保持 2–4px 小圆角；不使用胶囊按钮、胶囊开关、大圆角卡片或软质悬浮岛。

## Components

### Buttons

- **Shape:** 紧凑方正（4px 圆角、36px 高）；主要与次要按钮水平内边距为 14px。
- **Primary:** BMW 蓝底、白字和同色 1px 边界；悬停转深蓝，按下进一步加深。
- **Secondary:** 白底、墨色文字和强边界灰；悬停只增加浅灰底并略收紧边界对比。
- **Text:** 透明底、注释灰文字与透明边界；悬停时出现浅灰底和主要文字色。
- **Tool:** 命令带右侧的游标、重置视图、图表设置与帮助是同一种纯图标按钮：34px 方形、18px 图标、1.5px 描边，间距 4px，不带文字。名称用自绘提示显示（深色小标签，悬停约 0.35 秒出现，键盘聚焦同样出现），不用系统提示。四个图标轮廓各不相同：游标是“一条竖线加一张读数卡片”（按 Lucide 网格自绘），重置视图是四角框，图表设置是横向滑杆，帮助是圆圈问号。回转箭头只用于“恢复默认”，不与重置视图共用。此段为 2026-10-03 生产更新，优先于原型里的文字按钮与开关。
- **Engaged:** 开关按下（游标显示中）与浮层展开（设置、帮助打开中）共用同一外观：规则线灰描边、浅灰底、墨色文字；不使用品牌蓝下划线或胶囊开关。
- **Focus:** 所有按钮使用 2px 蓝色可见焦点轮廓并外移 2px；状态过渡为 90ms 的快速缓出。

### Inputs / Fields

- **Style:** 白底、1px 强边界灰、4px 圆角与 36px 高；紧凑设置字段可降至 34px。
- **Data:** 时间与数值统一使用表格数字，避免编辑时发生横向跳动。
- **Focus:** 边界与 1px 内聚焦环转为 BMW 蓝，外部仍保留可见焦点轮廓。
- **Error:** 错误文字以拒绝红直接说明原因，不用装饰性警告卡片。时间字段出错时，说明顶替字段名那一行显示，命令带高度不变，也不会伸到下方被图表区盖住；字段一经修改即恢复字段名。

### Time Range Field

开始时间与截止时间是两个 184px 宽的自绘时间字段（窄窗口 176px），文本固定为 `YYYY-MM-DD HH:mm:ss`：与横轴刻度、读数卡片同一套年月日顺序、“-”与“:”分隔和 24 小时制，不随系统区域设置变化。只支持手动输入，不提供日期选择浮层。

- **分段编辑：** 单击年、月、日、时、分、秒中的任意一段即选中它（沿用全局选区色），直接键入数字覆盖，写满或无法再接下一位时自动跳到下一段；左右方向键换段，上下方向键步进。时间是连续的，23 时再加一小时进到次日。先改日、再改月不会把 29–31 日提前截断。
- **整段文本：** 仍是一个普通文本框，可全选、复制，可粘贴 `2026/5/2 7:57` 这类从表格或报告里抄来的写法并自动整理成固定格式；`Enter` 等同“应用范围”。
- **恢复默认：** 字段平时不带任何按钮；只有内容偏离打开文件时的默认时间，框内右侧才出现 28px 的回转箭头。点击后该端恢复默认时间并立即生效，悬停提示写明要恢复成的具体时间。它只动这一端的时间，与命令带的“重置视图”互不相干。

### Navigation

来源台账头部以“试验箱数据查看器”为中文主名称，`chamber data viewer` 为英文副名称，窗口标题与 EXE 名称保持原样。标识为 28px SVG：中性灰圆角开放观察框配两条 BMW 蓝错位数据横线，无底板或阴影。字标分两层：中文 13px、550 字重、95% 白色；英文 10px、400 字重、68% 白色。两层间隔 2px，窄侧栏允许自然换行；图标列 28px、列间距 10px，折叠按钮保留独立 32px 空间。底部打开入口采用 12px、500 字重、78% 白色，悬停和键盘聚焦时恢复白色，原有点击面积不变。此段为 2026-09-24 生产品牌区更新，优先于原型时期的头部描述。

来源台账是连续日志式导航，不是文件卡片集合。当前行以略浅石墨底和贴左 2px BMW 蓝标线确认；每行只显示文件名（合并组附来源文件列表），不显示设备或控制器标签。文件操作按钮只在悬停、键盘焦点进入或菜单展开时出现，右键打开同一菜单；只卸载当前会话的动作称为“关闭数据集”，不得使用删除语义或危险色。打开文件操作固定在台账底部，折叠后仍保留图标入口；其图标和文字保持中性，不使用品牌蓝抢占当前来源的语义。折叠后头部仍为 72px、只保留展开按钮，文件列表换成 48px 宽的序号列（36px 行高）：当前文件保留贴左 2px BMW 蓝标线，悬停 800ms 显示完整路径，点击即可切换文件。侧栏分隔条支持拖动、双击复位、方向键微调，以及 `Home`、`End`、`Enter` 的折叠与宽度操作。

### Data Integrity Diagnostics

解析层可保留结构化数据完整性诊断，但在触发边界能够可靠区分设备正常缺失规则与真正不可解释的数据前，侧栏不显示黄色图标、徽标或诊断浮层。缺失值仍应在曲线中忠实断开，加载失败与数据冲突仍使用已有错误入口明确反馈。

### Empty State & Feedback

未打开文件时，工作区仿照编辑器的空白页：居中一枚 220px 的淡灰应用标记水印，下面是一张操作清单——左列动作、右列按键，右列按“修饰键 / 加号 / 主操作”三栏对齐。清单依次为打开数据文件（`Ctrl` + `O`）、载入多个文件（拖入窗口）、缩放与平移时间轴、缩放与平移纵轴（鼠标图示同操作速查），以及载入后按 `F1` 查看全部操作。工作区不再放打开按钮，打开文件的入口只有侧栏底部一个，另有 `Ctrl` + `O`。读取中改为旋转图标与“正在读取数据…”。把文件拖入窗口时，整窗出现 1.5px BMW 蓝虚线框、极淡的蓝色底和居中的“松开以载入 N 个文件”标签，松开或移出即消失；它只响应进入、离开和松开，不参与拖动中的高频事件，也不改变布局。

加载失败只有一种提示：右下角共用覆盖层表面，“无法载入数据”加后端给出的原因（后端已区分读取失败、格式不支持、无可显示数据、解析失败四类，界面不再细分）。提示带关闭按钮，8 秒后自动消失，指针停留时暂停计时，下一次载入开始时清除；不弹模态框，不使用危险色底或描边。

### Trace Legend

图例以 34px 单行带状区域贴近绘图区。温度与湿度组标签可整体显隐轴组，每条 24px 线样可独立切换；关闭态只降至 0.32 透明度，不制造按钮底。温度实测为 BMW 蓝，湿度实测为深石墨；两条设定曲线均使用中性灰虚线。

### Observation Canvas

Canvas 使用冷白绘图面、1px 淡网格和稍深轴框。实测曲线为圆端实线：温度 2.15px、湿度 2.05px；设定曲线为 1.35px、7px/5px 节奏的虚线。值为 `null` 或缺失时结束当前路径，下一有效点重新起笔，绝不跨越缺失区补线。

### Cursor & Readout

游标线为 1px、3px/3px 的半透明灰色虚线；交点采用白心、1.5px 对应轨迹色描边。游标是一个整体：轴线与读数卡片由同一入口一起显示、一起隐藏。按住 `Shift` 调整纵轴、或用中键拖动平移时两者同时让位，松开后回到指针所在位置；滚轮缩放时间轴期间及结算之后保持显示；指针离开绘图区或关闭游标开关时一起消失。读数卡片宽度至少 196px，自动在指针左右切换并限制在图表边界内；卡片不可接收指针事件，时间、读数、单位保持紧凑且不遮挡主要数据区域。每行用与图例同一套线样标识曲线：实测为 3px 实线、设定为 5px/3px 虚线，不使用方块色块；无值显示“—”。

### Chart Help

图表命令带末端的问号图标提供“图表操作速查”，也可由 `F1` 打开或关闭。浮层为右对齐、约 500px 宽的非模态覆盖层，使用共用覆盖层表面、边框与阴影，按三组列出 11 项当前真实支持的操作，以图示为主：每组一行四格，每格自上而下是标题、按键图示、操作方法。按键图示由键帽与一只小鼠标组成，鼠标上把用到的部位涂实——左键、右键涂半边且不画滚轮，滚轮与中键只画中间一颗实心滚轮，滚动与拖动再配方向线；键帽与鼠标之间用“+”连接。低矮窗口仅让浮层内容区滚动，不改变命令带或图表尺寸。帮助打开时，`Escape` 优先关闭帮助并把焦点返回入口，不清除轴组锁定；帮助状态不得进入 ECharts 高频更新链路。

### Settings Panel

设置是 360px 宽的独立无边框窗口，可拖到主窗口之外；高度随内容（1–3 根纵轴、行内错误）自动贴合，默认在命令带下方与右缘对齐打开，不改变主布局。标题栏与帮助浮层同形：42px 高、13px 标题、30px 关闭按钮。所有纵轴在同一张表中列出“下限 / 上限”，不使用页签；留空即自动，占位符以浅灰数字显示当前自动范围，仍可手动输入小数。数值字段使用自绘步进器：平时不出现，指针悬停或字段聚焦时才在右缘显示上下两格，按住可连续步进；按钮、上下方向键与滚轮走同一条规则——以当前值为起点、每次落到相邻整数（留空时从占位符显示的当前范围起步，而不是从 0 开始）。刻度格数为 1–9 格。操作只有“取消”（次要按钮）与“应用”（主按钮），回车应用、`Escape` 关闭；底部左侧另有“恢复默认”（回转箭头加文字的文本按钮）：把纵轴范围清回自动、格数回到 6，只改草稿，仍由“应用”生效；已是默认时置灰。

## Do's and Don'ts

### Do:

- **Do** 先让用户确认来源与设备，再通过时间范围、图例、滚轮缩放、中键平移和低干扰读数完成核对。
- **Do** 保持实测实线、设定虚线，并以 2.05–2.15px 对 1.35px 的线宽差明确判读层级。
- **Do** 将缺失、无效与停录呈现为真实断线，并让冲突与输入错误直接、可读地显露。
- **Do** 在 980×680px 验收窗口检查完整命令带、34px 图例带、至少 240px 台账和可操作图表。
- **Do** 为减少动态效果的用户关闭实质动画，并保持完整的键盘焦点、`F1` 帮助与 `Escape` 关闭语义。
- **Do** 让游标的轴线与读数卡片始终同显同隐；让时间输入、读数卡片与横轴刻度使用同一套写法（年-月-日 时:分:秒，24 小时制）。

### Don't:

- **Don't** 把来源、摘要、指标或图表拆成大圆角卡片，也不要新增装饰性仪表盘、标题横幅或营销式 KPI。
- **Don't** 将 BMW 蓝用于游标按钮、打开文件图标、设置页签、温度设定线或大面积背景。
- **Don't** 在命令带里混用文字按钮与图标按钮，也不要让同一个图标承担两种操作。
- **Don't** 用 `0`、插值或跨段连线伪装缺失数据，也不要让原型“合成轨迹”被误认为生产解析结果。
- **Don't** 让菜单、设置、游标或浮动卡片长期遮挡图表主要数据，或用常驻阴影抬高普通表面。
- **Don't** 因视觉更新改变滚轮缩放、中键平移、`Shift` 纵轴交互、图例切换、读数和 Canvas 绘制的流畅性。
