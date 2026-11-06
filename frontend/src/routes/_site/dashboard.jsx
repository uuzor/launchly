import { createFileRoute, Link } from "@tanstack/react-router";
import { Clock, Sparkles } from "lucide-react";
import DataBadge from "@/components/shared/DataBadge";
import StatTile from "@/components/shared/StatTile";
import FeeChart from "@/components/dashboard/FeeChart";
import FeeSplitCard from "@/components/coin/FeeSplitCard";
import VerifyQueue from "@/components/dashboard/VerifyQueue";
import MilestonePanel from "@/components/product/MilestonePanel";
import { activity, creators, feeInflow, milestones, payoutHistory, products as demoProducts, tokenomics } from "@/lib/demo-data";
import { useLiveProducts } from "@/lib/launchly";
import { usd } from "@/lib/format";

export const Route = createFileRoute("/_site/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Launchly" },
      { name: "description", content: "Pool balance, fee inflows, simulated yield, creator payouts and milestone votes." },
    ],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const { products: liveProducts, live } = useLiveProducts();
  const products = liveProducts ?? demoProducts;
  const totalPool = products.reduce((s, p) => s + (p.poolBalance ?? 0), 0);
  const fees24h = live ? null : products.reduce((s, p) => s + (p.fees24h ?? 0), 0);
  const paid = live ? null : payoutHistory.reduce((s, p) => s + p.amount, 0);
  const voting = milestones.filter((m) => m.status === "voting");

  return (
    <div className="mx-auto max-w-7xl px-4 pb-20 pt-28 sm:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-brand">Dashboard</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-[40px]">
            Every number, straight from the contract.
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-white/40">
            Fees, pool balance, simulated yield, creator payouts and milestone votes for every launch.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!live && (
            <span className="flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-[11px] text-amber-300">
              <Clock className="h-3.5 w-3.5" /> Cycle 4 closes in 6h 12m
            </span>
          )}
          <DataBadge live={live} />
        </div>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <StatTile label="Total pool" value={live ? usd(totalPool, { compact: true }) : `$${(totalPool / 1000).toFixed(1)}K`} hint={live ? "Curve reserves on testnet" : "Held by the pool contract"} tone="brand" />
        <StatTile label="Fees 24h" value={fees24h == null ? "—" : `$${fees24h.toLocaleString("en-US")}`} hint="Split 70 / 20 / 10 on-chain" />
        <StatTile label="Simulated yield" value={live ? "—" : `+$${(totalPool * 0.004).toFixed(0)}`} hint="Mock vault · labelled everywhere" />
        <StatTile label="Paid to creators" value={live ? "—" : usd(paid, { compact: true })} hint="Last 6 cycles" />
        <StatTile label="Founder locked" value={`${(tokenomics.founderLocked / 1e6).toFixed(0)}M`} hint={`${tokenomics.tranches} tranches per coin`} />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.55fr_1fr] lg:items-start">
        <div className="min-w-0">
          {live ? (
            <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
              <h2 className="text-[13px] font-semibold text-white">Fee inflows &amp; pool growth</h2>
              <p className="mt-2 text-[12.5px] leading-relaxed text-white/40">
                Fee history needs an indexer that isn&apos;t built yet. Live pool totals are above;
                per-product curves update as the keeper snapshots.
              </p>
              <div className="mt-3">
                <DataBadge live />
              </div>
            </div>
          ) : (
            <FeeChart data={feeInflow} />
          )}
        </div>
        <div className="min-w-0">
          <FeeSplitCard poolBalance={totalPool} fees24h={fees24h} />
        </div>
      </div>

      {live && (
        <div className="mt-4 rounded-2xl border border-brand/20 bg-brand/[0.05] p-5">
          <p className="text-[13px] font-semibold text-white">Live mode: pools and curves from testnet</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/50">
            Payout history, fee inflow and activity streams need an indexer that isn&apos;t built
            yet — open a product to see its live posts, milestones and quotes, or a creator to see
            on-chain earnings per cycle.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to="/discover" className="rounded-full bg-brand px-4 py-2 text-[12px] font-semibold text-black">
              Browse live products
            </Link>
            <Link to="/creators" className="rounded-full border border-white/15 px-4 py-2 text-[12px] text-white/70">
              Creator earnings
            </Link>
          </div>
        </div>
      )}

      {!live && (
        <>
      <div className="mt-4 grid gap-3 lg:grid-cols-[1.55fr_1fr] lg:items-start">
        <div className="min-w-0 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a0a0a]">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
            <h2 className="text-[13px] font-semibold text-white">Creator payouts</h2>
            <Link to="/creators" className="text-[10.5px] text-white/35 hover:text-white">
              All creators →
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left">
              <thead>
                <tr className="border-b border-white/[0.05]">
                  {["Creator", "Cycle", "Score", "Amount", "Route"].map((h, i) => (
                    <th
                      key={h}
                      className={`px-4 py-2.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-white/25 ${
                        i >= 2 ? "text-right" : ""
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payoutHistory.map((p) => (
                  <tr key={p.id} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-4 py-2.5">
                      <Link
                        to="/creators/$creatorId"
                        params={{ creatorId: p.creator }}
                        className="text-[12px] text-white/80 hover:text-brand"
                      >
                        {p.creator}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-[11.5px] text-white/40">{p.cycle}</td>
                    <td className="num px-4 py-2.5 text-right text-[12px] text-white/70">{p.score}</td>
                    <td className="num px-4 py-2.5 text-right text-[12px] text-white">{usd(p.amount)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/45">
                        {p.via === "Intents" ? p.asset : "Direct"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a]">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
            <h2 className="text-[13px] font-semibold text-white">Live activity</h2>
            <span className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.16em] text-white/25">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-brand" /> streaming
            </span>
          </div>
          <ul className="divide-y divide-white/[0.04]">
            {activity.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[11.5px] text-white/70">{a.text}</p>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-white/25">{a.kind}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="num text-[11px] text-brand">{a.value}</p>
                  <p className="text-[9.5px] text-white/25">{a.time}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2 lg:items-start">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-white">Milestone votes</h2>
            <span className="num text-[10.5px] text-white/30">{voting.length} open</span>
          </div>
          <MilestonePanel milestones={milestones} />
        </div>
        <div className="space-y-3">
          <VerifyQueue />
          <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-brand" />
              <h2 className="text-[13px] font-semibold text-white">Non-creator spending</h2>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-white/40">
              Up to 20% of the pool per cycle can fund other promotion, through contract-enforced
              caps. The founder cannot withdraw from the pool.
            </p>
            <div className="mt-3">
              <div className="flex justify-between text-[10px] text-white/30">
                <span>Used this cycle</span>
                <span className="num">7.4% of 20%</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="h-full rounded-full bg-brand" style={{ width: "37%" }} />
              </div>
            </div>
            <Link
              to="/discover"
              className="mt-4 flex items-center justify-between rounded-xl border border-white/10 px-3 py-2.5 text-[11.5px] text-white/60 transition-colors hover:border-white/25 hover:text-white"
            >
              How the pool is funded
            </Link>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-[#0b0b0b] p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Top creators by score</p>
            <ul className="mt-3 space-y-2">
              {[...creators]
                .sort((a, b) => b.score - a.score)
                .slice(0, 3)
                .map((c) => (
                  <li key={c.account} className="flex items-center justify-between text-[12px]">
                    <span className="text-white/70">{c.handle}</span>
                    <span className="num text-brand">×{c.score.toFixed(1)}</span>
                  </li>
                ))}
            </ul>
          </div>
        </div>
      </div>

        </>
      )}

      {live && (
        <div className="mx-auto mt-4 max-w-2xl">
          <VerifyQueue />
        </div>
      )}

      <p className="mt-6 text-center text-[10.5px] uppercase tracking-[0.16em] text-white/20">
        {live ? "Live pools · contracts on NEAR testnet" : "Prototype · contracts on NEAR testnet · reserve yield simulated"}
      </p>
    </div>
  );
}