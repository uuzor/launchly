import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function RecentTrades({ trades }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a0a0a]">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <h2 className="text-[13px] font-semibold text-white">Recent curve trades</h2>
        <span className="text-[10px] uppercase tracking-[0.16em] text-white/25">Live feed · simulated</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] text-left">
          <thead>
            <tr className="border-b border-white/[0.06]">
              {["Pair", "Side", "Price", "Size", "Fee", "Pool cut", "Time"].map((h, i) => (
                <th
                  key={h}
                  className={cn(
                    "px-4 py-2 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-white/25",
                    i >= 2 && "text-right"
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id} className="border-b border-white/[0.04] last:border-0">
                <td className="num px-4 py-2.5 text-[12px] text-white/80">{t.symbol}/USDT</td>
                <td className="px-4 py-2.5">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[9.5px] font-bold tracking-wider",
                      t.side === "BUY" ? "bg-up/15 text-up" : "bg-down/15 text-down"
                    )}
                  >
                    {t.side}
                  </span>
                </td>
                <td className="num px-4 py-2.5 text-right text-[12px] text-white/70">{usd(t.price)}</td>
                <td className="num px-4 py-2.5 text-right text-[12px] text-white/70">
                  {t.size.toLocaleString("en-US")}
                </td>
                <td className="num px-4 py-2.5 text-right text-[12px] text-white/70">{usd(t.fee)}</td>
                <td className="num px-4 py-2.5 text-right text-[12px] text-brand">{usd(t.pool)}</td>
                <td className="num px-4 py-2.5 text-right text-[11px] text-white/30">{t.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}