import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CHART_HELP_SECTIONS, type ChartHelpMouse } from "../chartHelp";
import { activateKeyboardFocusNav } from "../keyboardFocus";
import { MouseGlyph } from "./MouseGlyph";
import { UiIcon } from "./UiIcon";

type Props = {
  onOpenChange?: (open: boolean) => void;
};

const HELP_LABEL = "图表操作速查（F1）";

const MOUSE_LABELS: Record<ChartHelpMouse, string> = {
  hover: "悬停",
  scroll: "滚动滚轮",
  "middle-drag": "按住中键拖动",
  left: "单击",
  right: "右键单击",
};

export function ChartHelpPopover({ onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogId = useId();
  const titleId = `${dialogId}-title`;

  const updateOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const closeAndRestoreFocus = useCallback(() => {
    updateOpen(false);
    triggerRef.current?.focus();
  }, [updateOpen]);

  useLayoutEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F1") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        activateKeyboardFocusNav();
        if (open) closeAndRestoreFocus();
        else updateOpen(true);
        return;
      }
      if (!open || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      activateKeyboardFocusNav();
      closeAndRestoreFocus();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeAndRestoreFocus, open, updateOpen]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (anchorRef.current?.contains(event.target as Node)) return;
      updateOpen(false);
    };
    const closeOnWindowBlur = () => updateOpen(false);

    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("blur", closeOnWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("blur", closeOnWindowBlur);
    };
  }, [open, updateOpen]);

  return (
    <div className="chart-help-anchor" ref={anchorRef}>
      <button
        aria-controls={open ? dialogId : undefined}
        aria-expanded={open}
        aria-label={HELP_LABEL}
        className="tertiary-button tool-button chart-help-trigger"
        onClick={() => {
          if (open) closeAndRestoreFocus();
          else updateOpen(true);
        }}
        ref={triggerRef}
        data-tip={open ? undefined : HELP_LABEL}
        type="button"
      >
        <UiIcon name="help" size="md" />
      </button>

      {open ? (
        <div
          aria-labelledby={titleId}
          className="chart-help-popover"
          id={dialogId}
          role="dialog"
        >
          <div className="chart-help-heading">
            <h3 id={titleId}>图表操作速查</h3>
            <button
              aria-label="关闭图表操作速查"
              className="chart-help-close"
              onClick={closeAndRestoreFocus}
              ref={closeRef}
              type="button"
            >
              <UiIcon name="close" />
            </button>
          </div>
          <div className="chart-help-body">
            {CHART_HELP_SECTIONS.map((section) => (
              <section className="chart-help-section" key={section.id}>
                <h4>{section.title}</h4>
                <ul className="chart-help-tiles">
                  {section.actions.map((action) => (
                    <li
                      className="chart-help-tile"
                      key={action.id}
                      title={action.result}
                    >
                      <span className="chart-help-result">
                        {action.visual.caption}
                      </span>
                      <div className="chart-help-gesture" aria-hidden="true">
                        {action.visual.keys?.map((keyName) => (
                          <kbd className="keycap" key={keyName}>
                            {keyName}
                          </kbd>
                        ))}
                        {action.visual.keys && action.visual.mouse ? (
                          <span className="chart-help-plus">+</span>
                        ) : null}
                        {action.visual.mouse ? (
                          <MouseGlyph action={action.visual.mouse} />
                        ) : null}
                      </div>
                      <span className="chart-help-where">
                        {action.visual.mouse
                          ? `${MOUSE_LABELS[action.visual.mouse]}${action.visual.where ?? ""}`
                          : "按键"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
