import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  loadSidebarCollapsed,
  storeSidebarCollapsed,
} from "../sidebarCollapsed";
import type { Dataset } from "../types";
import { AppMark } from "./AppMark";
import { UiIcon } from "./UiIcon";

type SidebarDataset = Pick<Dataset, "sourceId" | "sourceFile" | "sources">;

type Props = {
  datasets: SidebarDataset[];
  activeSourceId: string | null;
  loading: boolean;
  reading: boolean;
  collapsed?: boolean;
  width?: number | null;
  ref?: Ref<HTMLElement>;
  onCollapsedChange?: (collapsed: boolean) => void;
  onActivate: (sourceId: string) => void;
  onOpen: (replaceSourceId?: string) => void;
  onDelete: (sourceId: string) => void;
  onReorder: (sourceId: string, targetSourceId: string) => void;
};

const TOOLTIP_DELAY_MS = 800;
const TOOLTIP_MAX_WIDTH = 400;
const TOOLTIP_VIEWPORT_INSET = 8;

type TooltipState = {
  pathLines: string[];
  rect: DOMRect;
};

function tooltipPosition(
  rect: DOMRect,
  viewport: { width: number; height: number },
  width: number,
) {
  const gap = 8;
  const left = Math.max(
    TOOLTIP_VIEWPORT_INSET,
    Math.min(rect.right + gap, viewport.width - width - TOOLTIP_VIEWPORT_INSET),
  );
  const top = Math.max(
    TOOLTIP_VIEWPORT_INSET,
    Math.min(rect.top, viewport.height - 240),
  );
  return { left, top };
}

function sourceParent(sourceId: string): string {
  const separator = Math.max(sourceId.lastIndexOf("/"), sourceId.lastIndexOf("\\"));
  return separator >= 0 ? sourceId.slice(0, separator) : sourceId;
}

function sourceDetails(dataset: SidebarDataset) {
  const isGroup = dataset.sources.length > 1;
  const folder = sourceParent(dataset.sources[0]?.sourceId ?? dataset.sourceId);
  const names = dataset.sources.map((source) => source.sourceFile).join("、");
  const displayName = isGroup
    ? `已合并 ${dataset.sources.length} 个文件`
    : dataset.sourceFile;

  return { isGroup, folder, names, displayName };
}

function datasetAccessibleName(
  dataset: SidebarDataset,
  duplicateName: boolean,
): string {
  const details = sourceDetails(dataset);
  if (details.isGroup) {
    return `${details.displayName}（${details.folder}；来源：${details.names}）`;
  }
  return duplicateName
    ? `${details.displayName}（${dataset.sourceId}）`
    : details.displayName;
}

function sourcePathLines(dataset: SidebarDataset): string[] {
  return dataset.sources.length > 0
    ? dataset.sources.map((source) => source.sourceId)
    : [dataset.sourceId];
}

function hasDuplicateName(
  datasets: readonly SidebarDataset[],
  dataset: SidebarDataset,
): boolean {
  const name = dataset.sourceFile.toLocaleLowerCase("en-US");
  return (
    datasets.filter(
      (candidate) => candidate.sourceFile.toLocaleLowerCase("en-US") === name,
    ).length > 1
  );
}

type SidebarFileEntryProps = {
  dataset: SidebarDataset;
  index: number;
  isActive: boolean;
  isMenuOpen: boolean;
  loading: boolean;
  duplicateName: boolean;
  onActivate: (sourceId: string) => void;
  onOpen: (replaceSourceId?: string) => void;
  onDelete: (sourceId: string) => void;
  onOpenMenu: (sourceId: string) => void;
  onCloseMenu: () => void;
  onHover: (next: TooltipState) => void;
  onLeave: () => void;
};

