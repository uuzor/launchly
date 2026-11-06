import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export default function ParticleField({ className = "", gap = 26 }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let dots = [];
    let raf = 0;
    let start = 0;

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = [];
      const cols = Math.ceil(width / gap) + 1;
      const rows = Math.ceil(height / gap) + 1;
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          dots.push({ x: x * gap, y: y * gap, r: 0.6 + (x * 7 + y * 13) % 5 * 0.28 });
        }
      }
    };

    const draw = (t) => {
      ctx.clearRect(0, 0, width, height);
      const phase = (t - start) / 2600;
      for (let i = 0; i < dots.length; i += 1) {
        const d = dots[i];
        const shimmer = reduce ? 0 : 0.16 * Math.sin(phase + (d.x + d.y) / 120);
        ctx.beginPath();
        ctx.fillStyle = `rgba(235, 240, 230, ${0.13 + shimmer})`;
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    build();
    start = performance.now();
    raf = requestAnimationFrame(draw);

    const ro = new ResizeObserver(() => {
      build();
      if (reduce) draw(performance.now());
    });
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [gap]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    />
  );
}