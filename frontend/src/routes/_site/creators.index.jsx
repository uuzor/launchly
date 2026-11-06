import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, BadgeCheck } from "lucide-react";
import DataBadge from "@/components/shared/DataBadge";
import StatTile from "@/components/shared/StatTile";
import { creators as demoCreators, posts } from "@/lib/demo-data";
import { useCreatorDirectory } from "@/lib/launchly";
import { usd } from "@/lib/format";

export const Route = createFileRoute("/_site/creators/")({
  head: () => ({
    meta: [
      { title: "Creators — Launchly" },
      { name: "description", content: "The creators who promote Launchly products and share the pool." },
    ],
  }),
  component: CreatorsPage,
});

function CreatorsPage() {
  const { data: liveCreators, live } = useCreatorDirectory();
  const creators = live && liveCreators ? liveCreators : demoCreators;
  const totalPending = creators.reduce((s, c) => s + (c.pending ?? 0), 0);
  const totalPaid = creators.reduce((s, c) => s + (c.paid ?? 0), 0);
  const scored = creators.filter((c) => c.score != null);
  const avgScore = scored.length ? scored.reduce((s, c) => s + c.score, 0) / scored.length : null;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-20 pt-28 sm:px-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-brand">Creators</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-[40px]">
            Get paid to promote what you actually use.
          </h1>
          <p className="mt-2 max-w-xl text-sm text-white/40">
            Post about a product, submit the link, get verified. The pool splits pro rata by score at
            the end of each cycle.
          </p>
        </div>
        <Link
          to="/discover"
          className="inline-flex w-fit items-center gap-2 rounded-full bg-white px-5 py-3 text-[13px] font-semibold text-black transition hover:bg-white/90"
        >
          Find a product to post about
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile label="Pending payouts" value={`$${totalPending.toFixed(0)}`} hint="Released after the dispute window" />
        <StatTile label="Lifetime paid" value={`$${(totalPaid / 1000).toFixed(1)}K`} hint="Across all products" tone="brand" />
        <StatTile label="Active creators" value={String(creators.length)} hint="With at least one submitted post" />
        <StatTile label="Avg score" value={avgScore == null ? "—" : avgScore.toFixed(1)} hint="Posts × quality multiplier" />
      </div>

      <div className="mt-6 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a0a0a]">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
          <h2 className="text-[13px] font-semibold text-white">This cycle leaderboard</h2>
          <DataBadge live={live} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left">
            <thead>
              <tr className="border-b border-white/[0.06]">
                {["Creator", "Wallet", "Qualified", "Score", "Rating", "Pending", "Lifetime", "Payout"].map(
                  (h, i) => (
                    <th
                      key={h}
                      className={`px-4 py-2.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-white/25 ${
                        i >= 2 && i <= 6 ? "text-right" : ""
                      }`}
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {creators.map((c) => (
                <tr key={c.account} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <Link
                      to="/creators/$creatorId"
                      params={{ creatorId: c.account }}
                      className="flex items-center gap-2.5 group"
                    >
                      <span
                        className="grid h-8 w-8 place-items-center rounded-full text-[11px] font-bold text-black"
                        style={{ background: `linear-gradient(135deg, ${c.gradient[0]}, ${c.gradient[1]})` }}
                      >
                        {c.name[0]}
                      </span>
                      <span>
                        <span className="flex items-center gap-1 text-[12.5px] font-medium text-white group-hover:text-brand">
                          {c.handle}
                          {c.rejected === 0 && <BadgeCheck className="h-3 w-3 text-brand" />}
                        </span>
                        <span className="block text-[10.5px] text-white/30">{c.focus}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="num px-4 py-3 text-[11.5px] text-white/45">{c.account}</td>
                  <td className="num px-4 py-3 text-right text-[12px] text-white/75">
                    {c.qualified}
                    <span className="text-white/25"> / {c.qualified + (c.rejected ?? 0)}</span>
                  </td>
                  <td className="num px-4 py-3 text-right text-[12px] text-brand">
                    {c.score == null ? "—" : c.score.toFixed(1)}
                  </td>
                  <td className="num px-4 py-3 text-right text-[12px] text-white/60">
                    {c.rating == null ? "—" : `×${c.rating.toFixed(2)}`}
                  </td>
                  <td className="num px-4 py-3 text-right text-[12px] text-white/80">{usd(c.pending)}</td>
                  <td className="num px-4 py-3 text-right text-[12px] text-white/45">{usd(c.paid)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/50">
                      {c.preference?.asset ?? "USDT"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {[
          {
            title: "Qualified posts only",
            body: "A post needs the product link, original content, an account that meets the age rule, and a verifier approval.",
          },
          {
            title: "Quality moves the score",
            body: "Holders rate approved posts. The multiplier stays between 0.5× and 1.5×, so votes can't zero out a score.",
          },
          {
            title: "Paid in your asset",
            body: "Pick the asset and chain you want. NEAR Intents delivers the payout without you bridging anything.",
          },
        ].map((item) => (
          <div key={item.title} className="rounded-2xl border border-white/[0.08] bg-[#0b0b0b] p-5">
            <h3 className="text-[13px] font-semibold text-white">{item.title}</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-white/40">{item.body}</p>
          </div>
        ))}
      </div>

      <p className="mt-6 text-center text-[10.5px] uppercase tracking-[0.16em] text-white/20">
        {live
          ? `${creators.length} on-chain submitters across live products`
          : `${posts.filter((p) => p.status === "approved").length} approved posts across ${
              new Set(posts.map((p) => p.productId)).size
            } products`}
      </p>
    </div>
  );
}