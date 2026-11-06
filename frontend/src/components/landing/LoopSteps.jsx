import {
  BadgeCheck,
  CandlestickChart,
  Megaphone,
  PiggyBank,
  Rocket,
} from "lucide-react";
import { loopSteps } from "@/lib/demo-data";

const icons = { Rocket, CandlestickChart, PiggyBank, Megaphone, BadgeCheck };

export default function LoopSteps() {
  return (
    <section className="relative border-t border-white/[0.06] py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-brand">
              The economic loop
            </p>
            <h2 className="mt-3 max-w-lg text-3xl font-semibold leading-tight text-white sm:text-4xl">
              One loop, five on-chain steps.
            </h2>
          </div>
          <p className="max-w-sm text-sm leading-relaxed text-white/40">
            Every rule — the fee, the split, the lock — is fixed when the coin launches. Traders can
            trust it will not change after they buy.
          </p>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {loopSteps.map((step, i) => {
            const Icon = icons[step.icon] || Rocket;
            return (
              <div
                key={step.step}
                className="group relative rounded-2xl border border-white/[0.08] bg-[#0c0c0c] p-5 transition-colors hover:border-brand/30 hover:bg-[#101010]"
              >
                <div className="flex items-center justify-between">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand/10 text-brand">
                    <Icon className="h-4 w-4" strokeWidth={1.9} />
                  </span>
                  <span className="num text-[11px] text-white/20">{step.step}</span>
                </div>
                <h3 className="mt-4 text-[15px] font-semibold text-white">{step.title}</h3>
                <p className="mt-2 text-[12.5px] leading-relaxed text-white/40">{step.body}</p>
                {i < loopSteps.length - 1 && (
                  <span className="absolute -right-1.5 top-1/2 hidden h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-white/15 lg:block" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}