import { useEffect, useState } from "react";
import { TOKEN_DECIMALS } from "@/lib/launchly";
import { formatUnits, ftBalance, useWallet } from "@/lib/wallet";
import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Your position: live on-chain balances when the wallet is connected,
 * otherwise the demo wallet's simulated fills.
 */
export default function PositionPanel({ product, live, demoHoldings, demoBalance, refreshKey = 0 }) {
  const { accountId, connected } = useWallet();
  const [real, setReal] = useState(null);

  const chain = product?.chain ?? {};
  const usdtId = chain.reserve_token ?? null;
  const tokenId = product?.tokenAccount ?? null;
  const showReal = live && connected && !!usdtId && !!tokenId;

  useEffect(() => {
    let on = true;
    if (!showReal) {
      setReal(null);
      return;
    }
    Promise.all([ftBalance(tokenId, accountId), ftBalance(usdtId, accountId)]).then(
      ([tokens, usdt]) => {
        if (on) setReal({ tokens, usdt });
      }
    );
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showReal, accountId, usdtId, tokenId, refreshKey]);

  const decimals = chain.reserve_decimals ?? 6;
  const holdings = showReal && real ? Number(real.tokens ?? 0n) / 10 ** TOKEN_DECIMALS : demoHoldings;
  const balance = showReal && real ? Number(real.usdt ?? 0n) / 10 ** decimals : demoBalance;
  const price = product?.price ?? 0;
  const positionValue = holdings * price;
  const share = positionValue + balance > 0 ? (positionValue / (positionValue + balance)) * 100 : 0;

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Your position</p>
          <p className="num mt-1 text-lg font-semibold text-white">
            {holdings.toLocaleString("en-US", { maximumFractionDigits: 0 })}{" "}
            <span className="text-[12px] text-white/40">{product.symbol}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Balance</p>
          <p className="num mt-1 text-[15px] text-white/80">{usd(balance)}</p>
        </div>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.07]">
        <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, share)}%` }} />
      </div>
      <p className="mt-2 text-[10px] text-white/25">
        {showReal ? (
          <>
            <span className="text-brand">On-chain balances</span>
            {real === null ? " · loading…" : ` · ${formatUnits(real.tokens ?? 0n, TOKEN_DECIMALS)} ${product.symbol}`}
          </>
        ) : (
          "Simulated fills — connect a wallet for your real position"
        )}
      </p>
    </div>
  );
}
