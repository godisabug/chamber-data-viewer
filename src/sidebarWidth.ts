export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_COLLAPSED_WIDTH = 48;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 420;
export const CHART_MIN_WIDTH = 560;

/** 侧栏拖动上限：固定上限，同时不允许侧栏挤占图表最小宽度。 */
export function effectiveSidebarMaxWidth(viewportWidth: number): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.max(SIDEBAR_MIN_WIDTH, viewportWidth - CHART_MIN_WIDTH),
    ),
  );
}
