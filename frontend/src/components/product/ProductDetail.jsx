import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Coins,
  ExternalLink,
  Globe2,
  Lock,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import Sparkline from "@/components/shared/Sparkline";
import DataBadge from "@/components/shared/DataBadge";
import PostFeed from "@/components/product/PostFeed";
import MilestonePanel from "@/components/product/MilestonePanel";
import ChatWidget from "@/components/product/ChatWidget";
import SubmitPostModal from "@/components/product/SubmitPostModal";
import PublishMilestoneForm from "@/components/product/PublishMilestoneForm";
import { creators, milestonesForProduct, postsForProduct, tokenomics } from "@/lib/demo-data";
import { useChart, useMilestones, usePosts } from "@/lib/launchly";
import { compactNum, num, pct, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function ProductDetail({ product, live = false }) {
  const [following, setFollowing] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const { data: livePosts } = usePosts(live ? product.productId : null);
  const { data: liveMilestones } = useMilestones(live ? product.productId : null);
  const { data: chart } = useChart(live ? product.tokenAccount : null);
  const posts = live && livePosts ? livePosts : postsForProduct(product.id);
  const milestones = live && liveMilestones ? liveMilestones : milestonesForProduct(product.id);
  const spark = live && chart && chart.length >= 2 ? chart.map((p) => p.price) : product.spark;
  const rules = product.rules;
  const topCreators = [...creators]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 4);

  const released = milestones.filter((m) => m.status === "approved").length;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-20 pt-24 sm:px-6">
      <Link
        to="/discover"
        className="inline-flex items-center gap-1.5 text-[12px] text-white/40 transition-colors hover:text-white"
      >
        ← Discovery
      </Link>

      {/* Header */}
      <div className="mt-5 rounded-2xl border border-white/[0.08] bg-gradient-to-b from-[#101010] to-[#0a0a0a] p-5 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <span
              className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl text-2xl font-bold text-black"
              style={{ background: `linear-gradient(135deg, ${product.gradient[0]}, ${product.gradient[1]})` }}
            >
              {product.name[0]}
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-[32px]">
                  {product.name}
                </h1>
                <span className="num rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50">
                  ${product.symbol}
                </span>
                <span className="flex items-center gap-1 rounded-full bg-up/12 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-up">
                  <span className="h-1 w-1 rounded-full bg-up" /> Live
                </span>
                <span className="rounded-full border border-sky-400/25 bg-sky-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-sky-300">
                  {product.stage}
                </span>
                <DataBadge live={live} />
              </div>
              <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-white/45">{product.tagline}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-white/30">
                <span className="rounded-full border border-white/10 px-2 py-0.5">{product.category}</span>
                <span className="num">{product.ageDays}d ago</span>
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" /> {num(product.followers)} followers
                </span>
                <span className="num">{product.holders} holders</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setFollowing((v) => !v);
                toast.success(following ? "Unfollowed" : `Following ${product.name}`);
              }}
              className={cn(
                "rounded-full px-5 py-2.5 text-[12.5px] font-semibold transition-all",
                following
                  ? "border border-brand/35 bg-brand/10 text-brand"
                  : "bg-brand text-black hover:brightness-105"
              )}
            >
              {following ? "Following" : "Follow"}
            </button>
            <a
              href={product.demoUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-full border border-white/12 px-4 py-2.5 text-[12.5px] text-white/70 transition-colors hover:border-white/30 hover:text-white"
            >
              <Globe2 className="h-3.5 w-3.5" /> Live demo
            </a>
            <Link
              to="/coins/$symbol"
              params={{ symbol: product.symbol }}
              className="flex items-center gap-1.5 rounded-full border border-white/12 px-4 py-2.5 text-[12.5px] text-white/70 transition-colors hover:border-white/30 hover:text-white"
            >
              Trade
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <div className="min-w-0 space-y-3">
          {/* About */}
          <section className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-white/40">
              About the product
            </h2>
            <p className="mt-3 text-[13.5px] leading-relaxed text-white/65">{product.description}</p>
            <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/30">
                The problem it solves
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-white/55">{product.problem}</p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {product.tags.map((tag) => (
                <span key={tag} className="rounded-full border border-white/10 px-2.5 py-1 text-[10.5px] text-white/40">
                  {tag}
                </span>
              ))}
            </div>
          </section>

          {/* Campaign rules */}
          <section className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-white/40">
                Campaign rules
              </h2>
              <span className="flex items-center gap-1 rounded-full border border-brand/25 bg-brand/[0.07] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-brand">
                <ShieldCheck className="h-2.5 w-2.5" /> Hash-anchored
              </span>
            </div>
            {rules ? (
              <>
                <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                  {[
                    { label: "Required link", value: rules.requiredLink },
                    { label: "Required tag", value: rules.requiredTag },
                    { label: "Min account age", value: `${rules.minAccountAgeDays} days` },
                    { label: "Counted posts / cycle", value: `${rules.maxPosts} max` },
                    { label: "Payout cycle", value: `${rules.cycleDays} days` },
                    { label: "Pool split", value: "70% of every fee" },
                  ].map((rule) => (
                    <div key={rule.label} className="rounded-xl border border-white/[0.07] px-3 py-2.5">
                      <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/25">{rule.label}</p>
                      <p className="num mt-1 truncate text-[12.5px] text-white/75">{rule.value}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[11.5px] leading-relaxed text-white/30">
                  Not allowed: {rules.banned}
                </p>
              </>
            ) : (
              <p className="mt-3 text-[12.5px] leading-relaxed text-white/40">
                Rules are hash-anchored on-chain
                {product.chain?.rules_hash ? (
                  <>
                    {" "}(<span className="num text-white/55">{String(product.chain.rules_hash).slice(0, 16)}…</span>)
                  </>
                ) : (
                  ""
                )}{" "}
                but the readable copy isn&apos;t registered with this backend yet.
              </p>
            )}
          </section>

          {/* Posts */}
          <section className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-white/40">
                Community posts
              </h2>
              <span className="num text-[10.5px] text-white/30">
                {posts.filter((p) => p.status === "approved").length} qualified · {posts.length} submitted
              </span>
            </div>
            <div className="mt-4">
              <PostFeed posts={posts} creators={creators} />
            </div>
            {live ? (
              <button
                type="button"
                onClick={() => setSubmitOpen(true)}
                className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2.5 text-[12px] text-white/50 transition-colors hover:border-white/25 hover:text-white"
              >
                <Plus className="h-3.5 w-3.5" /> Submit a post for this product
              </button>
            ) : (
              <Link
                to="/creators"
                className="mt-4 flex items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2.5 text-[12px] text-white/50 transition-colors hover:border-white/25 hover:text-white"
              >
                <Plus className="h-3.5 w-3.5" /> Submit a post for this product
              </Link>
            )}
          </section>

          {/* Milestones */}
          <section className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-white/40">
                Founder milestones
              </h2>
              <span className="num text-[10.5px] text-white/30">
                {released} of {tokenomics.tranches} tranches released
              </span>
            </div>
            <div className="mt-4">
              <MilestonePanel milestones={milestones} product={product} live={live} />
            </div>
            {live && <PublishMilestoneForm product={product} />}
          </section>
        </div>

        {/* Sidebar */}
        <aside className="min-w-0 space-y-3">
          <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Coin</p>
              <Link
                to="/coins/$symbol"
                params={{ symbol: product.symbol }}
                className="text-[10.5px] text-brand hover:underline"
              >
                Trade →
              </Link>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="num text-2xl font-semibold text-white">{usd(product.price)}</span>
              <span className={cn("num text-[11.5px]", product.change24h >= 0 ? "text-up" : "text-down")}>
                {pct(product.change24h)}
              </span>
            </div>
            <div className="mt-2">
              <Sparkline points={spark} positive={(product.change24h ?? 0) >= 0} height={56} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/[0.07] pt-3 text-[11px]">
              <div>
                <p className="text-white/30">Market cap</p>
                <p className="num mt-0.5 text-white/80">${compactNum(product.marketCap)}</p>
              </div>
              <div>
                <p className="text-white/30">Volume 24h</p>
                <p className="num mt-0.5 text-white/80">${compactNum(product.volume24h)}</p>
              </div>
            </div>
            <div className="mt-3">
              <div className="flex justify-between text-[10px] text-white/30">
                <span>Curve sold</span>
                <span className="num">{Number(product.curveProgress ?? 0).toFixed(1)}%</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="h-full rounded-full bg-brand" style={{ width: `${product.curveProgress}%` }} />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-brand/20 bg-brand/[0.05] p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Promotional pool</p>
            <p className="num mt-1.5 text-2xl font-semibold text-brand">
              ${compactNum(product.poolBalance)}
            </p>
            <div className="mt-3 space-y-1.5 text-[11.5px] text-white/45">
              <div className="flex justify-between">
                <span>Fees 24h</span>
                <span className="num text-white/75">${compactNum(product.fees24h)}</span>
              </div>
              <div className="flex justify-between">
                <span>Lifetime fees</span>
                <span className="num text-white/75">${compactNum(product.totalFees)}</span>
              </div>
              <div className="flex justify-between">
                <span>Simulated yield</span>
                <span className="num text-brand">+${(product.poolBalance * 0.004).toFixed(2)}/d</span>
              </div>
              <div className="flex justify-between">
                <span>Cycle</span>
                <span className="text-white/75">Closes in 6h</span>
              </div>
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-white/25">
              Yield is simulated in this prototype and labelled everywhere it appears.
            </p>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Top creators</p>
              <Link to="/creators" className="text-[10.5px] text-white/35 hover:text-white">
                All →
              </Link>
            </div>
            <ul className="mt-3 space-y-2.5">
              {topCreators.map((creator, i) => (
                <li key={creator.account}>
                  <Link
                    to="/creators/$creatorId"
                    params={{ creatorId: creator.account }}
                    className="flex items-center gap-2.5 rounded-lg px-1 py-1 transition-colors hover:bg-white/[0.04]"
                  >
                    <span className="num w-3 text-[10px] text-white/25">{i + 1}</span>
                    <span
                      className="grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold text-black"
                      style={{ background: `linear-gradient(135deg, ${creator.gradient[0]}, ${creator.gradient[1]})` }}
                    >
                      {creator.name[0]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-white/85">{creator.handle}</span>
                      <span className="num block text-[10px] text-white/30">
                        {creator.qualified} posts · ×{creator.rating.toFixed(2)}
                      </span>
                    </span>
                    <span className="num text-[11px] text-brand">×{creator.score.toFixed(1)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <div className="flex items-center gap-2">
              <Lock className="h-3.5 w-3.5 text-white/40" />
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Founder lock</p>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-white/45">
              {(tokenomics.founderLocked / 1e6).toFixed(0)}M {(tokenomics.founderLocked / tokenomics.supply) * 100}%{" "}
              held in the vesting contract and released in four holder-approved tranches.
            </p>
            <div className="mt-3 flex gap-1.5">
              {Array.from({ length: tokenomics.tranches }).map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    "h-1.5 flex-1 rounded-full",
                    i < released ? "bg-brand" : "bg-white/[0.08]"
                  )}
                />
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-white/[0.07] px-2.5 py-2">
              <Coins className="h-3.5 w-3.5 text-white/30" />
              <p className="text-[10.5px] text-white/35">
                Founder wallets cannot vote on their own milestones.
              </p>
            </div>
            <a
              href={product.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 flex items-center gap-1.5 text-[11px] text-white/35 hover:text-white/70"
            >
              <ExternalLink className="h-3 w-3" /> Repository
            </a>
          </div>
        </aside>
      </div>

      <div className="mt-6 flex items-center justify-center gap-2">
        <DataBadge live={live} />
        <p className="text-[10.5px] uppercase tracking-[0.16em] text-white/20">
          {live ? "Posts, milestones and curve from NEAR testnet" : "Prototype · social data simulated · contracts on NEAR testnet"}
        </p>
      </div>
      {live && <ChatWidget productId={product.productId} productName={product.name} />}
      {live && submitOpen && (
        <SubmitPostModal product={product} onClose={() => setSubmitOpen(false)} />
      )}
    </div>
  );
}