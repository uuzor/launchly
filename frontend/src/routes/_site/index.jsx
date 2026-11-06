import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import LandingHero from "@/components/landing/LandingHero";
import LiveLaunches from "@/components/landing/LiveLaunches";
import LoopSteps from "@/components/landing/LoopSteps";
import ProtocolTiers from "@/components/landing/ProtocolTiers";
import LaunchlyStory from "@/components/landing/LaunchlyStory";

export const Route = createFileRoute("/_site/")({
  head: () => ({
    meta: [
      { title: "Launchly — Tokenize your product. Fund the future." },
      {
        name: "description",
        content:
          "Launch a product, launch its coin. Trading fees fund the pool that pays the community for promoting it, and founders unlock supply only when holders approve milestones.",
      },
    ],
  }),
  component: LandingPage,
});

const intents = [
  {
    title: "Pay in from any chain",
    body: "A trader holds assets on Base, Solana or Arbitrum. Launchly quotes the route through NEAR Intents, they deposit once, and the reserve stablecoin arrives on NEAR ready to buy.",
    tag: "Trader onboarding",
  },
  {
    title: "Paid out where you want",
    body: "A creator picks USDC on Base. The contract pays the share in the reserve asset, and Intents delivers it to the chosen address and chain.",
    tag: "Creator payout",
  },
  {
    title: "Treasury without a custodian",
    body: "Approved pool spending moves through the same path, so the promotional budget needs no manual bridging and no human key.",
    tag: "Autonomous business",
  },
];

function IntentsSection() {
  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div className="lg:sticky lg:top-24">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-brand">
              NEAR Intents
            </p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight text-white sm:text-4xl">
              Value crosses chains.
              <br />
              <span className="text-white/40">The rules stay on NEAR.</span>
            </h2>
            <p className="mt-5 max-w-md text-sm leading-relaxed text-white/45">
              Intents is used where cross-chain movement actually matters — not as decoration.
              Quotes are live through the 1Click API; this demo shows dry quotes and a single tiny
              mainnet swap.
            </p>
            <Link
              to="/coins"
              className="group mt-7 inline-flex items-center gap-1.5 text-[13px] font-medium text-white/60 transition-colors hover:text-white"
            >
              See a live pay-in quote
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>

          <div className="space-y-3">
            {intents.map((item, i) => (
              <article
                key={item.title}
                className="rounded-2xl border border-white/[0.08] bg-[#0c0c0c] p-6 transition-colors hover:border-white/15"
              >
                <div className="flex items-center justify-between">
                  <span className="num text-[11px] text-white/25">0{i + 1}</span>
                  <span className="rounded-full border border-white/10 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-white/40">
                    {item.tag}
                  </span>
                </div>
                <h3 className="mt-4 text-lg font-semibold text-white">{item.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-white/40">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="relative overflow-hidden border-t border-white/[0.06] py-24">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[380px] w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/[0.10] blur-[120px]" />
      <div className="relative mx-auto max-w-2xl px-4 text-center sm:px-6">
        <h2 className="text-balance text-3xl font-semibold leading-tight text-white sm:text-[44px]">
          Build something. Launch it.
          <br />
          <span className="text-white/40">Let the community help it grow.</span>
        </h2>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/launch"
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-white px-7 py-3.5 text-[14px] font-semibold text-black transition hover:bg-white/90 sm:w-auto"
          >
            Launch a coin
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            to="/creators"
            className="inline-flex w-full items-center justify-center rounded-full border border-white/15 px-7 py-3.5 text-[14px] font-medium text-white/80 transition hover:border-white/30 hover:text-white sm:w-auto"
          >
            Start earning as a creator
          </Link>
        </div>
      </div>
    </section>
  );
}

function LandingPage() {
  return (
    <>
      <LandingHero />
      <LiveLaunches />
      <LoopSteps />
      <ProtocolTiers />
      <LaunchlyStory />
      <IntentsSection />
      <ClosingCta />
    </>
  );
}