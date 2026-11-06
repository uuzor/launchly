import { useId } from "react";
import { cn } from "@/lib/utils";

export default function Sparkline({ points = [], positive = true, height = 40, className = "" }) {
  const id = useId().replace(/:/g, "");
  if (!points || points.length < 2) return <div className={cn("h-full w-full", className)} />;

  const w = 100;
  const h = height;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const coords = points.map((p, i) => [
    (i / (points.length - 1)) * w,
    h - 3 - ((p - min) / span) * (h - 6),
  ]);
  const line = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c[0].toFixed(2)},${c[1].toFixed(2)}`)
    .join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  const stroke = positive ? "hsl(var(--up))" : "hsl(var(--down))";

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="presentation"
      className={cn("w-full", className)}
      style={{ height }}
    >
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${id})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}