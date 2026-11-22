import type { ReactNode, PointerEvent as RPointerEvent } from "react";

interface Props {
  from: number;
  to: number;
  t: number;
  label: string;
  onSeek(t: number): void;
  className?: string;
  children?: ReactNode;
}

/** Anything with time left to right. Press or drag anywhere on it to seek. */
export function Track({ from, to, t, label, onSeek, className = "", children }: Props) {
  const span = to - from || 1;
  const seek = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(from + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * span);
  };
  const step = { ArrowLeft: -0.01, ArrowRight: 0.01 } as Record<string, number>;
  return (
    <div
      className={`wv-track ${className}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={Math.round(from)}
      aria-valuemax={Math.round(to)}
      aria-valuenow={Math.round(Math.min(to, Math.max(from, t)))}
      onPointerDown={(e) => {
        if ((e.target as Element).closest("button")) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && seek(e)}
      onKeyDown={(e) => {
        const d = step[e.key];
        if (d === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        onSeek(Math.min(to, Math.max(from, t + d * span)));
      }}
    >
      {children}
      {t >= from && t <= to && <i className="wv-head" style={{ left: `${((t - from) / span) * 100}%` }} />}
    </div>
  );
}
