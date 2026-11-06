import { Check, Lock, Percent } from "lucide-react";
import { tokenomics } from "@/lib/demo-data";
import { cn } from "@/lib/utils";

const params = [
  { label: "Trade fee", value: "1.00%", note: "Allowed range 0.5%–2%, fixed at launch" },
  { label: "Total supply", value: "1,000,000,000", note: "Same for every product coin" },
  { label: "Sold on curve", value: "900,000,000", note: "90% priced by the bonding curve" },
  { label: "Founder allocation", value: "100,000,000", note: "10%, locked in the vesting contract" },
];

export default function LaunchStepCoin({ form, set }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {params.map((p) => (
          <div key={p.label} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/30">{p.label}</p>
            <p className="num mt-1.5 text-lg font-semibold text-white">{p.value}</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-white/30">{p.note}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-white/[0.08] p-4">
        <div className="flex items-center gap-2">
          <Percent className="h-3.5 w-3.5 text-brand" />
          <p className="text-[11.5px] font-medium text-white/70">Fee split, written into the fee router</p>
        </div>
        <div className="mt-3 flex h-2 overflow-hidden rounded-full">
          <div className="h-full bg-brand" style={{ width: "70%" }} />
          <div className="h-full bg-indigo-400/70" style={{ width: "20%" }} />
          <div className="h-full bg-amber-400/70" style={{ width: "10%" }} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <div>
            <p className="flex items-center gap-1.5 text-white/45">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" /> Pool
            </p>
            <p className="num mt-0.5 text-white/80">70%</p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-white/45">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-400/70" /> Ops
            </p>
            <p className="num mt-0.5 text-white/80">20%</p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-white/45">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400/70" /> Founder
            </p>
            <p className="num mt-0.5 text-white/80">10%</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.08] p-4">
        <div className="flex items-center gap-2">
          <Lock className="h-3.5 w-3.5 text-white/40" />
          <p className="text-[11.5px] font-medium text-white/70">Unlock schedule</p>
        </div>
        <div className="mt-3 flex gap-1.5">
          {Array.from({ length: tokenomics.tranches }).map((_, i) => (
            <div key={i} className="flex-1">
              <div className="h-1.5 rounded-full bg-white/[0.08]" />
              <p className="mt-1.5 text-[9.5px] text-white/30">T{i + 1} · 25M</p>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[10.5px] leading-relaxed text-white/30">
          Each tranche releases only after holders approve a published milestone. Unapproved
          tranches are burned after the deadline.
        </p>
      </div>

      <button
        type="button"
        onClick={() => set("acknowledged", !form.acknowledged)}
        className={cn(
          "flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
          form.acknowledged ? "border-brand/35 bg-brand/[0.06]" : "border-white/10 hover:border-white/20"
        )}
      >
        <span
          className={cn(
            "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border",
            form.acknowledged ? "border-brand bg-brand text-black" : "border-white/25"
          )}
        >
          {form.acknowledged && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
        <span className="text-[11.5px] leading-relaxed text-white/55">
          I understand these parameters are fixed when the coin launches and cannot be changed
          afterwards. This is a testnet prototype and no real funds are handled.
        </span>
      </button>
    </div>
  );
}