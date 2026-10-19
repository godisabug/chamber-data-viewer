import { useEffect, useRef, useState } from "react";
import { UiIcon } from "./UiIcon";

type Props = {
  message: string;
  onDismiss: () => void;
};

/** Long enough to read a two-line reason; hovering keeps it open. */
export const ERROR_BANNER_AUTO_DISMISS_MS = 8000;

export function ErrorBanner({ message, onDismiss }: Props) {
  const [hovered, setHovered] = useState(false);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (hovered) return;
    const timer = window.setTimeout(
      () => onDismissRef.current(),
      ERROR_BANNER_AUTO_DISMISS_MS,
    );
    return () => window.clearTimeout(timer);
  }, [hovered, message]);

  return (
    <div
      className="error-banner"
      role="alert"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <strong>无法载入数据</strong>
      <span>{message}</span>
      <button
        className="error-banner-close"
        type="button"
        aria-label="关闭提示"
        onClick={onDismiss}
      >
        <UiIcon name="close" />
      </button>
    </div>
  );
}
