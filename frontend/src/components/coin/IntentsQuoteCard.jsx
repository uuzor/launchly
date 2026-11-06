import { useState } from "react";
import { ArrowRight, Globe2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const sources = [
  { id: "usdc-base", label: "USDC on Base", rate: 0.9975 },
  { id: "usdt-arb", label: "USDT on Arbitrum", rate: 0.9968 },
  { id: "sol-solana", label: "SOL on Solana", rate: 0.9941 },
  { id: "eth-ethereum", label: "ETH on Ethereum", rate: 0.9935 },
];

export default function IntentsQuoteCard() {
  const [source, setSource] = useState(sources[0].id);
  const [amount, setAmount] = useState("250");
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(false);

  const selected = sources.find((s) => s.id === source) || sources[0];
  const value = Number(amount) || 0;

  const requestQuote = () => {
    setLoading(true);
    setQuote(null);
    window.setTimeout(() => {
      setLoading(false);
      setQuote({
        receive: Number((value * selected.rate * 0.998).toFixed(2)),
        fee: Number((value * 0.002).toFixed(2)),
        minutes: 4,
      });
    }, 700);
  };

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-white/[0.06] text-white/60">
          <Globe2 className="h-3.5 w-3.5" />
        </span>
        <div>
          <h2 className="text-[13px] font-semibold text-white">Pay in from another chain</h2>
          <p className="text-[10.5px] text-white/30">Powered by NEAR Intents · 1Click API</p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <select
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setQuote(null);
          }}
          className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[12.5px] text-white/75 focus:border-brand/40 focus:outline-none"
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id} className="bg-[#111]">
              {s.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
          <input
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^0-9.]/g, ""));
              setQuote(null);
            }}
            inputMode="decimal"
            className="num w-full bg-transparent text-sm text-white focus:outline-none"
          />
          <span className="num text-[11px] text-white/40">USDT</span>
        </div>
      </div>

      <button
        type="button"
        onClick={requestQuote}
        disabled={!value || loading}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-white/12 py-2.5 text-[12.5px] font-medium text-white/80 transition-colors hover:border-white/25 hover:text-white disabled:opacity-40"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
        {loading ? "Requesting dry quote" : "Get dry quote"}
      </button>

      <div
        className={cn(
          "mt-3 overflow-hidden rounded-xl border transition-all",
          quote ? "max-h-40 border-brand/25 bg-brand/[0.05] p-3" : "max-h-0 border-transparent p-0"
        )}
      >
        {quote && (
          <div className="space-y-1.5 text-[11.5px]">
            <div className="flex justify-between text-white/45">
              <span>You receive on NEAR</span>
              <span className="num text-white">{quote.receive.toFixed(2)} USDT</span>
            </div>
            <div className="flex justify-between text-white/45">
              <span>1Click fee (0.2%)</span>
              <span className="num">{quote.fee.toFixed(2)} USDT</span>
            </div>
            <div className="flex justify-between text-white/45">
              <span>Estimated settle</span>
              <span className="num">~{quote.minutes} min</span>
            </div>
            <p className="pt-1 text-[10px] leading-relaxed text-white/25">
              Dry quote · no deposit address in the demo. Mainnet would return a 10-minute address.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}