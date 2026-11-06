import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { ArrowLeft, Check, Globe2, Send } from "lucide-react";
import { toast } from "sonner";
import DataBadge from "@/components/shared/DataBadge";
import StatTile from "@/components/shared/StatTile";
import { creators, getCreator, payoutHistory, posts, products } from "@/lib/demo-data";
import { api, mapPost, useCreator, useLiveProducts } from "@/lib/launchly";
import { storageBalance, useWallet } from "@/lib/wallet";
import { claimTx, explorerTxUrl, storageDepositTx, txHash } from "@/lib/execute";
import { untilNs, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_site/creators/$creatorId")({
  // Creator resolves client-side (live backend first, demo fallback).
  loader: ({ params }) => ({ creatorId: params.creatorId }),
  head: () => ({
    meta: [
      { title: "Creator — Launchly" },
      { name: "description", content: "Creator profile, qualified posts and payout settings." },
    ],
  }),
  component: CreatorPage,
});

const assets = ["USDT", "USDC", "NEAR"];
const chains = ["NEAR", "Base", "Arbitrum", "Solana", "Ethereum"];

const statusStyles = {
  approved: "border-brand/25 bg-brand/10 text-brand",
  pending: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  held: "border-orange-400/25 bg-orange-400/10 text-orange-300",
  rejected: "border-red-500/25 bg-red-500/10 text-red-400",
};

const earnings = [
  { cycle: "C1", amount: 284 },
  { cycle: "C2", amount: 512 },
  { cycle: "C3", amount: 486 },
  { cycle: "C4", amount: 640 },
  { cycle: "C5", amount: 573 },
  { cycle: "C6", amount: 348 },
];

