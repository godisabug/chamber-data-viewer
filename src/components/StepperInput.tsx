import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { StepDirection } from "../chartSettings";
import { UiIcon } from "./UiIcon";

type StepperInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "onKeyDown"
> & {
  /** 字段名称，用于输入框与两个步进按钮的朗读文本，例如“温度下限”。 */
  label: string;
  onStep: (direction: StepDirection) => void;
};

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

/**
 * 数值输入框与自绘步进器。浏览器原生步进在留空时一律从 0 起步，
 * 所以按钮、上下方向键和滚轮三条步进路径都收口到 onStep，由调用方决定起点。
 */
export function StepperInput({ label, onStep, ...inputProps }: StepperInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onStepRef = useRef(onStep);
  const repeatRef = useRef<{ delay: number | null; interval: number | null }>({
    delay: null,
    interval: null,
  });

  useLayoutEffect(() => {
    onStepRef.current = onStep;
  }, [onStep]);

  const stopRepeat = useCallback(() => {
    const repeat = repeatRef.current;
    if (repeat.delay !== null) window.clearTimeout(repeat.delay);
    if (repeat.interval !== null) window.clearInterval(repeat.interval);
    repeat.delay = null;
    repeat.interval = null;
    window.removeEventListener("blur", stopRepeat);
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // React 的 wheel 监听是被动的，无法阻止原生步进，这里直接挂非被动监听。
    const wheel = (event: WheelEvent) => {
      if (document.activeElement !== input || event.deltaY === 0) return;
      event.preventDefault();
      onStepRef.current(event.deltaY < 0 ? 1 : -1);
    };
    input.addEventListener("wheel", wheel, { passive: false });
    return () => {
      input.removeEventListener("wheel", wheel);
      stopRepeat();
    };
  }, [stopRepeat]);

  const press =
    (direction: StepDirection) =>
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      inputRef.current?.focus();
      stopRepeat();
      onStepRef.current(direction);
      // 按住不放时连续步进，手感与原生步进按钮一致。
      repeatRef.current.delay = window.setTimeout(() => {
        repeatRef.current.interval = window.setInterval(
          () => onStepRef.current(direction),
          REPEAT_INTERVAL_MS,
        );
      }, REPEAT_DELAY_MS);
      window.addEventListener("blur", stopRepeat);
    };

  const stepButton = (direction: StepDirection) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${direction > 0 ? "增加" : "减少"}${label}`}
      // 阻止按钮夺走焦点，输入框保持可继续键入、回车应用。
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={press(direction)}
      onPointerUp={stopRepeat}
      onPointerLeave={stopRepeat}
      onPointerCancel={stopRepeat}
      onClick={(event) => {
        // 指针点击已在按下时处理；这里只响应键盘与辅助技术触发的点击。
        if (event.detail === 0) onStepRef.current(direction);
      }}
    >
      <UiIcon name={direction > 0 ? "step-up" : "step-down"} size="xs" />
    </button>
  );

  return (
    <div className="stepper-field">
      <input
        {...inputProps}
        ref={inputRef}
        type="number"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onStepRef.current(event.key === "ArrowUp" ? 1 : -1);
        }}
      />
      <span className="stepper-buttons">
        {stepButton(1)}
        {stepButton(-1)}
      </span>
    </div>
  );
}
