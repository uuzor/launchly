import { useState } from "react";
import { Check, ExternalLink, Lock, X } from "lucide-react";
import { toast } from "sonner";
import { TOKEN_DECIMALS } from "@/lib/launchly";
import { formatUnits, ftBalance, parseUnits, useWallet } from "@/lib/wallet";
import { explorerTxUrl, txHash, voteTx } from "@/lib/execute";
import { cn } from "@/lib/utils";

const chip = {
  voting: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  approved: "border-brand/25 bg-brand/10 text-brand",
  rejected: "border-red-500/25 bg-red-500/10 text-red-400",
};

export default function MilestonePanel({ milestones, product = null, live = false }) {
  const [voted, setVoted] = useState({});
  const [weight, setWeight] = useState("100");
  const [busy, setBusy] = useState("");
  const { accountId, connected, signIn, signAndSend } = useWallet();

  const tokenId = product?.tokenAccount ?? null;
  const real = live && connected && !!tokenId && product?.productId != null;
  const isFounder = connected && product?.founder?.account === accountId;

  const vote = async (m, side) => {
    if (!real) {
      setVoted((v) => ({ ...v, [m.id]: side }));
      toast.success(`Vote ${side === "for" ? "in favour" : "against"} recorded (simulated)`);
      return;
    }
    if (isFounder) {
      toast.error("Founders cannot vote on their own milestones");
      return;
    }
    const w = parseUnits(weight, TOKEN_DECIMALS);
    if (!w || w <= 0n) {
      toast.error("Enter a vote weight above zero");
      return;
    }
    const bal = await ftBalance(tokenId, accountId);
    if (bal != null && w > bal) {
      toast.error(`Insufficient ${product.symbol} balance (${formatUnits(bal, TOKEN_DECIMALS)})`);
      return;
    }
    setBusy(`${m.id}-${side}`);
    try {
      const outcomes = await signAndSend([
        voteTx(tokenId, product.productId, m.index ?? 0, side === "for", w.toString()),
      ]);
      const hash = txHash(outcomes[0]);
      setVoted((v) => ({ ...v, [m.id]: side }));
      toast.success(`Vote ${side === "for" ? "in favour" : "against"} locked on-chain`, {
        description: "Tokens stay locked until the vote finalizes",
        action: hash
          ? { label: "Explorer", onClick: () => window.open(explorerTxUrl(hash), "_blank") }
          : undefined,
      });
    } catch (e) {
      const msg = /reject|cancel|dismiss/i.test(e.message) ? "Transaction rejected in wallet" : e.message;
      toast.error("Vote failed", { description: msg.slice(0, 160) });
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-2.5">
      {milestones.map((m) => {
        const extraFor = voted[m.id] === "for" ? 1 : 0;
        const extraAgainst = voted[m.id] === "against" ? 1 : 0;
        const total = m.votesFor + m.votesAgainst + extraFor + extraAgainst;
        const forPct = Math.round(((m.votesFor + extraFor) / Math.max(total, 1)) * 100);
        const myVote = voted[m.id];
        const open = m.status === "voting";

        return (
          <article key={m.id} className="rounded-xl border border-white/[0.07] bg-[#0b0b0b] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-7 w-7 place-items-center rounded-lg bg-white/[0.06] text-white/50">
                  <Lock className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h3 className="text-[13px] font-medium leading-snug text-white">{m.title}</h3>
                  <p className="num mt-0.5 text-[10.5px] text-white/30">
                    {m.tranche} · {(m.tokens / 1e6).toFixed(0)}M tokens
                  </p>
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                  chip[m.status]
                )}
              >
                {m.status}
              </span>
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-white/40">{m.description}</p>

            <div className="mt-3 flex flex-wrap gap-2">
              {m.evidence.map((e) => (
                <span
                  key={e}
                  className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10.5px] text-white/40"
                >
                  <ExternalLink className="h-2.5 w-2.5" />
                  {e}
                </span>
              ))}
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between text-[10.5px] text-white/35">
                <span className="num">
                  {forPct}% for · {total} votes cast
                </span>
                <span>{m.closes}</span>
              </div>
              <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="h-full bg-brand" style={{ width: `${forPct}%` }} />
                <div className="h-full bg-down/70" style={{ width: `${100 - forPct}%` }} />
              </div>
            </div>

            {real && open && (
              <div className="mt-3 flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-[0.16em] text-white/30">
                  Weight ({product.symbol}, locks until final)
                </label>
                <input
                  value={weight}
                  onChange={(e) => setWeight(e.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                  className="num h-8 w-28 rounded-lg border border-white/10 bg-white/[0.03] px-2 text-[12px] text-white focus:border-brand/40 focus:outline-none"
                />
              </div>
            )}
            {live && !connected && open && (
              <button
                type="button"
                onClick={signIn}
                className="mt-3 w-full rounded-lg border border-brand/30 bg-brand/[0.07] py-2 text-[11.5px] font-semibold text-brand transition-colors hover:bg-brand/[0.12]"
              >
                Connect wallet to vote on-chain
              </button>
            )}

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={!open || !!busy}
                onClick={() => vote(m, "for")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg border py-2 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  myVote === "for"
                    ? "border-brand/40 bg-brand/12 text-brand"
                    : "border-white/10 text-white/60 hover:border-white/25 hover:text-white"
                )}
              >
                <Check className="h-3.5 w-3.5" /> Approve unlock
              </button>
              <button
                type="button"
                disabled={!open || !!busy}
                onClick={() => vote(m, "against")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg border py-2 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  myVote === "against"
                    ? "border-down/40 bg-down/12 text-down"
                    : "border-white/10 text-white/60 hover:border-white/25 hover:text-white"
                )}
              >
                <X className="h-3.5 w-3.5" /> Reject
              </button>
            </div>

            <p className="mt-2 text-[10.5px] leading-relaxed text-white/30">
              {open
                ? myVote
                  ? real
                    ? "Your vote is locked on-chain — one vote per wallet, 5% cap each."
                    : "Your vote is recorded in this demo session — one vote per holder."
                  : real
                    ? "One vote per wallet, weighted by locked tokens (5% cap). Founders can't vote."
                    : "One vote per holder, weighted by the snapshot taken when the milestone was proposed."
                : m.status === "approved"
                  ? "Voting closed — tranche released, founder supply unlocked."
                  : "Voting closed — rejected by holders, tranche stays locked."}
            </p>
          </article>
        );
      })}
      {milestones.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-[12px] text-white/30">
          No milestones published yet.
        </div>
      )}
    </div>
  );
}