function CreatorPage() {
  const { creatorId } = Route.useParams();
  const [refreshKey, setRefreshKey] = useState(0);
  const { data: liveCreator, live, loading } = useCreator(creatorId, refreshKey);
  const creator = (live && liveCreator) || getCreator(creatorId);
  if (!creator) {
    if (loading) {
      return (
        <div className="mx-auto max-w-3xl px-4 pb-20 pt-32 text-center">
          <p className="text-white/50">Loading {creatorId}…</p>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-3xl px-4 pb-20 pt-32 text-center">
        <p className="text-white/50">Unknown creator.</p>
        <Link to="/creators" className="mt-4 inline-block text-brand">
          Back to creators
        </Link>
      </div>
    );
  }
  return (
    <CreatorProfile
      creator={creator}
      live={live && !!liveCreator}
      onClaimed={() => setRefreshKey((k) => k + 1)}
    />
  );
}

function CreatorProfile({ creator, live, onClaimed }) {
  const [pref, setPref] = useState(creator.preference);
  const [saved, setSaved] = useState(false);
  const [claiming, setClaiming] = useState("");
  const { products: liveProducts } = useLiveProducts();
  const { accountId, connected, signIn, signAndSend } = useWallet();
  const isOwner = connected && accountId === creator.account;

  const claim = async (entry) => {
    if (!connected) {
      signIn();
      return;
    }
    if (!isOwner) {
      toast.error("Connect as the creator to claim their payout");
      return;
    }
    const key = `${entry.product_id}-${entry.cycle_id}`;
    setClaiming(key);
    try {
      // Payouts land as USDT: register storage first if missing.
      const prod = (liveProducts ?? []).find((p) => String(p.productId) === String(entry.product_id));
      const usdtId = prod?.chain?.reserve_token ?? null;
      if (usdtId) {
        const sb = await storageBalance(usdtId, accountId);
        if (sb?.total == null) {
          toast.info("Registering USDT storage first (one-time)");
          await signAndSend([storageDepositTx(usdtId, accountId)]);
        }
      }
      const outcomes = await signAndSend([claimTx(entry.product_id, entry.cycle_id)]);
      const hash = txHash(outcomes[0]);
      toast.success(`Claimed cycle ${entry.cycle_id} payout`, {
        action: hash
          ? { label: "Explorer", onClick: () => window.open(explorerTxUrl(hash), "_blank") }
          : undefined,
      });
      // Report the receipt so the backend can verify it and mark the
      // payout claimed (the contract exposes no claimed view).
      if (hash) {
        try {
          await api(`/creators/${accountId}/claims`, {
            method: "POST",
            body: { product_id: entry.product_id, cycle_id: entry.cycle_id, tx_hash: hash },
          });
        } catch (e) {
          toast.warning("Receipt sync failed — claim is on-chain; reload to retry", {
            description: String(e.message).slice(0, 120),
          });
        }
      }
      onClaimed?.();
    } catch (e) {
      const raw = e.message ?? "";
      const msg = /reject|cancel|dismiss/i.test(raw)
        ? "Transaction rejected in wallet"
        : /already claimed/i.test(raw)
          ? "Already claimed on-chain — nothing left to claim for this cycle"
          : raw;
      toast.error("Claim failed", { description: msg.slice(0, 160) });
    } finally {
      setClaiming("");
    }
  };

  useEffect(() => {
    setPref(creator.preference);
    setSaved(false);
  }, [creator.account]); // eslint-disable-line react-hooks/exhaustive-deps

  const myPosts = live
    ? (creator.posts ?? []).map((e) => mapPost(e, e.post?.product_id))
    : posts.filter((p) => p.creator === creator.account);
  const chartData = live
    ? (creator.earnings ?? []).map((e) => ({
        cycle: `P${e.product_id}C${e.cycle_id}`,
        amount: Number(e.payout ?? 0) / 1e6,
      }))
    : earnings;
  const nameFor = (pid) =>
    (liveProducts ?? []).find((p) => String(p.productId) === String(pid))?.name ??
    products.find((p) => p.id === pid)?.name;
  const myPayouts = live
    ? (creator.earnings ?? [])
        .filter((e) => e.claimed)
        .map((e) => ({
          id: `${e.product_id}-${e.cycle_id}`,
          cycle: `${nameFor(e.product_id) ?? `Product ${e.product_id}`} · cycle ${e.cycle_id}`,
          amount: Number(e.payout ?? 0) / 1e6,
          asset: "USDT",
          time: e.claimed_at ? new Date(`${e.claimed_at}`).toLocaleDateString() : "",
          tx: e.claim_tx ?? null,
        }))
    : payoutHistory.filter((p) => p.creator === creator.account);

  const save = async () => {
    if (!live) {
      setSaved(true);
      toast.success("Payout preference saved (demo)");
      return;
    }
    try {
      await api(`/creators/${creator.account}/payout-preference`, {
        method: "PUT",
        body: { asset: pref.asset, chain: pref.chain.toLowerCase(), address: pref.address },
      });
      setSaved(true);
      toast.success("Payout preference saved");
    } catch (e) {
      toast.error(`Save failed: ${e.message}`);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-24 sm:px-6">
      <Link
        to="/creators"
        className="inline-flex items-center gap-1.5 text-[12px] text-white/40 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Creators
      </Link>

      <div className="mt-5 flex flex-col gap-5 rounded-2xl border border-white/[0.08] bg-gradient-to-b from-[#101010] to-[#0a0a0a] p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span
            className="grid h-16 w-16 place-items-center rounded-2xl text-2xl font-bold text-black"
            style={{ background: `linear-gradient(135deg, ${creator.gradient[0]}, ${creator.gradient[1]})` }}
          >
            {creator.name[0]}
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">{creator.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-white/40">
              <span>{creator.handle}</span>
              <span className="num rounded-md border border-white/10 px-1.5 py-0.5 text-[10.5px]">
                {creator.account}
              </span>
              {creator.focus && (
                <span className="flex items-center gap-1">
                  <Globe2 className="h-3 w-3" /> {creator.focus}
                </span>
              )}
              {creator.joined && <span>Joined {creator.joined}</span>}
              <DataBadge live={live} />
            </p>
            <p className="mt-1.5 text-[11px] text-white/25">
              {creator.followers ? `${creator.followers} followers · ` : ""}social account linked
              (simulated)
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={async () => {
              if (!live) {
                toast.success("Link code sent to the linked account (mock)");
                return;
              }
              try {
                await api(`/creators/${creator.account}/social-link`, {
                  method: "POST",
                  body: { platform: "x", handle: creator.handle },
                });
                toast.success("Social link recorded (simulated proof)");
              } catch (e) {
                toast.error(`Link failed: ${e.message}`);
              }
            }}
            className="rounded-full border border-white/12 px-4 py-2.5 text-[12px] text-white/65 transition-colors hover:border-white/30 hover:text-white"
          >
            Verify social link
          </button>
          <Link
            to="/discover"
            className="rounded-full bg-brand px-4 py-2.5 text-[12px] font-semibold text-black"
          >
            Submit a post
          </Link>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile label="Qualified posts" value={String(creator.qualified)} hint={`${creator.rejected ?? 0} rejected`} />
        <StatTile
          label="Cycle score"
          value={creator.score == null ? "—" : creator.score.toFixed(1)}
          hint={creator.rating == null ? "Multiplier pending" : `×${creator.rating.toFixed(2)} multiplier`}
          tone="brand"
        />
        <StatTile label="Pending" value={usd(creator.pending)} hint={live ? "Finalized, not yet claimed" : "Splits pro rata at cycle close"} />
        <StatTile label="Lifetime paid" value={usd(creator.paid)} hint={live ? "Verified on-chain claims" : `${myPayouts.length} transfers`} />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.5fr_1fr] lg:items-start">
        <div className="min-w-0 space-y-3">
          <section className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-white">Earnings by cycle</h2>
              <DataBadge live={live} />
            </div>
            <div className="mt-4 h-52 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                  <XAxis
                    dataKey="cycle"
                    tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                    contentStyle={{
                      background: "#111",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                    formatter={(value) => [usd(value), "Paid"]}
                  />
                  <Bar dataKey="amount" fill="hsl(var(--brand))" radius={[4, 4, 0, 0]} maxBarSize={38} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {live && (
            <section className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-white">Claimable payouts</h2>
                <DataBadge live />
              </div>
              <div className="mt-3 space-y-2">
                {(creator.earnings ?? [])
                  .filter((e) => Number(e.payout ?? 0) > 0)
                  .map((e) => {
                    const key = `${e.product_id}-${e.cycle_id}`;
                    const wait = e.finalized && !e.claimed ? untilNs(e.claimable_at_ns) : null;
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] px-3 py-2.5"
                      >
                        <div>
                          <p className="text-[12px] text-white/80">
                            {nameFor(e.product_id) ?? `Product ${e.product_id}`} · cycle {e.cycle_id}
                          </p>
                          <p className="num text-[12px] text-brand">{usd(Number(e.payout) / 1e6)}</p>
                        </div>
                        {e.claimed ? (
                          e.claim_tx ? (
                            <a
                              href={explorerTxUrl(e.claim_tx)}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 rounded-full border border-brand/25 bg-brand/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-brand hover:brightness-125"
                            >
                              Claimed ✓
                            </a>
                          ) : (
                            <span className="shrink-0 rounded-full border border-brand/25 bg-brand/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-brand">
                              Claimed ✓
                            </span>
                          )
                        ) : !e.finalized ? (
                          <span className="shrink-0 rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300">
                            Cycle open
                          </span>
                        ) : wait ? (
                          <span
                            className="shrink-0 rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300"
                            title="Dispute window — claims open when it passes"
                          >
                            Available in {wait}
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={claiming === key || !isOwner}
                            onClick={() => claim(e)}
                            title={isOwner ? "Claim to your wallet" : "Connect as this creator to claim"}
                            className="shrink-0 rounded-lg bg-brand px-4 py-2 text-[12px] font-semibold text-black transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-35"
                          >
                            {claiming === key ? "…" : "Claim"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                {(creator.earnings ?? []).filter((e) => Number(e.payout ?? 0) > 0).length === 0 && (
                  <p className="rounded-xl border border-dashed border-white/10 px-3 py-8 text-center text-[12px] text-white/30">
                    No payouts yet — finalized cycle earnings appear here.
                  </p>
                )}
              </div>
              {!isOwner && (
                <p className="mt-3 text-[11px] text-white/30">
                  Claims are signed by the creator — connect as {creator.account} to claim.
                </p>
              )}
            </section>
          )}

          <section className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <h2 className="text-[13px] font-semibold text-white">Submitted posts</h2>
            <div className="mt-3 space-y-2">
              {myPosts.map((post) => {
                const product = products.find((p) => p.id === post.productId);
                const name = product?.name ?? nameFor(post.productId) ?? `Product ${post.productId}`;
                return (
                  <div
                    key={post.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[12px] text-white/80">
                        {name} <span className="text-white/30">· {post.submitted}</span>
                      </p>
                      <p className="num truncate text-[10.5px] text-white/30">{post.url}</p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                        statusStyles[post.status]
                      )}
                    >
                      {post.status}
                    </span>
                  </div>
                );
              })}
              {myPosts.length === 0 && (
                <p className="rounded-xl border border-dashed border-white/10 px-3 py-8 text-center text-[12px] text-white/30">
                  No posts submitted yet.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <h2 className="text-[13px] font-semibold text-white">Payout history</h2>
            <div className="mt-3 space-y-2">
              {myPayouts.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-xl border border-white/[0.07] px-3 py-2.5">
                  <div>
                    <p className="text-[12px] text-white/80">{p.cycle}</p>
                    <p className="text-[10.5px] text-white/30">
                      {p.tx ? (
                        <>
                          Claimed on-chain · {p.time}{" "}
                          <a
                            href={explorerTxUrl(p.tx)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand hover:brightness-125"
                          >
                            tx↗
                          </a>
                        </>
                      ) : (
                        <>
                          {p.via === "Intents" ? "Delivered via NEAR Intents" : "Direct transfer"} · {p.time}
                        </>
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="num text-[12px] text-white">{usd(p.amount)}</p>
                    <p className="text-[10.5px] text-white/30">{p.asset}</p>
                  </div>
                </div>
              ))}
              {myPayouts.length === 0 && (
                <p className="rounded-xl border border-dashed border-white/10 px-3 py-8 text-center text-[12px] text-white/30">
                  First payout lands after this cycle closes.
                </p>
              )}
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-3">
          <div className="rounded-2xl border border-brand/20 bg-brand/[0.05] p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Payout preference</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-white/45">
              Choose the asset and chain you want to be paid in. Intents delivers it for you.
            </p>

            <div className="mt-4 space-y-2">
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.16em] text-white/30">Asset</span>
                <select
                  value={pref.asset}
                  onChange={(e) => {
                    setPref({ ...pref, asset: e.target.value });
                    setSaved(false);
                  }}
                  className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[12.5px] text-white/80 focus:border-brand/40 focus:outline-none"
                >
                  {assets.map((a) => (
                    <option key={a} value={a} className="bg-[#111]">
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.16em] text-white/30">Chain</span>
                <select
                  value={pref.chain}
                  onChange={(e) => {
                    setPref({ ...pref, chain: e.target.value });
                    setSaved(false);
                  }}
                  className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[12.5px] text-white/80 focus:border-brand/40 focus:outline-none"
                >
                  {chains.map((c) => (
                    <option key={c} value={c} className="bg-[#111]">
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.16em] text-white/30">Address</span>
                <input
                  value={pref.address}
                  onChange={(e) => {
                    setPref({ ...pref, address: e.target.value });
                    setSaved(false);
                  }}
                  className="num mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[12px] text-white/80 focus:border-brand/40 focus:outline-none"
                />
              </label>
            </div>

            <button
              type="button"
              onClick={save}
              className={cn(
                "mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[12.5px] font-semibold transition-colors",
                saved ? "bg-brand/15 text-brand" : "bg-brand text-black hover:brightness-105"
              )}
            >
              {saved ? <Check className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
              {saved ? "Preference saved" : "Save preference"}
            </button>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Score breakdown</p>
            <div className="mt-3 space-y-2 text-[12px]">
              <div className="flex justify-between text-white/45">
                <span>Counted posts (cap {4})</span>
                <span className="num text-white/80">{Math.min(creator.qualified, 4)}</span>
              </div>
              <div className="flex justify-between text-white/45">
                <span>Quality multiplier</span>
                <span className="num text-white/80">
                  {creator.rating == null ? "—" : `×${creator.rating.toFixed(2)}`}
                </span>
              </div>
              <div className="flex justify-between border-t border-white/[0.07] pt-2 text-white/45">
                <span>Cycle score</span>
                <span className="num text-brand">
                  {creator.score == null ? "—" : creator.score.toFixed(1)}
                </span>
              </div>
            </div>
            <p className="mt-3 text-[10.5px] leading-relaxed text-white/25">
              Payout is delayed until the 48-hour dispute window passes, so post-and-delete does not
              pay.
            </p>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Other creators</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {creators
                .filter((c) => c.account !== creator.account)
                .slice(0, 5)
                .map((c) => (
                  <Link
                    key={c.account}
                    to="/creators/$creatorId"
                    params={{ creatorId: c.account }}
                    className="rounded-full border border-white/10 px-2.5 py-1 text-[10.5px] text-white/45 transition-colors hover:border-white/25 hover:text-white"
                  >
                    {c.handle}
                  </Link>
                ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}