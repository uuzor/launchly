import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import ProductCard from "@/components/products/ProductCard";
import { products } from "@/lib/demo-data";

export default function LiveLaunches() {
  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-brand">
              Live right now
            </p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight text-white sm:text-4xl">
              Products funding themselves.
            </h2>
          </div>
          <Link
            to="/discover"
            className="group hidden items-center gap-1.5 text-[13px] font-medium text-white/50 transition-colors hover:text-white sm:flex"
          >
            View all
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {products.slice(0, 6).map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </div>
    </section>
  );
}