import { Link } from "@tanstack/react-router";
import { ArrowRight, Plus } from "lucide-react";
import ParticleField from "@/components/shared/ParticleField";
import PartnerRow from "@/components/shared/PartnerRow";
import { partners } from "@/lib/demo-data";

const stats = [
  { label: "Products launched", value: "128" },
  { label: "Creator pool funded", value: "$1.42M" },
  { label: "Paid to creators", value: "$684K" },
  { label: "Chains via Intents", value: "9" },
];

export default function LandingHero() {
  return (
    <section className="relative overflow-hidden pb-16 pt-32 sm:pt-40">
      <ParticleField className="opacity-70" />
      <div className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-brand/[0.09] blur-[140px]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />

      <div className="relative mx-auto max-w-5xl px-4 text-center sm:px-6">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 backdrop-blur">
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-brand" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/60">
            Community-funded growth · Built on NEAR
          </span>
        </div>

        <h1 className="mt-7 text-balance text-[42px] font-semibold leading-[1.02] tracking-[-0.035em] text-white sm:text-6xl lg:text-[76px]">
          Tokenize your product.
          <br />
          <span className="bg-gradient-to-b from-white to-white/55 bg-clip-text text-transparent">
            Fund the future.
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-md text-[15px] text-white/45 sm:text-base">
          Launch. Trade. Promote. Grow.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/launch"
            className="group inline-flex w-full items-center justify-center gap-2 rounded-full bg-white px-7 py-3.5 text-[14px] font-semibold text-black transition-all hover:gap-3 hover:bg-white/92 sm:w-auto"
          >
            Launch your product
            <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" strokeWidth={2.6} />
          </Link>
          <Link
            to="/discover"
            className="group inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/15 px-7 py-3.5 text-[14px] font-medium text-white/80 transition-colors hover:border-white/30 hover:text-white sm:w-auto"
          >
            Explore products
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>

        <div className="mx-auto mt-16 grid max-w-3xl grid-cols-2 gap-y-6 border-y border-white/[0.07] py-7 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="px-2">
              <p className="num text-xl font-semibold text-white sm:text-2xl">{stat.value}</p>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-white/35">
                {stat.label}
              </p>
            </div>
          ))}
        </div>

        <div className="relative mt-12 overflow-hidden">
          <p className="text-center text-[9px] font-semibold uppercase tracking-[0.28em] text-white/20">
            Monitor all Launchly raises across NEAR, and 9 chains through Intents
          </p>
          <div className="relative mt-5 [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
            <div className="flex w-max animate-marquee gap-14 pr-14">
              {[...partners, ...partners].map((name, i) => (
                <span
                  key={`${name}-${i}`}
                  className="shrink-0 text-[12px] font-semibold uppercase tracking-[0.2em] text-white/25"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="sr-only">
        <PartnerRow items={partners} />
      </div>
    </section>
  );
}