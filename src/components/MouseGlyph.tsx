import type { ChartHelpMouse } from "../chartHelp";

/**
 * 一只小鼠标，把这次用到的部位涂实。左右键涂半边且不画滚轮，
 * 滚轮与中键只画中间一颗实心滚轮，两类一眼可分；滚动与拖动再配上方向线。
 */
export function MouseGlyph({
  action,
  size = 34,
}: {
  action: ChartHelpMouse;
  size?: number;
}) {
  const wheel = action === "scroll" || action === "middle-drag";
  return (
    <svg
      className="mouse-glyph"
      width={size}
      height={Math.round((size * 32) / 30)}
      viewBox="0 0 30 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {action === "left" ? (
        <path className="is-active" d="M5 13V10a7 7 0 0 1 7-7v10z" />
      ) : null}
      {action === "right" ? (
        <path className="is-active" d="M19 13V10a7 7 0 0 0-7-7v10z" />
      ) : null}
      <rect x="5" y="3" width="14" height="26" rx="7" />
      <path d="M5 13h14" />
      {wheel ? (
        // 用到滚轮或中键时只画中间一颗实心滚轮，不画左右键的分界线。
        <rect
          className="is-active"
          x="9.5"
          y="5.5"
          width="5"
          height="9"
          rx="2.5"
        />
      ) : (
        <path d="M12 3v10" />
      )}
      {action === "hover" ? (
        <rect
          x="10.25"
          y="6"
          width="3.5"
          height="6"
          rx="1.75"
          className="is-wheel"
        />
      ) : null}
      {action === "scroll" ? (
        <path d="m23 8 2.5-2.5L28 8M23 12l2.5 2.5L28 12" />
      ) : null}
      {action === "middle-drag" ? (
        <path d="M22 16h6.5M25.5 13l3 3-3 3M22 22.5h4" />
      ) : null}
      {action === "hover" ? <path d="M23 7.5h4M23 11h2.5" /> : null}
    </svg>
  );
}
