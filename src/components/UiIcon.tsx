import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  createLucideIcon,
  Ellipsis,
  FileChartColumn,
  Lock,
  LoaderCircle,
  Maximize,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";

/** 游标的样子：一条竖线和贴在旁边的读数卡片。Lucide 没有对应图形，按同一网格自绘。 */
const CursorReadout = createLucideIcon("cursor-readout", [
  ["path", { d: "M5 3v18", key: "line" }],
  ["rect", { x: "9.5", y: "6", width: "10.5", height: "8", rx: "1", key: "card" }],
]);

export type UiIconName =
  | "add"
  | "close"
  | "collapse"
  | "cursor"
  | "expand"
  | "file-chart"
  | "fit-view"
  | "help"
  | "lock"
  | "loader"
  | "more"
  | "restore"
  | "settings"
  | "step-down"
  | "step-up";

export type UiIconSize = "xs" | "sm" | "md" | "lg";

const ICONS: Record<UiIconName, LucideIcon> = {
  add: Plus,
  close: X,
  collapse: ChevronLeft,
  cursor: CursorReadout,
  expand: ChevronRight,
  "file-chart": FileChartColumn,
  help: CircleHelp,
  lock: Lock,
  loader: LoaderCircle,
  more: Ellipsis,
  "fit-view": Maximize,
  restore: RotateCcw,
  settings: SlidersHorizontal,
  "step-down": ChevronDown,
  "step-up": ChevronUp,
};

const ICON_SIZES: Record<UiIconSize, number> = {
  xs: 12,
  sm: 16,
  md: 18,
  lg: 40,
};

type Props = {
  name: UiIconName;
  size?: UiIconSize;
  className?: string;
};

export function UiIcon({ name, size = "sm", className }: Props) {
  const Icon = ICONS[name];
  const classes = ["ui-icon", className].filter(Boolean).join(" ");

  return (
    <Icon
      className={classes}
      size={ICON_SIZES[size]}
      strokeWidth={1.5}
      absoluteStrokeWidth
      aria-hidden="true"
      focusable="false"
    />
  );
}
