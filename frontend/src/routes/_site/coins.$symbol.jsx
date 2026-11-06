import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Flame, Globe2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import PriceChart from "@/components/coin/PriceChart";
import TradePanel from "@/components/coin/TradePanel";
import PositionPanel from "@/components/coin/PositionPanel";
import RecentTrades from "@/components/coin/RecentTrades";
import FeeSplitCard from "@/components/coin/FeeSplitCard";
import IntentsQuoteCard from "@/components/coin/IntentsQuoteCard";
import { getProductBySymbol, recentTrades } from "@/lib/demo-data";
import { useChart, useLiveProducts } from "@/lib/launchly";
import { compactNum, pct, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_site/coins/$symbol")({
  // Product resolves client-side (live backend first, demo fallback).
  loader: ({ params }) => ({ symbol: params.symbol }),
  head: ({ loaderData }) => ({
    meta: [
      { title: `$${loaderData?.symbol ?? "Coin"} — Launchly Markets` },
      {
        name: "description",
        content: `Trade $${loaderData?.symbol ?? ""} on its bonding curve and watch the creator pool grow.`,
      },
    ],
  }),
  component: CoinPage,
});

function CoinPage() {
  const { symbol } = Route.useParams();
  const { products: liveProducts, live, loading } = useLiveProducts();
  const liveProduct = (liveProducts ?? []).find(
    (p) => p.symbol.toLowerCase() === symbol.toLowerCase()
  );
  const product = liveProduct ?? getProductBySymbol(symbol);
  if (!product) {
    if (loading) {
      return (
        <div className="mx-auto max-w-3xl px-4 pb-20 pt-32 text-center">
          <p className="text-white/50">Loading ${symbol}…</p>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-3xl px-4 pb-20 pt-32 text-center">
        <p className="text-white/50">This coin is not listed.</p>
        <Link to="/coins" className="mt-4 inline-block text-brand">
          Back to markets
        </Link>
      </div>
    );
  }
  return <CoinDetail product={product} live={live && !!liveProduct} />;
}

function CoinDetail({ product, live }) {
  const [state, setState] = useState({
    balance: 1250,
    holdings: 0,
    pool: product.poolBalance ?? 0,
    trades: recentTrades.filter((t) => t.symbol === product.symbol),
  });
  const { data: chart } = useChart(live ? product.tokenAccount : null);
  const [tradeKey, setTradeKey] = useState(0);
  const [signals, setSignals] = useState(3160);

  const handleTrade = ({ mode, amount, fee }) => {
    if (!amount) return;
    if (!product.price) {
      toast.error("No price available — trade blocked, not estimated");
      return;
    }
    if (mode === "buy") {
      if (amount > state.balance) {
        toast.error("Not enough demo USDT");
        return;
      }
      setState((s) => ({
        balance: s.balance - amount,
        holdings: s.holdings + amount / product.price,
        pool: s.pool + fee * 0.7,
        trades: [makeTrade(product.symbol, "BUY", amount, fee, product.price), ...s.trades].slice(0, 12),
      }));
      toast.success(`Bought ${product.symbol} · ${usd(fee * 0.7)} routed to the pool`);
    } else {
      const value = Math.min(amount, state.holdings * product.price);
      if (value <= 0) {
        toast.error(`You don't hold any ${product.symbol} yet`);
        return;
      }
      setState((s) => ({
        balance: s.balance + value - fee,
        holdings: Math.max(0, s.holdings - value / product.price),
        pool: s.pool + fee * 0.7,
        trades: [makeTrade(product.symbol, "SELL", value, fee, product.price), ...s.trades].slice(0, 12),
      }));
      toast.success(`Sold ${product.symbol} · ${usd(fee * 0.7)} routed to the pool`);
    }
  };

  const stats = useMemo(
    () => [
      { label: "Market cap", value: `$${compactNum(product.marketCap)}` },
      { label: "Volume 24h", value: `$${compactNum(product.volume24h)}` },
      { label: "Holders", value: compactNum(product.holders) },
      { label: "Creator pool", value: `$${compactNum(state.pool)}` },
    ],
    [product, state.pool]
  );

  return (
    <div className="mx-auto max-w-7xl overflow-x-clip px-4 pb-20 pt-24 sm:px-6">
      <Link
        to="/coins"
        className="inline-flex items-center gap-1.5 text-[12px] text-white/40 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Markets
      </Link>

      <div className="mt-5 flex flex-wrap items-start justify-between gap-5">
        <div className="flex items-start gap-3.5">
          <span
            className="grid h-14 w-14 place-items-center rounded-2xl text-xl font-bold text-black"
            style={{ background: `linear-gradient(135deg, ${product.gradient[0]}, ${product.gradient[1]})` }}
          >
            {product.name[0]}
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                {product.name}
              </h1>
              <span className="num rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50">
                ${product.symbol}
              </span>
              <span className="flex items-center gap-1 rounded-full bg-up/12 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-up">
                <span className="h-1 w-1 rounded-full bg-up" /> Live
              </span>
              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/45">
                {product.stage}
              </span>
            </div>
            <p className="mt-1.5 max-w-md text-[13px] text-white/40">{product.tagline}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/30">
              <span className="flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" /> Founder supply locked
              </span>
              <span className="flex items-center gap-1">
                <Globe2 className="h-3 w-3" /> Intents pay-in enabled
              </span>
              <span className="num">{product.curveProgress}% curve sold</span>
            </div>
          </div>
        </div>

        <Link
          to="/products/$productId"
          params={{ productId: product.id }}
          className="rounded-full border border-white/15 px-4 py-2 text-[12.5px] text-white/70 transition-colors hover:border-white/30 hover:text-white"
        >
          View product page
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-white/[0.07] bg-[#0b0b0b] px-3.5 py-3">
            <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/30">{s.label}</p>
            <p className="num mt-1.5 text-[15px] font-medium text-white">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.65fr_1fr] lg:items-start">
        <div className="min-w-0 space-y-3">
          <PriceChart price={product.price} change24h={product.change24h} points={chart} live={live} />
          <RecentTrades trades={state.trades} />
        </div>

        <div className="min-w-0 space-y-3">
          <TradePanel
            product={product}
            balance={state.balance}
            holdings={state.holdings}
            onTrade={handleTrade}
            onChainTrade={() => setTradeKey((k) => k + 1)}
            live={live}
          />
          <PositionPanel
            product={product}
            live={live}
            demoHoldings={state.holdings}
            demoBalance={state.balance}
            refreshKey={tradeKey}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <FeeSplitCard poolBalance={state.pool} fees24h={product.fees24h} />
        <IntentsQuoteCard />
      </div>

      <div className="mt-4 flex flex-col items-start justify-between gap-4 rounded-2xl border border-white/[0.08] bg-gradient-to-r from-[#0f120b] to-[#0a0a0a] p-5 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-orange-500/15 text-orange-400">
            <Flame className="h-5 w-5" />
          </span>
          <div>
            <p className="num text-lg font-semibold text-white">{signals.toLocaleString("en-US")}</p>
            <p className="text-[11.5px] text-white/40">
              Signals to the founder that you want this product to launch harder.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setSignals((n) => n + 1);
            toast.success("Signal sent (demo)");
          }}
          className="shrink-0 rounded-full border border-white/15 px-5 py-2.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-white/70 transition-colors hover:border-orange-400/40 hover:text-orange-300"
        >
          Click to ignite
        </button>
      </div>

      <p className={cn("mt-6 text-center text-[10.5px] uppercase tracking-[0.16em] text-white/20")}>
        {live
          ? `Live curve price from NEAR testnet · fills simulated · ${pct(product.change24h)} 24h`
          : `Demo prototype · price, volume and pool figures are simulated · ${pct(product.change24h)} 24h`}
      </p>
    </div>
  );
}

function makeTrade(symbol, side, amount, fee, price) {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    symbol,
    side,
    price,
    size: Math.round(amount),
    fee,
    pool: fee * 0.7,
    time: "just now",
  };
}