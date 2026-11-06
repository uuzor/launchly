import { cn } from "@/lib/utils";

export default function StatTile({ label, value, hint, tone = "default", className = "" }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/[0.08] bg-[#0b0b0b] p-4 sm:p-5",
        tone === "brand" && "border-brand/25 bg-brand/[0.06]",
        className
      )}
    >
      <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">{label}</p>
      <p
        className={cn(
          "num mt-2 text-xl font-semibold text-white sm:text-2xl",
          tone === "brand" && "text-brand"
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1.5 text-[11px] leading-snug text-white/35">{hint}</p>}
    </div>
  );
}