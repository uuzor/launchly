import { createFileRoute, Link } from "@tanstack/react-router";
import ProductDetail from "@/components/product/ProductDetail";
import { getProduct } from "@/lib/demo-data";
import { useLiveProduct } from "@/lib/launchly";

export const Route = createFileRoute("/_site/products/$productId")({
  // Product resolves client-side (live backend first, demo fallback).
  loader: ({ params }) => ({ productId: params.productId }),
  head: () => ({
    meta: [
      { title: "Product — Launchly" },
      { name: "description", content: "A product raising on Launchly." },
    ],
  }),
  component: ProductPage,
});

function ProductPage() {
  const { productId } = Route.useParams();
  const numeric = /^\d+$/.test(productId);
  const { product: liveProduct, live, loading } = useLiveProduct(numeric ? productId : null);
  const product = (numeric ? liveProduct : null) ?? getProduct(productId);

  if (!product) {
    if (numeric && loading) {
      return (
        <div className="mx-auto max-w-3xl px-4 pb-20 pt-32 text-center">
          <p className="text-white/50">Loading product #{productId}…</p>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-3xl px-4 pb-20 pt-32 text-center">
        <p className="text-white/50">This product is not listed.</p>
        <Link to="/discover" className="mt-4 inline-block text-brand">
          Back to discovery
        </Link>
      </div>
    );
  }
  return <ProductDetail product={product} live={live && !!liveProduct} />;
}
