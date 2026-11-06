import { ArrowUpRight } from "lucide-react";
import { protocolTiers } from "@/lib/demo-data";
import { cn } from "@/lib/utils";

const tones = {
  light: "bg-[#ebebe8] text-[#111111] border-[#11111114]",
  dark: "bg-[#0b0b0b] text-white border-white/10",
  brand: "bg-[#bff24a] text-[#0c0c0c] border-[#0c0c0c22]",
};

const divider = {
  light: "border-[#11111126]",
  dark: "border-white/15",
  brand: "border-[#0c0c0c33]",
};

const muted = {
  light: "text-[#11111199]",
  dark: "text-white/45",
  brand: "text-[#0c0c0c99]",
};

export default function ProtocolTiers() {
  return (
    <section className="relative overflow-hidden bg-[#f4f4f1] py-20 text-[#111111] sm:py-24">
      <div className="dot-grid-light pointer-events-none absolute inset-0 opacity-70" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#f4f4f1] via-transparent to-[#f4f4f1]" />

      <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="mx-auto max-w-2xl text-balance text-center text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-[34px]">
          <span className="text-[#111111]/45">Introducing </span>
          <span className="font-bold">Three-Tier Launch Protocols</span>
          <span className="text-[#111111]/45"> on Launchly</span>
        </h2>

        <div className="mt-10 grid gap-3 md:grid-cols-3">
          {protocolTiers.map((tier) => (
            <article
              key={tier.name}
              className={cn(
                "group flex flex-col rounded-2xl border p-6 transition-transform duration-300 hover:-translate-y-1",
                tones[tier.tone]
              )}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold tracking-tight">{tier.name}</h3>
                <ArrowUpRight className="h-4 w-4 opacity-30 transition-opacity group-hover:opacity-70" />
              </div>
              <p className={cn("mt-3 text-[13px] font-medium leading-relaxed", muted[tier.tone])}>
                {tier.lead}
              </p>
              <div className={cn("my-5 border-t border-dashed", divider[tier.tone])} />
              <p className={cn("text-[12.5px] leading-relaxed", muted[tier.tone])}>{tier.body}</p>
              <div className="mt-auto pt-6">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-current px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] opacity-60">
                  {tier.tone === "brand" ? "Invite only" : tier.tone === "dark" ? "Reviewed" : "Open now"}
                </span>
              </div>
            </article>
          ))}
        </div>

        <div className="mt-16 flex flex-col items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[#111111] text-sm font-extrabold text-white">
            L
          </span>
          <span className="text-[13px] font-semibold tracking-tight text-[#111111]">Launchly</span>
        </div>
      </div>
    </section>
  );
}