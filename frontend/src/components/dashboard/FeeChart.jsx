import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function FeeChart({ data }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-white">Fee inflows &amp; pool growth</h2>
          <p className="mt-1 text-[11px] text-white/30">Last 30 days · all launches combined</p>
        </div>
        <div className="flex items-center gap-4 text-[10.5px]">
          <span className="flex items-center gap-1.5 text-white/45">
            <span className="h-1.5 w-3 rounded-full bg-white/35" /> Fees
          </span>
          <span className="flex items-center gap-1.5 text-white/45">
            <span className="h-1.5 w-3 rounded-full bg-brand" /> Pool
          </span>
        </div>
      </div>

      <div className="mt-4 h-[260px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="dashPool" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--brand))" stopOpacity={0.3} />
                <stop offset="100%" stopColor="hsl(var(--brand))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 9.5 }}
              axisLine={false}
              tickLine={false}
              interval={4}
            />
            <YAxis
              tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 9.5 }}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <Tooltip
              contentStyle={{
                background: "#111",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 12,
                fontSize: 12,
              }}
              cursor={{ stroke: "rgba(255,255,255,0.12)" }}
            />
            <Area
              type="monotone"
              dataKey="fees"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth={1.2}
              fill="transparent"
            />
            <Area
              type="monotone"
              dataKey="pool"
              stroke="hsl(var(--brand))"
              strokeWidth={1.8}
              fill="url(#dashPool)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}