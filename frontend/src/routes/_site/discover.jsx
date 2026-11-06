import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Search, SlidersHorizontal } from "lucide-react";
import ProductColumn from "@/components/discover/ProductColumn";
import DataBadge from "@/components/shared/DataBadge";
import StatTile from "@/components/shared/StatTile";
import { products as demoProducts } from "@/lib/demo-data";
import { useLiveProducts } from "@/lib/launchly";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_site/discover")({
  head: () => ({
    meta: [
      { title: "Discover — Launchly" },
      { name: "description", content: "Browse products raising on Launchly, their pools and their curves." },
    ],
  }),
  component: DiscoverPage,
});

const categories = ["All", "Developer Tools", "Analytics", "Infrastructure", "Fintech", "Design", "Data"];
const sorts = [
  { id: "new", label: "Newest" },
  { id: "pool", label: "Largest pool" },
  { id: "fees", label: "Most fees 24h" },
  { id: "curve", label: "Curve progress" },
];

function groupFor(product) {
  if (product.ageDays <= 8) return "new";
  if (product.curveProgress >= 60) return "funded";
  return "raising";
}

function DiscoverPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState("new");
  const { products: liveProducts, live } = useLiveProducts();
  const products = liveProducts ?? demoProducts;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = products.filter((p) => {
      const matchesQuery =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.symbol.toLowerCase().includes(q) ||
        p.tagline.toLowerCase().includes(q);
      const matchesCat = category === "All" || p.category === category;
      return matchesQuery && matchesCat;
    });
    const sorted = [...list].sort((a, b) => {
      if (sort === "pool") return (b.poolBalance ?? 0) - (a.poolBalance ?? 0);
      if (sort === "fees") return (b.fees24h ?? 0) - (a.fees24h ?? 0);
      if (sort === "curve") return (b.curveProgress ?? 0) - (a.curveProgress ?? 0);
      return (a.ageDays ?? 0) - (b.ageDays ?? 0);
    });
    return sorted;
  }, [query, category, sort, products]);

  const columns = [
    {
      key: "new",
      title: "Just launched",
      hint: "Listed in the last 8 days",
      accent: "bg-brand",
    },
    { key: "raising", title: "Raising", hint: "Curve under 60%", accent: "bg-sky-400" },
    { key: "funded", title: "Funded", hint: "Curve above 60%", accent: "bg-violet-400" },
  ];

  const totalPool = products.reduce((sum, p) => sum + (p.poolBalance ?? 0), 0);
  const totalFees = products.reduce((sum, p) => sum + (p.fees24h ?? 0), 0);
  const totalCreators = products.reduce((sum, p) => sum + (p.creators ?? 0), 0);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-20 pt-28 sm:px-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-brand">Discovery</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-[40px]">
            Explore products raising now.
          </h1>
          <p className="mt-2 max-w-xl text-sm text-white/40">
            Every launch has its own coin, its own pool and its own rules — fixed at launch.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:w-[420px]">
          <StatTile label="Pool balance" value={`$${(totalPool / 1000).toFixed(1)}K`} />
          <StatTile label="Fees 24h" value={`$${(totalFees / 1000).toFixed(1)}K`} />
          <StatTile label="Creators" value={String(totalCreators)} />
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-3 rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products, tickers or descriptions"
            className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-3 text-[13px] text-white placeholder:text-white/25 focus:border-brand/40 focus:outline-none"
          />
        </div>
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-[11.5px] font-medium transition-colors",
                category === cat
                  ? "border-brand/40 bg-brand/12 text-brand"
                  : "border-white/10 text-white/50 hover:border-white/20 hover:text-white"
              )}
            >
              {cat}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-white/10 px-2.5">
          <SlidersHorizontal className="h-3.5 w-3.5 text-white/30" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="h-9 bg-transparent text-[12px] text-white/70 focus:outline-none"
          >
            {sorts.map((s) => (
              <option key={s.id} value={s.id} className="bg-[#111] text-white">
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {columns.map((col) => (
          <ProductColumn
            key={col.key}
            title={col.title}
            hint={col.hint}
            accent={col.accent}
            products={filtered.filter((p) => groupFor(p) === col.key)}
          />
        ))}
      </div>

      <div className="mt-6 flex items-center justify-center gap-2">
        <DataBadge live={live} />
        <p className="text-[10.5px] uppercase tracking-[0.16em] text-white/20">
          {live
            ? "Pool and curve figures from NEAR testnet · volume/fees estimated from 5-min snapshots"
            : "Demo data · market figures simulated"}
        </p>
      </div>
    </div>
  );
}