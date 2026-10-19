type Props = {
  fileName?: string;
  timeRange?: { start: string; end: string };
  loading: boolean;
  onOpen: () => void;
};

export function FileToolbar({ fileName, timeRange, loading, onOpen }: Props) {
  return (
    <header className="toolbar">
      <div>
        <div className="app-title">实验箱数据查看器</div>
        <div className="file-meta">
          {fileName ? fileName : "未打开文件"}
          {timeRange ? ` · ${timeRange.start} 至 ${timeRange.end}` : ""}
        </div>
      </div>
      <button className="primary-button" type="button" onClick={onOpen} disabled={loading}>
        {loading ? "读取中..." : "打开文件"}
      </button>
    </header>
  );
}
