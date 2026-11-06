import { Link } from "@tanstack/react-router";
import Sparkline from "@/components/shared/Sparkline";
import { compactNum, pct, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function ProductCard({ product, showSpark = true }) {
  return (
    <Link
      to="/products/$productId"
      params={{ productId: product.id }}
      className="group relative flex flex-col rounded-2xl border border-white/[0.08] bg-[#0e0e0e] p-4 transition-all duration-300 hover:-translate-y-0.5 hover:border-white/20 hover:bg-[#121212]"
    >
      <div className="flex items-start gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[15px] font-bold text-black"
          style={{ background: `linear-gradient(135deg, ${product.gradient[0]}, ${product.gradient[1]})` }}
        >
          {product.name[0]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[15px] font-semibold text-white">{product.name}</h3>
            <span className="num shrink-0 text-[11px] text-white/35">${product.symbol}</span>
          </div>
          <p className="truncate text-[11.5px] text-white/40">{product.category}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/50">
          <span className="h-1 w-1 rounded-full bg-brand" />
          {product.stage}
        </span>
      </div>

      {showSpark && (
        <div className="mt-4 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="num text-lg font-semibold text-white">{usd(product.price)}</span>
              <span className={cn("num text-[11px] font-medium", product.change24h >= 0 ? "text-up" : "text-down")}>
                {pct(product.change24h)}
              </span>
            </div>
            <div className="mt-1">
              <Sparkline points={product.spark} positive={product.change24h >= 0} height={38} />
            </div>
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-white/35">
          <span>Curve</span>
          <span className="num text-white/55">{product.curveProgress}%</span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.07]">
          <div
            className="h-full rounded-full bg-brand transition-all duration-500"
            style={{ width: `${product.curveProgress}%` }}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-3">
        {[
          { label: "Pool", value: `$${compactNum(product.poolBalance)}` },
          { label: "Fees 24h", value: `$${compactNum(product.fees24h)}` },
          { label: "Holders", value: compactNum(product.holders) },
        ].map((stat) => (
          <div key={stat.label}>
            <p className="text-[9px] uppercase tracking-wider text-white/30">{stat.label}</p>
            <p className="num mt-0.5 text-[12px] font-medium text-white/85">{stat.value}</p>
          </div>
        ))}
      </div>
    </Link>
  );
}