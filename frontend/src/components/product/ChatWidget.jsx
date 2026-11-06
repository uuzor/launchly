import { useEffect, useRef, useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import { useChat } from "@/lib/launchly";
import { cn } from "@/lib/utils";

/**
 * Per-product agent chat. The agent answers from chain state + product memory
 * with read-only tools only: chat can never trigger execution of any kind.
 */
export default function ChatWidget({ productId, productName }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const { messages, sending, error, send } = useChat(productId);
  const bottom = useRef(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, open]);

  const submit = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    send(text);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-brand px-4 py-3 text-[13px] font-semibold text-black shadow-lg shadow-black/40 transition hover:brightness-105"
      >
        <MessageCircle className="h-4 w-4" />
        Ask about {productName}
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 flex h-[440px] w-[min(360px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0c0c0c] shadow-2xl shadow-black/60">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <div>
          <p className="text-[13px] font-semibold text-white">Product agent</p>
          <p className="text-[10px] text-white/35">Read-only · answers about {productName}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-white/50 hover:text-white"
        >
          Close
        </button>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="text-[12px] leading-relaxed text-white/35">
            Ask about the curve, the pool, milestones or campaign rules. I can look things up but I
            can&apos;t trade, post or move anything.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <p
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[12.5px] leading-relaxed",
                m.role === "user" ? "bg-brand/15 text-white" : "bg-white/[0.05] text-white/75"
              )}
            >
              {m.text}
            </p>
          </div>
        ))}
        {sending && <p className="text-[12px] text-white/30">Thinking…</p>}
        {error && <p className="text-[12px] text-down">Agent unreachable: {error.message}</p>}
        <div ref={bottom} />
      </div>

      <form onSubmit={submit} className="flex items-center gap-2 border-t border-white/[0.07] p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Ask about ${productName}…`}
          className="h-10 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white placeholder:text-white/25 focus:border-brand/40 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-black disabled:opacity-30"
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
