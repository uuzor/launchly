import { cn } from "@/lib/utils";

export default function PartnerRow({ items = [], className = "", itemClassName = "" }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-x-8 gap-y-4", className)}>
      {items.map((name) => (
        <span
          key={name}
          className={cn(
            "text-[11px] font-semibold uppercase tracking-[0.22em] text-white/40 transition-colors hover:text-white/75",
            itemClassName
          )}
        >
          {name}
        </span>
      ))}
    </div>
  );
}