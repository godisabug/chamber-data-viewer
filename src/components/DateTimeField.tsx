import {
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { formatTimeRangeInput, parseTimeRangeInput } from "../chartRange";
import {
  TIME_SEGMENTS,
  isSegmentedTimeText,
  normalizeTimeTyping,
  segmentIndexForSelection,
  stepTimeSegment,
  typeSegmentDigit,
} from "../timeField";
import { UiIcon } from "./UiIcon";

type DateTimeFieldProps = {
  id: string;
  /** 字段名称，例如“开始时间”。 */
  label: string;
  /** 草稿文本；只有固定写法才启用分段编辑，其余内容按普通文本处理。 */
  value: string;
  /** 打开文件时的默认时间；草稿与它不同时才出现“恢复默认”按钮。 */
  defaultTime: number;
  invalid: boolean;
  describedBy?: string;
  onChange: (text: string) => void;
  /** 在输入框内按 Enter。 */
  onCommit: () => void;
  /** 点了“恢复默认”。 */
  onRestoreDefault: () => void;
};

type Selection = readonly [start: number, end: number];

const LAST_SEGMENT = TIME_SEGMENTS.length - 1;
const SEPARATOR_KEYS = new Set(["-", "/", ".", ":", " "]);
const END_OF_TEXT: Selection = [
  TIME_SEGMENTS[LAST_SEGMENT].end,
  TIME_SEGMENTS[LAST_SEGMENT].end,
];

const segmentSelection = (index: number): Selection => [
  TIME_SEGMENTS[index].start,
  TIME_SEGMENTS[index].end,
];

/**
 * 时间输入框：文本固定为 `YYYY-MM-DD HH:mm:ss`。
 * 点击某一段即选中它，可直接键入或用方向键步进；整段文本仍可全选、复制、粘贴。
 * 草稿偏离默认时间时，右侧出现“恢复默认”按钮。
 */
export function DateTimeField({
  id,
  label,
  value,
  defaultTime,
  invalid,
  describedBy,
  onChange,
  onCommit,
  onRestoreDefault,
}: DateTimeFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 受控输入框改值后光标会跳到末尾；改值的同时记下渲染后要恢复的选区。 */
  const pendingSelectionRef = useRef<{ text: string; selection: Selection } | null>(
    null,
  );
  /** 当前段里已经键入、还在等下一位的数字。 */
  const typingRef = useRef<{ index: number; digits: string } | null>(null);
  const clickedSegmentRef = useRef<number | null>(null);
  const pressPointRef = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    if (pending === null) return;
    pendingSelectionRef.current = null;
    const input = inputRef.current;
    if (
      input &&
      document.activeElement === input &&
      input.value === pending.text
    ) {
      input.setSelectionRange(pending.selection[0], pending.selection[1]);
    }
  });

  const select = (selection: Selection) => {
    inputRef.current?.setSelectionRange(selection[0], selection[1]);
  };

  /** 写入新文本并把选区放到指定位置。 */
  const writeText = (text: string, selection: Selection) => {
    if (text === value) {
      select(selection);
      return;
    }
    pendingSelectionRef.current = { text, selection };
    onChange(text);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // 输入法组字期间的按键交给输入法，结果由 onChange 接住。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      typingRef.current = null;
      onCommit();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!isSegmentedTimeText(value)) return;

    const input = event.currentTarget;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const index = segmentIndexForSelection(start, end);

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // 按住 Shift 是在扩选文本；光标只是停在段内时，按字符移动。
      if (event.shiftKey || start === end) return;
      event.preventDefault();
      typingRef.current = null;
      const backward = event.key === "ArrowLeft";
      select(
        segmentSelection(
          index === null
            ? backward
              ? 0
              : LAST_SEGMENT
            : Math.min(LAST_SEGMENT, Math.max(0, index + (backward ? -1 : 1))),
        ),
      );
      return;
    }
    if (index === null) return;

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      typingRef.current = null;
      writeText(
        stepTimeSegment(value, index, event.key === "ArrowUp" ? 1 : -1),
        segmentSelection(index),
      );
      return;
    }
    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      const typing = typingRef.current;
      const result = typeSegmentDigit(
        value,
        index,
        typing?.index === index ? typing.digits : "",
        event.key,
      );
      typingRef.current = result.advance
        ? null
        : { index, digits: result.pending };
      writeText(
        result.text,
        segmentSelection(
          result.advance ? Math.min(LAST_SEGMENT, index + 1) : index,
        ),
      );
      return;
    }
    if (SEPARATOR_KEYS.has(event.key)) {
      // 分隔符是固定的：键入它只表示“这一段写完了”，不会改动文本。
      event.preventDefault();
      if (typingRef.current?.index === index) {
        typingRef.current = null;
        select(segmentSelection(Math.min(LAST_SEGMENT, index + 1)));
      }
      return;
    }
    // 其余可见字符会破坏固定写法，直接忽略；删除键仍可清空这一段后重填。
    if (event.key.length === 1) event.preventDefault();
  };

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const text = normalizeTimeTyping(event.target.value);
    typingRef.current = null;
    // 逐字符补回一段（例如删掉“日”再键入）让文本恢复固定写法时，接回分段编辑：
    // 这一段已写满就跳到下一段，只写了前几位则继续等它的后续数字。
    if (isSegmentedTimeText(text) && !isSegmentedTimeText(value)) {
      const caret = event.target.selectionStart ?? text.length;
      const index = segmentIndexForSelection(caret, caret);
      if (index !== null) {
        const segment = TIME_SEGMENTS[index];
        if (caret === segment.end) {
          pendingSelectionRef.current = {
            text,
            selection: segmentSelection(Math.min(LAST_SEGMENT, index + 1)),
          };
        } else if (caret > segment.start) {
          typingRef.current = {
            index,
            digits: text.slice(segment.start, caret),
          };
          pendingSelectionRef.current = {
            text,
            selection: segmentSelection(index),
          };
        }
      }
    }
    onChange(text);
  };

  const paste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const time = parseTimeRangeInput(
      normalizeTimeTyping(event.clipboardData.getData("text")),
    );
    // 粘贴的是一个完整时间时整体替换；否则按普通文本粘贴。
    if (!Number.isFinite(time)) return;
    event.preventDefault();
    typingRef.current = null;
    writeText(formatTimeRangeInput(time), END_OF_TEXT);
  };

  const click = (event: ReactMouseEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (!isSegmentedTimeText(input.value) || event.detail >= 3) return;
    if (event.detail === 2) {
      // 双击时浏览器会按“词”选中，可能跨过冒号；改回首次点击的那一段。
      if (clickedSegmentRef.current !== null) {
        select(segmentSelection(clickedSegmentRef.current));
      }
      return;
    }

    const selectClickedSegment = () => {
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      if (start !== end || !isSegmentedTimeText(input.value)) return;
      const index = segmentIndexForSelection(start, end);
      clickedSegmentRef.current = index;
      if (index === null) return;
      typingRef.current = null;
      select(segmentSelection(index));
    };
    if (input.selectionStart === input.selectionEnd) {
      selectClickedSegment();
      return;
    }
    // 选区非空有两种情况：拖选出的范围保持原样，方便复制任意一部分；
    // 只是点在已有选区里时，浏览器要等这次点击结束才折叠选区，稍后再取段。
    const press = pressPointRef.current;
    const dragged =
      press !== null &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3;
    if (!dragged) window.setTimeout(selectClickedSegment, 0);
  };

  const blur = () => {
    typingRef.current = null;
    // 离开输入框时把可识别的写法（如 2026/5/2 7:57）整理成固定格式。
    if (isSegmentedTimeText(value)) return;
    const time = parseTimeRangeInput(value);
    if (Number.isFinite(time)) onChange(formatTimeRangeInput(time));
  };

  const defaultText = formatTimeRangeInput(defaultTime);

  return (
    <div className="time-field" data-invalid={invalid || undefined}>
      <input
        aria-describedby={describedBy}
        aria-invalid={invalid}
        autoComplete="off"
        id={id}
        inputMode="numeric"
        onBlur={blur}
        onChange={change}
        onClick={click}
        onKeyDown={keyDown}
        onMouseDown={(event) => {
          pressPointRef.current = { x: event.clientX, y: event.clientY };
        }}
        onPaste={paste}
        placeholder="年-月-日 时:分:秒"
        ref={inputRef}
        spellCheck={false}
        type="text"
        value={value}
      />
      {value !== defaultText ? (
        <button
          aria-label={`恢复默认${label}`}
          className="time-field-restore"
          data-tip={`恢复默认 ${defaultText}`}
          onClick={() => {
            typingRef.current = null;
            onRestoreDefault();
          }}
          type="button"
        >
          <UiIcon name="restore" />
        </button>
      ) : null}
    </div>
  );
}
