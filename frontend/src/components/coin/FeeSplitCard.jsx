import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { poolComposition } from "@/lib/demo-data";

export default function FeeSplitCard({ poolBalance, fees24h }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
      <h2 className="text-[13px] font-semibold text-white">Where every fee goes</h2>
      <p className="mt-1 text-[11.5px] text-white/35">
        Split on-chain at settlement. Set when the coin launched.
      </p>

      <div className="mt-4 flex items-center gap-5">
        <div className="relative h-28 w-28 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={poolComposition}
                dataKey="value"
                innerRadius={38}
                outerRadius={54}
                paddingAngle={3}
                stroke="none"
                startAngle={90}
                endAngle={-270}
              >
                {poolComposition.map((entry) => (
                  <Cell key={entry.name} fill={entry.fill} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="num text-[13px] font-semibold text-white">70%</span>
            <span className="mt-6 absolute text-[8.5px] uppercase tracking-[0.16em] text-white/30">
              to pool
            </span>
          </div>
        </div>

        <ul className="flex-1 space-y-2.5">
          {poolComposition.map((item) => (
            <li key={item.name} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[12px] text-white/60">
                <span className="h-2 w-2 rounded-full" style={{ background: item.fill }} />
                {item.name}
              </span>
              <span className="num text-[12px] text-white/80">{item.value}%</span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 border-t border-white/[0.07] pt-2.5">
            <span className="text-[12px] text-white/40">Fees 24h</span>
            <span className="num text-[12px] text-white/80">{fees24h == null ? "—" : `$${fees24h.toLocaleString("en-US")}`}</span>
          </li>
        </ul>
      </div>

      <div className="mt-4 rounded-xl border border-brand/20 bg-brand/[0.05] px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-white/55">
          <span className="font-semibold text-brand">Pool balance ${poolBalance.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>{" "}
          — part of the stablecoin reserve is deployed in a simulated vault. Yield shown in this
          prototype is illustrative, not real.
        </p>
      </div>
    </div>
  );
}