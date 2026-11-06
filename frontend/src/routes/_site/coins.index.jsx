import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import Sparkline from "@/components/shared/Sparkline";
import DataBadge from "@/components/shared/DataBadge";
import StatTile from "@/components/shared/StatTile";
import { products as demoProducts } from "@/lib/demo-data";
import { useLiveProducts } from "@/lib/launchly";
import { compactNum, pct, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_site/coins/")({
  head: () => ({
    meta: [
      { title: "Markets — Launchly" },
      { name: "description", content: "Every product coin on Launchly, its curve progress, fees and pool." },
    ],
  }),
  component: MarketsPage,
});

const sorts = [
  { id: "pool", label: "Pool size" },
  { id: "fees", label: "Fees 24h" },
  { id: "change", label: "24h change" },
  { id: "curve", label: "Curve progress" },
];

function MarketsPage() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("pool");
  const navigate = useNavigate();
  const { products: liveProducts, live } = useLiveProducts();
  const products = liveProducts ?? demoProducts;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.symbol.toLowerCase().includes(q))
      .sort((a, b) => {
        if (sort === "fees") return (b.fees24h ?? 0) - (a.fees24h ?? 0);
        if (sort === "change") return (b.change24h ?? 0) - (a.change24h ?? 0);
        if (sort === "curve") return (b.curveProgress ?? 0) - (a.curveProgress ?? 0);
        return (b.poolBalance ?? 0) - (a.poolBalance ?? 0);
      });
  }, [query, sort, products]);

  const totalPool = products.reduce((s, p) => s + (p.poolBalance ?? 0), 0);
  const totalFees = products.reduce((s, p) => s + (p.fees24h ?? 0), 0);
  const totalVolume = products.reduce((s, p) => s + (p.volume24h ?? 0), 0);
  const totalHolders = products.reduce((s, p) => s + (p.holders ?? 0), 0);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-20 pt-28 sm:px-6">
      <div className="flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-brand">Markets</p>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-[40px]">
          Product coins, one curve each.
        </h1>
        <p className="max-w-2xl text-sm text-white/40">
          No platform-wide token. Each product carries its own supply, its own fee and its own
          promotional pool.
        </p>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile label="Total pool" value={`$${compactNum(totalPool)}`} hint="Creator rewards held in contract" />
        <StatTile label="Fees 24h" value={`$${compactNum(totalFees)}`} hint="70% routed to pools" />
        <StatTile label="Volume 24h" value={`$${compactNum(totalVolume)}`} hint="Curve trades only" />
        <StatTile label="Holders" value={compactNum(totalHolders)} hint={`Across ${products.length} launches`} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <DataBadge live={live} />
        <p className="text-[10.5px] uppercase tracking-[0.16em] text-white/20">
          {live
            ? "Curve and pool figures from NEAR testnet · volume/fees estimated from 5-min snapshots"
            : "Demo data · market figures simulated"}
        </p>
      </div>

      <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticker"
            className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-3 text-[13px] text-white placeholder:text-white/25 focus:border-brand/40 focus:outline-none"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="h-10 rounded-xl border border-white/10 bg-transparent px-3 text-[12.5px] text-white/70 focus:outline-none"
        >
          {sorts.map((s) => (
            <option key={s.id} value={s.id} className="bg-[#111]">
              Sort · {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a0a0a]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left">
            <thead>
              <tr className="border-b border-white/[0.08] bg-white/[0.02]">
                {["Product", "Price", "24h", "Market cap", "Curve", "Fees 24h", "Pool", "Trend"].map(
                  (h, i) => (
                    <th
                      key={h}
                      className={cn(
                        "px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30",
                        i >= 1 && i <= 6 && "text-right",
                        i === 7 && "text-right"
                      )}
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => navigate({ to: "/coins/$symbol", params: { symbol: p.symbol } })}
                  className="cursor-pointer border-b border-white/[0.05] transition-colors last:border-0 hover:bg-white/[0.03]"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span
                        className="grid h-8 w-8 place-items-center rounded-lg text-[12px] font-bold text-black"
                        style={{ background: `linear-gradient(135deg, ${p.gradient[0]}, ${p.gradient[1]})` }}
                      >
                        {p.name[0]}
                      </span>
                      <div>
                        <Link
                          to="/coins/$symbol"
                          params={{ symbol: p.symbol }}
                          className="block text-[13px] font-medium text-white hover:text-brand"
                        >
                          {p.name}
                        </Link>
                        <span className="num text-[10.5px] text-white/35">${p.symbol}</span>
                      </div>
                    </div>
                  </td>
                  <td className="num px-4 py-3 text-right text-[13px] text-white">{usd(p.price)}</td>
                  <td
                    className={cn(
                      "num px-4 py-3 text-right text-[12.5px]",
                      p.change24h >= 0 ? "text-up" : "text-down"
                    )}
                  >
                    {pct(p.change24h)}
                  </td>
                  <td className="num px-4 py-3 text-right text-[12.5px] text-white/70">
                    ${compactNum(p.marketCap)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="ml-auto flex w-24 items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${p.curveProgress}%` }} />
                      </div>
                      <span className="num text-[10px] text-white/40">{p.curveProgress}%</span>
                    </div>
                  </td>
                  <td className="num px-4 py-3 text-right text-[12.5px] text-white/70">
                    ${compactNum(p.fees24h)}
                  </td>
                  <td className="num px-4 py-3 text-right text-[12.5px] text-brand">
                    ${compactNum(p.poolBalance)}
                  </td>
                  <td className="w-28 px-4 py-3">
                    <div className="ml-auto w-24">
                      <Sparkline points={p.spark} positive={p.change24h >= 0} height={26} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {[
          { label: "Trade fee", value: "1.00%", note: "Fixed at launch, allowed range 0.5–2%" },
          { label: "Pool share", value: "70%", note: "Creator pool; 20% ops, 10% founder" },
          { label: "Reserve yield", value: "Simulated", note: "Mock vault at a fixed labelled APR" },
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-white/[0.08] bg-[#0b0b0b] p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">{item.label}</p>
            <p className="mt-2 text-xl font-semibold text-white">{item.value}</p>
            <p className="mt-1 text-[11.5px] text-white/35">{item.note}</p>
          </div>
        ))}
      </div>
    </div>
  );
}