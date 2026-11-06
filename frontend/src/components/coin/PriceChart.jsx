import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pricePath } from "@/lib/demo-data";
import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";

const ranges = ["1H", "4H", "1D", "ALL"];

export default function PriceChart({ price, change24h, points = null, live = false }) {
  const [range, setRange] = useState("1D");
  const liveReady = live && points && points.filter((p) => p.price != null).length >= 2;
  const series = liveReady
    ? points.filter((p) => p.price != null).map((p) => p.price)
    : pricePath[range] || pricePath["1D"];
  const data = series.map((p, i) => ({ i, price: p }));
  const positive = (change24h ?? 0) >= 0;
  const stroke = positive ? "hsl(var(--up))" : "hsl(var(--down))";

  return (
    <div className="min-w-0 rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <span className="num text-2xl font-semibold text-white">{usd(price)}</span>
          <span className={cn("num text-[12px]", positive ? "text-up" : "text-down")}>
            {change24h == null ? "—" : `${positive ? "+" : ""}${change24h.toFixed(2)}%`}
          </span>
          <span className="text-[10px] uppercase tracking-[0.16em] text-white/25">24h</span>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1">
          {ranges.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                range === r ? "bg-white/10 text-white" : "text-white/40 hover:text-white/80"
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 h-[280px] w-full sm:h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="tradeChartFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
            <XAxis dataKey="i" hide />
            <YAxis domain={["dataMin", "dataMax"]} hide />
            <Tooltip
              cursor={{ stroke: "rgba(255,255,255,0.15)", strokeDasharray: "3 3" }}
              contentStyle={{
                background: "#111",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 12,
                fontSize: 12,
                fontFamily: "inherit",
              }}
              labelFormatter={() => "Curve price"}
              formatter={(value) => [usd(value), "Price"]}
            />
            <Area
              type="monotone"
              dataKey="price"
              stroke={stroke}
              strokeWidth={1.7}
              fill="url(#tradeChartFill)"
              dot={false}
              activeDot={{ r: 3, fill: stroke, stroke: "#0a0a0a", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-3 text-[10px] uppercase tracking-[0.16em] text-white/25">
        <span>Bonding curve · no external liquidity</span>
        <span>{liveReady ? "Keeper snapshots · testnet" : "Simulated price history"}</span>
      </div>
    </div>
  );
}