import { Link } from "@tanstack/react-router";
import { ArrowRight, Coins, Rocket, ShieldCheck } from "lucide-react";
import PartnerRow from "@/components/shared/PartnerRow";
import { partners } from "@/lib/demo-data";

const pillars = [
  {
    icon: Coins,
    title: "Fees fund the growth",
    body: "A fixed 1% of every trade splits on-chain: 70% to the creator pool, 20% to operations, 10% to the founder. Locked at launch and hashed, so nobody can rewrite it later.",
  },
  {
    icon: Rocket,
    title: "Creators are paid for proof",
    body: "A post counts only when it matches the published rules and passes verification. The pool pays out pro rata by score, in the reserve stablecoin, wherever the creator asks for it.",
  },
  {
    icon: ShieldCheck,
    title: "Founders unlock by delivery",
    body: "Founder supply sits in the vesting contract and releases in four tranches, each one opened by a snapshot vote of holders — never by the founder alone.",
  },
];

const flow = [
  { label: "Trade volume · 24h", value: "$84,920", muted: true },
  { label: "1% trade fee", value: "$849", muted: false },
  { label: "→ Creator pool · 70%", value: "$594", brand: true },
  { label: "→ Operations · 20%", value: "$170", muted: true },
  { label: "→ Founder · 10%", value: "$85", muted: true },
];

export default function LaunchlyStory() {
  return (
    <section className="relative border-t border-white/[0.06] py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl border border-white/[0.09] bg-[#0c100c]">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(120% 90% at 15% 0%, rgba(198,242,78,0.14), transparent 55%), radial-gradient(90% 80% at 95% 100%, rgba(47,191,113,0.12), transparent 60%)",
            }}
          />
          <div className="dot-grid pointer-events-none absolute inset-0 opacity-40" />

          <div className="relative grid gap-8 p-6 sm:p-10 lg:grid-cols-[1.3fr_1fr] lg:items-center">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-brand/15 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.18em] text-brand">
                  The protocol
                </span>
                <span className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.18em] text-white/60">
                  <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-brand" />
                  Testnet
                </span>
              </div>

              <h2 className="mt-5 text-3xl font-semibold leading-[1.05] tracking-tight text-white sm:text-[42px]">
                A product should earn
                <br />
                <span className="text-white/45">its own growth budget.</span>
              </h2>
              <p className="mt-4 max-w-lg text-sm leading-relaxed text-white/45">
                Launchly gives every product its own coin on NEAR. Trading fees become a pool that
                pays the people who actually promote it — and founders get their supply only when
                holders agree the milestones were met. No platform token, no rented attention.
              </p>

              <ul className="mt-7 space-y-4">
                {pillars.map((pillar) => (
                  <li key={pillar.title} className="flex gap-3">
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-brand">
                      <pillar.icon className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold text-white">{pillar.title}</p>
                      <p className="mt-1 max-w-md text-[12px] leading-relaxed text-white/40">
                        {pillar.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-8 flex flex-wrap gap-2">
                <Link
                  to="/launch"
                  className="group inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 text-[13px] font-semibold text-black transition-all hover:gap-3"
                >
                  Launch a product
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to="/discover"
                  className="inline-flex items-center rounded-full border border-white/15 px-6 py-3 text-[13px] text-white/75 transition-colors hover:border-white/30 hover:text-white"
                >
                  Browse what launched
                </Link>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur">
              <div className="flex items-center gap-2 text-white/50">
                <Coins className="h-4 w-4" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.2em]">
                  Where a fee goes
                </span>
              </div>

              <ul className="mt-4 space-y-2.5">
                {flow.map((row) => (
                  <li
                    key={row.label}
                    className="flex items-center justify-between gap-3 border-b border-white/[0.06] pb-2.5 last:border-0 last:pb-0"
                  >
                    <span
                      className={`text-[12px] ${row.brand ? "text-brand" : row.muted ? "text-white/45" : "text-white/85"}`}
                    >
                      {row.label}
                    </span>
                    <span
                      className={`num text-[12.5px] ${row.brand ? "text-brand" : row.muted ? "text-white/45" : "text-white/85"}`}
                    >
                      {row.value}
                    </span>
                  </li>
                ))}
              </ul>

              <p className="mt-4 text-[10.5px] leading-relaxed text-white/25">
                Worked example on demo volume. The split is fixed in the launch contract and cannot
                change afterwards.
              </p>

              <div className="mt-5 border-t border-white/[0.08] pt-4">
                <p className="text-[9px] uppercase tracking-[0.2em] text-white/25">Built on</p>
                <PartnerRow
                  items={partners.slice(0, 4)}
                  className="mt-3 justify-start gap-x-5"
                  itemClassName="text-white/40 text-[10px]"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}