function SidebarFileEntry({
  dataset,
  index,
  isActive,
  isMenuOpen,
  loading,
  duplicateName,
  onActivate,
  onOpen,
  onDelete,
  onOpenMenu,
  onCloseMenu,
  onHover,
  onLeave,
}: SidebarFileEntryProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: dataset.sourceId, disabled: loading });
  const details = sourceDetails(dataset);
  const displayName = details.displayName;
  const accessibleName = datasetAccessibleName(dataset, duplicateName);

  const handleMouseOver = (event: ReactMouseEvent<HTMLElement>) => {
    onHover({
      pathLines: sourcePathLines(dataset),
      rect: event.currentTarget.getBoundingClientRect(),
    });
  };

  return (
    <article
      className={`file-entry${isActive ? " is-active" : ""}${isDragging ? " is-dragging" : ""}`}
      key={dataset.sourceId}
      ref={setNodeRef}
      style={{
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        transition,
      }}
      {...attributes}
      role="group"
      aria-label={`已打开的数据文件：${accessibleName}`}
      {...listeners}
      data-od-id={`file-entry-${index}`}
      onMouseOver={handleMouseOver}
      onMouseOut={onLeave}
      onPointerDown={(event) => {
        onLeave();
        listeners?.onPointerDown?.(event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onLeave();
        if (loading) return;
        const entry = event.currentTarget;
        onOpenMenu(dataset.sourceId);
        window.requestAnimationFrame(() => {
          entry
            .querySelector<HTMLButtonElement>(".menu-trigger")
            ?.focus({ preventScroll: true });
        });
      }}
    >
      <button
        className="file-select"
        type="button"
        aria-label={`切换到文件 ${accessibleName}`}
        aria-current={isActive ? "page" : undefined}
        onClick={() => onActivate(dataset.sourceId)}
      >
        <span className="file-name">{displayName}</span>
        {details.isGroup ? (
          <span className="file-sources">{details.names}</span>
        ) : duplicateName ? (
          <span className="file-location">
            {sourceParent(dataset.sourceId)}
          </span>
        ) : null}
      </button>
      <div className="file-entry-actions" onMouseEnter={onLeave}>
        <button
          className="menu-trigger"
          type="button"
          aria-label={`${accessibleName} 文件操作`}
          aria-expanded={isMenuOpen}
          disabled={loading}
          onClick={(event) => {
            event.stopPropagation();
            if (loading) return;
            if (isMenuOpen) {
              onCloseMenu();
              return;
            }
            event.currentTarget
              .closest(".file-entry")
              ?.scrollIntoView?.({ block: "center", inline: "nearest" });
            onOpenMenu(dataset.sourceId);
          }}
        >
          <UiIcon name="more" />
        </button>
        {isMenuOpen ? (
          <div className="file-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              disabled={loading}
              onClick={() => {
                if (loading) return;
                onCloseMenu();
                onOpen(dataset.sourceId);
              }}
            >
              更换文件
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={loading}
              onClick={() => {
                if (loading) return;
                onCloseMenu();
                onDelete(dataset.sourceId);
              }}
            >
              关闭数据集
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function Sidebar({
  datasets,
  activeSourceId,
  loading,
  reading,
  collapsed: controlledCollapsed,
  width,
  ref,
  onCollapsedChange,
  onActivate,
  onOpen,
  onDelete,
  onReorder,
}: Props) {
  const [internalCollapsed, setInternalCollapsed] = useState(
    loadSidebarCollapsed,
  );
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const [openMenuSourceId, setOpenMenuSourceId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipElementRef = useRef<HTMLDivElement | null>(null);
  const tooltipTimerRef = useRef<number | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const clearTooltipTimer = useCallback(() => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  }, []);

  const scheduleTooltip = useCallback(
    (next: TooltipState) => {
      clearTooltipTimer();
      tooltipTimerRef.current = window.setTimeout(() => {
        tooltipTimerRef.current = null;
        setTooltip(next);
      }, TOOLTIP_DELAY_MS);
    },
    [clearTooltipTimer],
  );

  const cancelTooltip = useCallback(() => {
    clearTooltipTimer();
    setTooltip(null);
  }, [clearTooltipTimer]);

  useLayoutEffect(() => {
    const element = tooltipElementRef.current;
    if (!tooltip || !element) return;
    const measuredWidth = element.getBoundingClientRect().width || TOOLTIP_MAX_WIDTH;
    const position = tooltipPosition(
      tooltip.rect,
      { width: window.innerWidth, height: window.innerHeight },
      measuredWidth,
    );
    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
  }, [tooltip]);

  useEffect(() => {
    const handleBlur = () => cancelTooltip();
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("blur", handleBlur);
      clearTooltipTimer();
    };
  }, [cancelTooltip, clearTooltipTimer]);

  useEffect(() => {
    document.body.style.cursor = dragging ? "grabbing" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragging]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      const element = target instanceof Element ? target : null;
      if (!element?.closest(".file-entry-actions")) {
        setOpenMenuSourceId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuSourceId(null);
    };

    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const updateCollapsed = (next: boolean) => {
    if (controlledCollapsed === undefined) setInternalCollapsed(next);
    onCollapsedChange?.(next);
    if (next) {
      setOpenMenuSourceId(null);
      cancelTooltip();
    }
    storeSidebarCollapsed(next);
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    updateCollapsed(next);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false);
    if (over && active.id !== over.id) {
      onReorder(String(active.id), String(over.id));
    }
  };

  return (
    <aside
      id="data-source-sidebar"
      aria-label="数据来源"
      className={`sidebar${collapsed ? " is-collapsed" : ""}`}
      ref={ref}
      style={!collapsed && width ? { width: `${width}px` } : undefined}
      data-od-id="app-sidebar"
    >
      <header
        className="sidebar-header"
        data-od-id="sidebar-header"
        data-tauri-drag-region=""
      >
        <div className="brand-mark" aria-hidden="true" data-tauri-drag-region="deep">
          <AppMark />
        </div>
        <button
          className="sidebar-collapse-toggle"
          type="button"
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          <UiIcon name={collapsed ? "expand" : "collapse"} />
        </button>
        <h1 data-od-id="app-title" data-tauri-drag-region="">
          <span className="brand-name" data-tauri-drag-region="">试验箱数据查看器</span>{" "}
          <span className="brand-descriptor" data-tauri-drag-region="">chamber data viewer</span>
        </h1>
      </header>

      <div
        className={`file-list${dragging ? " is-dragging" : ""}`}
        aria-label="已打开的数据文件"
        data-od-id="sidebar-file-list"
        onScroll={cancelTooltip}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => {
            setOpenMenuSourceId(null);
            setDragging(true);
            cancelTooltip();
          }}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragging(false)}
        >
          <SortableContext
            items={datasets.map((item) => item.sourceId)}
            strategy={verticalListSortingStrategy}
          >
            {datasets.map((dataset, index) => {
              const duplicateName = hasDuplicateName(datasets, dataset);
              return (
                <SidebarFileEntry
                  key={dataset.sourceId}
                  dataset={dataset}
                  index={index}
                  isActive={dataset.sourceId === activeSourceId}
                  isMenuOpen={openMenuSourceId === dataset.sourceId}
                  loading={loading}
                  onActivate={onActivate}
                  onOpen={onOpen}
                  onDelete={onDelete}
                  onOpenMenu={setOpenMenuSourceId}
                  onCloseMenu={() => setOpenMenuSourceId(null)}
                  duplicateName={duplicateName}
                  onHover={scheduleTooltip}
                  onLeave={cancelTooltip}
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </div>
      {collapsed && datasets.length > 0 ? (
        <nav
          className="file-rail"
          aria-label="已打开的数据文件"
          data-od-id="sidebar-file-rail"
          onScroll={cancelTooltip}
        >
          {datasets.map((dataset, index) => {
            const isActive = dataset.sourceId === activeSourceId;
            const accessibleName = datasetAccessibleName(
              dataset,
              hasDuplicateName(datasets, dataset),
            );
            return (
              <button
                key={dataset.sourceId}
                className={`file-rail-item${isActive ? " is-active" : ""}`}
                type="button"
                aria-label={`切换到文件 ${accessibleName}`}
                aria-current={isActive ? "page" : undefined}
                onClick={() => onActivate(dataset.sourceId)}
                onMouseEnter={(event) =>
                  scheduleTooltip({
                    pathLines: sourcePathLines(dataset),
                    rect: event.currentTarget.getBoundingClientRect(),
                  })
                }
                onMouseLeave={cancelTooltip}
              >
                {index + 1}
              </button>
            );
          })}
        </nav>
      ) : null}

      <footer className="sidebar-footer" data-od-id="sidebar-open-data">
        <button
          className={`add-file-button${reading ? " is-reading" : ""}`}
          type="button"
          aria-label="添加数据文件"
          aria-busy={reading}
          disabled={loading}
          onClick={() => {
            if (loading) return;
            setOpenMenuSourceId(null);
            onOpen();
          }}
        >
          <span className="add-file-icon" aria-hidden="true">
            <UiIcon
              name={reading ? "loader" : "add"}
              size="md"
              className={reading ? "is-spinning" : undefined}
            />
          </span>
          <span className="add-file-copy">
            <strong>{reading ? "正在读取数据" : "打开数据文件"}</strong>
          </span>
        </button>
        <span
          className="sidebar-open-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {reading ? "正在读取数据，自动识别文件格式" : ""}
        </span>
      </footer>
      {tooltip
        ? createPortal(
            <div
              className="sidebar-tooltip"
              ref={tooltipElementRef}
              style={tooltipPosition(
                tooltip.rect,
                { width: window.innerWidth, height: window.innerHeight },
                TOOLTIP_MAX_WIDTH,
              )}
            >
              <div className="sidebar-tooltip-body">
                {tooltip.pathLines.map((line, index) => (
                  <div className="sidebar-tooltip-path" key={index}>
                    {line}
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}
