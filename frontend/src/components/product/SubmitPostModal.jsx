import { useState } from "react";
import { Send, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/launchly";
import { useWallet } from "@/lib/wallet";
import { explorerTxUrl, submitPostTx, txHash } from "@/lib/execute";
import { cn } from "@/lib/utils";

/**
 * Creator post submission: backend pre-validates (https, handle, Live
 * product, open cycle), then the creator signs submit_post (0.01 NEAR
 * storage). The verifier attests it on the next keeper pass.
 */
export default function SubmitPostModal({ product, onClose, onSubmitted }) {
  const [url, setUrl] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const { accountId, connected, signIn, signAndSend } = useWallet();

  const submit = async (e) => {
    e.preventDefault();
    if (!connected) {
      signIn();
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const check = await api("/posts/validate", {
        method: "POST",
        body: { product_id: product.productId, url: url.trim(), handle: handle.trim() || accountId },
      });
      if (!check.ok) {
        setErrors(check.errors ?? ["validation failed"]);
        return;
      }
      const outcomes = await signAndSend([
        submitPostTx(product.productId, url.trim(), handle.trim() || accountId),
      ]);
      const hash = txHash(outcomes[0]);
      toast.success("Post submitted on-chain", {
        description: "The verifier scores it on the next keeper pass",
        action: hash
          ? { label: "Explorer", onClick: () => window.open(explorerTxUrl(hash), "_blank") }
          : undefined,
      });
      onSubmitted?.();
      onClose();
    } catch (err) {
      const msg = /reject|cancel|dismiss/i.test(err.message)
        ? "Transaction rejected in wallet"
        : err.message;
      setErrors([msg.slice(0, 200)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0c0c0c] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-white">Submit a post</h2>
            <p className="mt-0.5 text-[11.5px] text-white/40">
              for {product.name} (${product.symbol})
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full border border-white/10 text-white/50 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {product.rules && (
          <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-[11.5px] leading-relaxed text-white/45">
            Must link <span className="num text-white/70">{product.rules.requiredLink}</span> and tag{" "}
            <span className="num text-white/70">{product.rules.requiredTag}</span>, from an account
            at least {product.rules.minAccountAgeDays}d old.
          </div>
        )}

        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[10px] uppercase tracking-[0.16em] text-white/30">Post URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://x.com/you/status/…"
              className="num mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[12.5px] text-white placeholder:text-white/25 focus:border-brand/40 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-[0.16em] text-white/30">
              Social handle (defaults to {connected ? accountId : "wallet account"})
            </span>
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="@you"
              className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[12.5px] text-white placeholder:text-white/25 focus:border-brand/40 focus:outline-none"
            />
          </label>

          {errors.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-down/25 bg-down/[0.06] p-3 text-[11.5px] text-down">
              {errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}

          <button
            type="submit"
            disabled={busy || !url.trim()}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-[13px] font-semibold text-black transition hover:brightness-105 disabled:opacity-35"
            )}
          >
            <Send className="h-3.5 w-3.5" />
            {busy ? "Submitting…" : connected ? "Sign + submit (0.01 NEAR)" : "Connect wallet to submit"}
          </button>
          <p className="text-center text-[10px] text-white/25">
            Duplicate URLs are rejected on-chain · max {product.chain?.max_posts_per_creator ?? "—"} counted
            posts per creator per cycle
          </p>
        </form>
      </div>
    </div>
  );
}
