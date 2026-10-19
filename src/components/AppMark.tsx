export function AppMark() {
  return (
    <svg
      className="app-mark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="app-mark-frame"
        d="M15.5 3.5h-9a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h9"
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="app-mark-trace"
        d="M8 9h12M8 15h8"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
