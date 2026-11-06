import { useState } from "react";
import { Check, Flag, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import DataBadge from "@/components/shared/DataBadge";
import { posts, products } from "@/lib/demo-data";
import { useLiveProducts, useVerifierQueue } from "@/lib/launchly";
import { cn } from "@/lib/utils";

/**
 * Verifier queue. Live mode lists real verifier checks from the backend
 * (read-only: attestations run through the keeper daemon). Falls back to
 * demo posts when the backend is unreachable.
 */
export default function VerifyQueue() {
  const { data: checks, live } = useVerifierQueue();
  const { products: liveProducts } = useLiveProducts();
  const initial = posts.filter((p) => p.status === "pending" || p.status === "held");
  const [queue, setQueue] = useState(initial);

  const act = (id, status) => {
    setQueue((q) => q.filter((p) => p.id !== id));
    toast.success(status === "approved" ? "Post approved and attested (simulated)" : "Post held for review");
  };

  if (live && checks) {
    const nameFor = (pid) =>
      (liveProducts ?? []).find((p) => p.productId === pid)?.name ?? `Product ${pid}`;
    return (
      <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a]">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-400" /> Verifier queue
          </h2>
          <DataBadge live />
        </div>
        <div className="divide-y divide-white/[0.05]">
          {checks.map((c) => (
            <div key={c.post_id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-[12px] text-white/80">
                  {c.creator} <span className="text-white/25">→ {nameFor(c.product_id)}</span>
                </p>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                    c.valid
                      ? "border-brand/25 bg-brand/10 text-brand"
                      : "border-orange-400/25 bg-orange-400/10 text-orange-300"
                  )}
                >
                  {c.valid ? `score ${c.score}` : "invalid"}
                </span>
              </div>
              <p className="mt-1 truncate text-[10.5px] text-white/30">
                post #{c.post_id} · cycle {c.cycle_id}
                {c.simulated ? " · simulated fetch" : ""} · {c.reason || "—"}
              </p>
            </div>
          ))}
          {checks.length === 0 && (
            <p className="px-4 py-10 text-center text-[12px] text-white/30">
              No verifier checks yet — the keeper attests new posts each pass.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a]">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
          <ShieldAlert className="h-3.5 w-3.5 text-amber-400" /> Verifier queue
        </h2>
        <span className="num text-[10.5px] text-white/30">{queue.length} waiting</span>
      </div>

      <div className="divide-y divide-white/[0.05]">
        {queue.map((post) => {
          const product = products.find((p) => p.id === post.productId);
          return (
            <div key={post.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-[12px] text-white/80">
                  {post.creator} <span className="text-white/25">→ {product?.name}</span>
                </p>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                    post.status === "held"
                      ? "border-orange-400/25 bg-orange-400/10 text-orange-300"
                      : "border-amber-400/25 bg-amber-400/10 text-amber-300"
                  )}
                >
                  {post.status}
                </span>
              </div>
              <p className="num mt-1 truncate text-[10.5px] text-white/30">{post.url}</p>
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => act(post.id, "approved")}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand/12 py-1.5 text-[11px] font-medium text-brand transition-colors hover:bg-brand/20"
                >
                  <Check className="h-3 w-3" /> Approve
                </button>
                <button
                  type="button"
                  onClick={() => act(post.id, "held")}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 py-1.5 text-[11px] text-white/50 transition-colors hover:border-white/25 hover:text-white"
                >
                  <Flag className="h-3 w-3" /> Hold payout
                </button>
              </div>
            </div>
          );
        })}
        {queue.length === 0 && (
          <p className="px-4 py-10 text-center text-[12px] text-white/30">Queue is clear.</p>
        )}
      </div>
    </div>
  );
}
