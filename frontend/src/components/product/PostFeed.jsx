import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink, ShieldCheck, ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const statusStyles = {
  approved: "border-brand/25 bg-brand/10 text-brand",
  pending: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  held: "border-orange-400/25 bg-orange-400/10 text-orange-300",
  rejected: "border-red-500/25 bg-red-500/10 text-red-400",
};

export default function PostFeed({ posts, creators }) {
  const [votes, setVotes] = useState({});
  const [rated, setRated] = useState({});

  const rate = (postId, dir) => {
    setRated((r) => ({ ...r, [postId]: dir }));
    setVotes((v) => ({ ...v, [postId]: (v[postId] || 0) + (dir === "up" ? 1 : -1) }));
    toast.success("Rating recorded — one wallet, one vote");
  };

  return (
    <div className="space-y-2.5">
      {posts.map((post) => {
        const creator = creators.find((c) => c.account === post.creator);
        const myVote = rated[post.id];
        return (
          <article
            key={post.id}
            className="rounded-xl border border-white/[0.07] bg-[#0b0b0b] p-4 transition-colors hover:border-white/15"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  className="grid h-8 w-8 place-items-center rounded-full text-[11px] font-bold text-black"
                  style={{
                    background: `linear-gradient(135deg, ${creator?.gradient?.[0] || "#c6f24e"}, ${creator?.gradient?.[1] || "#2fbf71"})`,
                  }}
                >
                  {(creator?.name || post.creator)[0]}
                </span>
                <div>
                  <p className="text-[12.5px] font-medium text-white">
                    {creator?.handle || post.creator}
                  </p>
                  <p className="num text-[10.5px] text-white/30">
                    {post.creator} · {post.submitted}
                  </p>
                </div>
              </div>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                  statusStyles[post.status]
                )}
              >
                {post.status}
              </span>
            </div>

            <a
              href={`https://${post.url}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 flex items-center gap-1.5 truncate text-[12px] text-white/45 transition-colors hover:text-brand"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{post.url}</span>
            </a>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
              <div className="flex items-center gap-3 text-[11px] text-white/35">
                <span className="flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3 text-brand/60" />
                  Multiplier{" "}
                  <span className="num text-white/70">×{post.rating ? post.rating.toFixed(2) : "—"}</span>
                </span>
                <span className="num">{post.votes + (votes[post.id] || 0)} holder votes</span>
              </div>
              {post.status === "approved" ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => rate(post.id, "up")}
                    className={cn(
                      "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10.5px] transition-colors",
                      myVote === "up"
                        ? "border-brand/40 bg-brand/12 text-brand"
                        : "border-white/10 text-white/45 hover:border-white/25 hover:text-white"
                    )}
                  >
                    <ThumbsUp className="h-3 w-3" /> Quality
                  </button>
                  <button
                    type="button"
                    onClick={() => rate(post.id, "down")}
                    className={cn(
                      "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10.5px] transition-colors",
                      myVote === "down"
                        ? "border-down/40 bg-down/12 text-down"
                        : "border-white/10 text-white/45 hover:border-white/25 hover:text-white"
                    )}
                  >
                    <ThumbsDown className="h-3 w-3" /> Weak
                  </button>
                </div>
              ) : (
                <Link to="/dashboard" className="text-[10.5px] text-white/30 hover:text-white/60">
                  In verifier queue →
                </Link>
              )}
            </div>
          </article>
        );
      })}
      {posts.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-[12px] text-white/30">
          No posts submitted for this product yet.
        </div>
      )}
    </div>
  );
}