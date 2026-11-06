import { useState } from "react";
import { toast } from "sonner";
import { useWallet } from "@/lib/wallet";
import { explorerTxUrl, publishMilestoneTx, txHash } from "@/lib/execute";

/**
 * Founder-only milestone publisher: signs publish_milestone on-chain with an
 * evidence URL, opening the holder voting window. Renders nothing unless the
 * connected wallet is the product founder.
 */
export default function PublishMilestoneForm({ product }) {
  const [open, setOpen] = useState(false);
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const { accountId, connected, signAndSend } = useWallet();

  if (!connected || accountId !== product.founder?.account) return null;

  const publish = async (e) => {
    e.preventDefault();
    if (!evidenceUrl.trim().startsWith("https://")) {
      toast.error("Evidence URL must be https");
      return;
    }
    setBusy(true);
    try {
      const outcomes = await signAndSend([
        publishMilestoneTx(product.productId, evidenceUrl.trim(), null),
      ]);
      const hash = txHash(outcomes[0]);
      toast.success("Milestone published — voting window open", {
        action: hash
          ? { label: "Explorer", onClick: () => window.open(explorerTxUrl(hash), "_blank") }
          : undefined,
      });
      setOpen(false);
      setEvidenceUrl("");
    } catch (err) {
      const msg = /reject|cancel|dismiss/i.test(err.message)
        ? "Transaction rejected in wallet"
        : err.message;
      toast.error("Publish failed", { description: msg.slice(0, 180) });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 w-full rounded-xl border border-brand/30 bg-brand/[0.07] py-2.5 text-[12px] font-semibold text-brand transition-colors hover:bg-brand/[0.12]"
      >
        + Publish a milestone (founder)
      </button>
    );
  }

  return (
    <form
      onSubmit={publish}
      className="mt-3 space-y-2.5 rounded-xl border border-brand/20 bg-brand/[0.04] p-4"
    >
      <input
        value={evidenceUrl}
        onChange={(e) => setEvidenceUrl(e.target.value)}
        placeholder="https:// evidence link (stored on-chain)"
        className="num h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[12.5px] text-white placeholder:text-white/25 focus:border-brand/40 focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex-1 rounded-xl border border-white/10 py-2 text-[12px] text-white/60 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !evidenceUrl.trim()}
          className="flex-1 rounded-xl bg-brand py-2 text-[12px] font-semibold text-black transition hover:brightness-105 disabled:opacity-35"
        >
          {busy ? "Publishing…" : "Sign + publish (0.01 NEAR)"}
        </button>
      </div>
      <p className="text-[10.5px] text-white/30">
        Max 4 milestones per product · holders vote with locked tokens · you cannot vote on your own.
      </p>
    </form>
  );
}
