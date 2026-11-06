import { cn } from "@/lib/utils";

/** Provenance badge: every figure is either chain-backed or labelled simulated. */
export default function DataBadge({ live, className = "" }) {
  if (live) {
    return (
      <span
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/[0.07] px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-brand",
          className
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-brand" />
        Live · testnet
      </span>
    );
  }
  return (
    <span
      className={cn(
        "rounded-full border border-white/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-white/35",
        className
      )}
    >
      Simulated
    </span>
  );
}
