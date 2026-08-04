import { useEffect, useRef, useState } from "react";

const TOOLTIP_DELAY_MS = 600;

export interface DelayedTooltipState {
  x: number;
  y: number;
  text: string;
  label?: string;
}

export interface DelayedTooltipApi {
  tooltip: DelayedTooltipState | null;
  showTooltipDelayed: (text: string, evt: React.MouseEvent, label?: string) => void;
  hideTooltip: () => void;
  trackMouseMove: (evt: React.MouseEvent) => void;
}

export function useDelayedTooltip(delayMs: number = TOOLTIP_DELAY_MS): DelayedTooltipApi {
  const [tooltip, setTooltip] = useState<DelayedTooltipState | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showTooltipDelayed = (text: string, evt: React.MouseEvent, label?: string) => {
    if (!text) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const x = evt.clientX;
    const y = evt.clientY;
    hoverTimerRef.current = setTimeout(() => setTooltip({ x, y, text, label }), delayMs);
  };

  const hideTooltip = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setTooltip(null);
  };

  const trackMouseMove = (evt: React.MouseEvent) => {
    if (!tooltip) return;
    const x = evt.clientX;
    const y = evt.clientY;
    setTooltip(t => (t ? { ...t, x, y } : t));
  };

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  return { tooltip, showTooltipDelayed, hideTooltip, trackMouseMove };
}

export interface DelayedTooltipPortalProps {
  tooltip: DelayedTooltipState | null;
  width?: number;
  maxLen?: number;
  defaultLabel?: string;
}

export function DelayedTooltipPortal({ tooltip, width = 480, maxLen = 1200, defaultLabel }: DelayedTooltipPortalProps) {
  if (!tooltip) return null;
  const PAD = 16;
  const left = Math.min(Math.max(PAD, tooltip.x + 14), window.innerWidth - width - PAD);
  const top = Math.min(tooltip.y + 14, window.innerHeight - 200);
  const label = tooltip.label || defaultLabel;
  const text = tooltip.text.length > maxLen ? tooltip.text.slice(0, maxLen) + "…" : tooltip.text;
  return (
    <div
      className="fixed z-[200] pointer-events-none rounded-md bg-[#0f172a] text-white text-[12px] leading-snug shadow-2xl border border-white/10 px-3 py-2 whitespace-pre-wrap break-words"
      style={{ left, top, width, maxHeight: 320, overflow: "hidden" }}
      role="tooltip"
    >
      {label && <div className="text-[10px] uppercase tracking-wide text-white/60 mb-1">{label}</div>}
      {text}
    </div>
  );
}
