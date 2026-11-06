import ProductCard from "@/components/products/ProductCard";
import { cn } from "@/lib/utils";

export default function ProductColumn({ title, hint, products, accent }) {
  return (
    <div className="flex flex-col rounded-2xl border border-white/[0.07] bg-[#080808] p-3">
      <div className="flex items-center justify-between px-1.5 pb-3">
        <div>
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <span className={cn("h-1.5 w-1.5 rounded-full", accent)} />
            {title}
          </h2>
          <p className="mt-0.5 text-[10.5px] text-white/30">{hint}</p>
        </div>
        <span className="num rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/40">
          {products.length}
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
        {products.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center">
            <p className="text-[12px] text-white/30">Nothing here yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}