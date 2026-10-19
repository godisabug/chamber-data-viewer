import type { ReactNode } from "react";
import type { ChartHelpMouse } from "../chartHelp";
import { AppMark } from "./AppMark";
import { MouseGlyph } from "./MouseGlyph";
import { UiIcon } from "./UiIcon";

type Props = {
  reading: boolean;
};

const key = (name: string) => <kbd className="keycap">{name}</kbd>;
const mouse = (action: ChartHelpMouse, label: string) => (
  <>
    <MouseGlyph action={action} size={22} />
    {label}
  </>
);

/**
 * 载入数据之前先让人知道进来以后怎么用：打开方式在前，图表的常用操作在后。
 * 右列分成“修饰键 / 加号 / 主操作”三栏，各行的同类内容上下对齐。
 */
const HINTS: ReadonlyArray<{
  label: string;
  modifier?: string;
  action: ReactNode;
}> = [
  { label: "打开数据文件", modifier: "Ctrl", action: key("O") },
  { label: "载入多个文件", action: "拖入窗口" },
  { label: "缩放时间轴", action: mouse("scroll", "滚轮") },
  { label: "平移时间轴", action: mouse("middle-drag", "中键拖动") },
  { label: "缩放纵轴", modifier: "Shift", action: mouse("scroll", "滚轮") },
  {
    label: "平移纵轴",
    modifier: "Shift",
    action: mouse("middle-drag", "中键拖动"),
  },
  { label: "载入后查看全部操作", action: key("F1") },
];

/**
 * 未载入数据时的工作区：一枚淡水印加一张操作清单。
 * 打开文件的入口只保留侧栏底部那一个，这里不再重复放按钮。
 */
export function EmptyState({ reading }: Props) {
  const label = reading ? "正在读取数据" : "未加载数据文件";
  return (
    <section
      className={`empty-state${reading ? " is-loading" : ""}`}
      data-od-id="empty-state"
      aria-label={label}
      aria-busy={reading}
    >
      {reading ? (
        <div className="empty-state-content">
          <UiIcon name="loader" size="lg" className="is-spinning" />
          <p>正在读取数据…</p>
        </div>
      ) : (
        <div className="empty-state-content">
          <AppMark />
          <dl className="empty-state-hints">
            {HINTS.map((hint) => (
              <div key={hint.label}>
                <dt>{hint.label}</dt>
                <dd>
                  <span>{hint.modifier ? key(hint.modifier) : null}</span>
                  <span>{hint.modifier ? "+" : null}</span>
                  <span>{hint.action}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
