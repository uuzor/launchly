import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Rocket } from "lucide-react";
import { toast } from "sonner";
import DataBadge from "@/components/shared/DataBadge";
import LaunchStepCoin from "@/components/launch/LaunchStepCoin";
import LaunchStepProduct from "@/components/launch/LaunchStepProduct";
import LaunchStepRules from "@/components/launch/LaunchStepRules";
import { apiBytes, drafts } from "@/lib/launchly";
import { CONTRACT_ID, rpcView, useWallet } from "@/lib/wallet";
import { completeLaunchTx, createProductTx, explorerTxUrl, launchCoinTx, txHash } from "@/lib/execute";
import { cn } from "@/lib/utils";

// Testnet chain defaults (mirror intents/sim_demo.py).
const CHAIN_DEFAULTS = {
  reserve_token: "usdt.fakes.testnet",
  reserve_decimals: 6,
  fee_bps: 100,
  curve_p0: "100",
  curve_rise: "1000000",
  min_vote_holding: "1000",
  cycle_duration_ns: 600_000_000_000,
  dispute_duration_ns: 60_000_000_000,
  milestone_window_ns: 60_000_000_000,
  milestone_deadline_ns: 600_000_000_000,
};

const steps = [
  { id: 0, label: "Product" },
  { id: 1, label: "Campaign rules" },
  { id: 2, label: "Coin" },
  { id: 3, label: "Review" },
];

const initialForm = {
  name: "Vectorly",
  symbol: "VCTR",
  tagline: "Ship AI agents that run your back office.",
  description:
    "Vectorly lets a two-person team stand up an agent that reads invoices, reconciles them against the ledger and writes the journal entry. Every action is logged and reversible.",
  problem:
    "Small teams spend their evenings on reconciliation and data entry because the tools they can afford stop at the dashboard.",
  category: "Developer Tools",
  demoUrl: "https://demo.vectorly.xyz",
  tags: "Agents, No-code, Ops",
  requiredLink: "demo.vectorly.xyz",
  requiredTag: "#VCTR",
  minAccountAgeDays: "7",
  maxPosts: "4",
  banned: "No price predictions, no screenshots of private dashboards, no reposted threads.",
  acknowledged: false,
};

function demoHash(seed) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < seed.length; i += 1) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`.repeat(2).slice(0, 64);
}

export default function LaunchWizard() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(initialForm);
  const [founder, setFounder] = useState("");
  const [logoFile, setLogoFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [onchain, setOnchain] = useState({ pid: null, step: 0, busy: "", done: false });
  const { accountId, connected, signIn, signAndSend } = useWallet();

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const launched = result !== null;

  const metadataHash = demoHash(
    JSON.stringify({
      name: form.name,
      symbol: form.symbol,
      tagline: form.tagline,
      description: form.description,
      problem: form.problem,
      category: form.category,
      demoUrl: form.demoUrl,
    })
  );
  const rulesHash = demoHash(
    JSON.stringify({
      requiredLink: form.requiredLink,
      requiredTag: form.requiredTag,
      minAccountAgeDays: form.minAccountAgeDays,
      maxPosts: form.maxPosts,
      banned: form.banned,
    })
  );

  const canContinue =
    step === 0
      ? form.name.trim() && form.symbol.trim() && form.tagline.trim() && form.description.trim()
      : step === 1
        ? form.requiredLink.trim() && form.requiredTag.trim() && form.minAccountAgeDays
        : step === 2
          ? form.acknowledged
          : true;

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const created = await drafts.create(founder.trim());
      let logoRef = null;
      if (logoFile) {
        const bytes = new Uint8Array(await logoFile.arrayBuffer());
        const up = await apiBytes(
          `/products/drafts/${created.draft_id}/assets/logo`,
          bytes,
          created.edit_token
        );
        logoRef = up.sha256;
      }
      const link = form.requiredLink.trim();
      const metadata = {
        name: form.name.trim(),
        symbol: form.symbol.trim(),
        tagline: form.tagline.trim(),
        description: form.description.trim(),
        problem: form.problem.trim(),
        category: form.category.trim(),
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 5),
        demo_url: form.demoUrl.trim(),
        ...(logoRef ? { logo: logoRef } : {}),
      };
      const rules = {
        required_link: link.startsWith("https://") ? link : `https://${link}`,
        required_tag: form.requiredTag.trim(),
        min_account_age_days: Number(form.minAccountAgeDays) || 0,
        banned_content_notes: form.banned.trim(),
      };
      await drafts.update(created.draft_id, created.edit_token, metadata, rules);
      const fin = await drafts.finalize(created.draft_id, created.edit_token);
      setResult({ ...fin, draft_id: created.draft_id, live: true });
      toast.success("Draft finalized — sign create_product with these hashes");
    } catch (e) {
      // Backend down or validation failed: fall back to local demo hashes.
      setResult({
        metadata_hash: metadataHash,
        rules_hash: rulesHash,
        create_args: null,
        live: false,
        error: e.message,
      });
      toast.error(`Backend submit failed (${e.message}) — showing demo hashes`);
    } finally {
      setSubmitting(false);
    }
  };

  const findPid = async () => {
    const prods = (await rpcView(CONTRACT_ID, "list_products", { from_index: 0, limit: 200 })) ?? [];
    for (let i = prods.length - 1; i >= 0; i -= 1) {
      const p = prods[i];
      if (p.founder === accountId && p.metadata_hash === result.metadata_hash) return i + 1;
    }
    return null;
  };

  const signStep = async (label, build) => {
    setOnchain((s) => ({ ...s, busy: label }));
    try {
      const transactions = await build();
      const outcomes = await signAndSend(transactions);
      const hash = txHash(outcomes[0]);
      toast.success(`${label} confirmed`, {
        action: hash
          ? { label: "Explorer", onClick: () => window.open(explorerTxUrl(hash), "_blank") }
          : undefined,
      });
      return true;
    } catch (e) {
      const msg = /reject|cancel|dismiss/i.test(e.message) ? "Transaction rejected in wallet" : e.message;
      toast.error(`${label} failed`, { description: msg.slice(0, 180) });
      return false;
    } finally {
      setOnchain((s) => ({ ...s, busy: "" }));
    }
  };

  const doCreate = async () => {
    const ok = await signStep("create_product", async () => [
      createProductTx({
        ...result.create_args,
        ...CHAIN_DEFAULTS,
        max_posts_per_creator: Number(form.maxPosts) || 5,
      }),
    ]);
    if (!ok) return;
    const pid = await findPid();
    if (!pid) {
      toast.error("Created, but the product wasn't found — refresh discovery in a minute");
      return;
    }
    setOnchain((s) => ({ ...s, pid, step: 1 }));
  };

  const doLaunch = async () => {
    const cost = await rpcView(CONTRACT_ID, "get_launch_cost", {});
    const ok = await signStep("launch_coin", async () => [launchCoinTx(onchain.pid, cost)]);
    if (ok) setOnchain((s) => ({ ...s, step: 2 }));
  };

  const doComplete = async () => {
    const ok = await signStep("complete_launch", async () => [completeLaunchTx(onchain.pid)]);
    if (ok) setOnchain((s) => ({ ...s, step: 3, done: true }));
  };

  if (launched) {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-24 pt-32 sm:px-6">
        <div className="rounded-3xl border border-brand/25 bg-gradient-to-b from-brand/[0.08] to-transparent p-8 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand text-black">
            <Check className="h-6 w-6" strokeWidth={3} />
          </span>
          <div className="mt-4 flex justify-center">
            <DataBadge live={result.live} />
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-white">
            {result.live ? "Draft finalized" : "Launch submitted (demo)"}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-white/45">
            {result.live ? (
              <>
                Draft anchored. Sign the three on-chain steps below as the founder — the keeper
                matches the hashes and the listing goes live.
              </>
            ) : (
              <>
                In the live flow the founder now signs{" "}
                <span className="num text-white/70">launch_coin</span> with these two hashes, then{" "}
                <span className="num text-white/70">complete_launch</span>. The indexer matches them
                and the listing goes live.
              </>
            )}
          </p>
          {result.error && (
            <p className="mx-auto mt-2 max-w-md text-[12px] text-down">{result.error}</p>
          )}

          <div className="mt-6 space-y-2 rounded-2xl border border-white/[0.08] bg-black/40 p-4 text-left">
            {[
              { label: "metadata_hash", value: result.metadata_hash },
              { label: "rules_hash", value: result.rules_hash },
              result.live
                ? { label: "draft_id", value: result.draft_id }
                : { label: "tx", value: demoHash(`${form.name}-tx`) },
            ].map((row) => (
              <div key={row.label}>
                <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/25">{row.label}</p>
                <p className="num mt-0.5 break-all text-[10.5px] text-white/55">{row.value}</p>
              </div>
            ))}
          </div>

          {result.live && (
            <OnchainSteps
              onchain={onchain}
              connected={connected}
              accountId={accountId}
              founderHint={founder}
              signIn={signIn}
              doCreate={doCreate}
              doLaunch={doLaunch}
              doComplete={doComplete}
            />
          )}

          <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
            <Link
              to="/dashboard"
              className="rounded-full bg-white px-6 py-3 text-[13px] font-semibold text-black"
            >
              Open the dashboard
            </Link>
            <Link
              to="/discover"
              className="rounded-full border border-white/15 px-6 py-3 text-[13px] text-white/70"
            >
              See it in discovery
            </Link>
          </div>
          <p className="mt-5 text-[10px] uppercase tracking-[0.16em] text-white/20">
            Prototype · no transaction was sent
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-28 sm:px-6">
      <div className="flex flex-col gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-brand">Launch</p>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-[40px]">
          List a product. Launch its coin.
        </h1>
        <p className="max-w-2xl text-sm text-white/40">
          Four steps. Your content is hashed and anchored on-chain, the fee is fixed, and 10% of
          supply stays locked behind holder-approved milestones.
        </p>
      </div>

      <div className="mt-7 grid gap-4 lg:grid-cols-[1.5fr_1fr] lg:items-start">
        <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5 sm:p-6">
          {/* stepper */}
          <div className="flex items-center gap-2">
            {steps.map((s, i) => (
              <div key={s.id} className="flex flex-1 items-center gap-2">
                <button
                  type="button"
                  onClick={() => i <= step && setStep(i)}
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors",
                    i < step
                      ? "bg-brand/20 text-brand"
                      : i === step
                        ? "bg-brand text-black"
                        : "border border-white/10 text-white/30"
                  )}
                >
                  {i < step ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
                </button>
                <span
                  className={cn(
                    "hidden text-[11px] sm:block",
                    i === step ? "text-white" : "text-white/30"
                  )}
                >
                  {s.label}
                </span>
                {i < steps.length - 1 && <span className="h-px flex-1 bg-white/10" />}
              </div>
            ))}
          </div>

          <div className="mt-6">
            {step === 0 && <LaunchStepProduct form={form} set={set} />}
            {step === 1 && <LaunchStepRules form={form} set={set} />}
            {step === 2 && <LaunchStepCoin form={form} set={set} />}
            {step === 3 && (
              <div className="space-y-4">
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <label className="block rounded-xl border border-white/[0.08] p-4">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-white/30">
                      Founder account (testnet)
                    </span>
                    <input
                      value={founder}
                      onChange={(e) => setFounder(e.target.value)}
                      placeholder="you.testnet"
                      className="num mt-1.5 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[12.5px] text-white placeholder:text-white/25 focus:border-brand/40 focus:outline-none"
                    />
                  </label>
                  <label className="block rounded-xl border border-white/[0.08] p-4">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-white/30">
                      Logo (PNG/JPEG/WebP)
                    </span>
                    <input
                      type="file"
                      accept=".png,.jpg,.jpeg,.webp"
                      onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
                      className="mt-1.5 w-full text-[12px] text-white/60 file:mr-2 file:rounded-lg file:border file:border-white/15 file:bg-white/[0.05] file:px-3 file:py-1.5 file:text-[11px] file:text-white/70"
                    />
                    {logoFile && (
                      <span className="mt-1 block text-[11px] text-brand">{logoFile.name}</span>
                    )}
                  </label>
                </div>
                <div className="rounded-xl border border-white/[0.08] p-4">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/30">
                    Canonical metadata hash
                  </p>
                  <p className="num mt-1.5 break-all text-[10.5px] leading-relaxed text-white/50">
                    {metadataHash}
                  </p>
                  <p className="mt-3 text-[10px] uppercase tracking-[0.16em] text-white/30">
                    Campaign rules hash
                  </p>
                  <p className="num mt-1.5 break-all text-[10.5px] leading-relaxed text-white/50">
                    {rulesHash}
                  </p>
                  <p className="mt-2 text-[10.5px] text-white/25">
                    Preview only — the backend canonicalizes and hashes on submit.
                  </p>
                </div>

                <div className="grid gap-2.5 sm:grid-cols-2">
                  {[
                    { label: "Name", value: `${form.name} ($${form.symbol})` },
                    { label: "Category", value: form.category },
                    { label: "Demo link", value: form.demoUrl },
                    { label: "Required tag", value: form.requiredTag },
                    { label: "Counted posts", value: `${form.maxPosts} per creator` },
                    { label: "Fee", value: "1.00% · fixed at launch" },
                  ].map((row) => (
                    <div key={row.label} className="rounded-xl border border-white/[0.07] px-3 py-2.5">
                      <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/25">{row.label}</p>
                      <p className="mt-0.5 truncate text-[12px] text-white/75">{row.value}</p>
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border border-brand/20 bg-brand/[0.05] p-4">
                  <p className="text-[11.5px] leading-relaxed text-white/55">
                    Next: sign <span className="num text-white/80">launch_coin(metadata_hash, rules_hash)</span>{" "}
                    from <span className="num text-white/80">ada.near</span>, then{" "}
                    <span className="num text-white/80">complete_launch</span>. This demo submits
                    locally only.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-white/[0.07] pt-4">
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
              className="flex items-center gap-1.5 rounded-full px-3 py-2 text-[12px] text-white/45 transition-colors hover:text-white disabled:opacity-30"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <button
              type="button"
              disabled={!canContinue || submitting}
              onClick={() => (step === 3 ? submit() : setStep((s) => s + 1))}
              className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-[12.5px] font-semibold text-black transition-all hover:brightness-105 disabled:opacity-35"
            >
              {step === 3 ? (
                <>
                  <Rocket className="h-3.5 w-3.5" /> {submitting ? "Finalizing…" : "Launch coin"}
                </>
              ) : (
                <>
                  Continue <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          </div>
        </div>

        {/* Live preview */}
        <aside className="space-y-3 lg:sticky lg:top-24">
          <div className="rounded-2xl border border-white/[0.08] bg-[#0b0b0b] p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Listing preview</p>
            <div className="mt-4 flex items-start gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand to-emerald-500 text-[15px] font-bold text-black">
                {(form.name || "L")[0]}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold text-white">{form.name || "Product name"}</p>
                <p className="num text-[11px] text-white/35">${form.symbol || "TICKER"}</p>
              </div>
            </div>
            <p className="mt-3 line-clamp-2 text-[12px] leading-relaxed text-white/45">
              {form.tagline || "Your tagline shows here."}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-white/[0.07] pt-3 text-[11px]">
              <div>
                <p className="text-white/30">Curve</p>
                <p className="num mt-0.5 text-white/75">0% sold</p>
              </div>
              <div>
                <p className="text-white/30">Pool</p>
                <p className="num mt-0.5 text-brand">$0.00</p>
              </div>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.07]">
              <div className="h-full w-[3%] rounded-full bg-brand" />
            </div>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-[#0a0a0a] p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">What happens on launch</p>
            <ol className="mt-3 space-y-2.5">
              {[
                "Your metadata and campaign rules are hashed.",
                "launch_coin mints the NEP-141 token and opens the curve.",
                "The fee router splits every trade 70 / 20 / 10.",
                "Your 10% allocation locks in the vesting contract.",
              ].map((line, i) => (
                <li key={line} className="flex gap-2.5 text-[11.5px] leading-relaxed text-white/45">
                  <span className="num text-white/25">0{i + 1}</span>
                  {line}
                </li>
              ))}
            </ol>
            <Link
              to="/coins"
              className="mt-4 flex items-center gap-1.5 text-[10.5px] text-white/30 hover:text-white/60"
            >
              <ExternalLink className="h-3 w-3" /> How the fee split works
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
function OnchainSteps({ onchain, connected, accountId, founderHint, signIn, doCreate, doLaunch, doComplete }) {
  if (!connected) {
    return (
      <button
        type="button"
        onClick={signIn}
        className="mt-6 w-full rounded-2xl border border-brand/30 bg-brand/[0.07] py-3 text-[13px] font-semibold text-brand transition-colors hover:bg-brand/[0.12]"
      >
        Connect founder wallet to sign on-chain
      </button>
    );
  }
  const steps = [
    { id: 0, label: "Sign create_product", note: "0.05 NEAR storage · registers the product", run: doCreate },
    { id: 1, label: "Sign launch_coin", note: "Exact launch cost · deploys the token", run: doLaunch },
    { id: 2, label: "Finish with complete_launch", note: "No deposit · opens the curve", run: doComplete },
  ];
  return (
    <div className="mt-6 space-y-2 text-left">
      <p className="text-[10px] uppercase tracking-[0.16em] text-white/30">
        Signing as <span className="num text-white/60">{accountId}</span>
        {founderHint && founderHint !== accountId && (
          <span className="text-amber-300"> · draft said {founderHint} — this account becomes founder</span>
        )}
      </p>
      {steps.map((s) => {
        const done = onchain.step > s.id;
        const current = onchain.step === s.id && !onchain.done;
        return (
          <button
            key={s.id}
            type="button"
            disabled={!current || !!onchain.busy}
            onClick={s.run}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed",
              done
                ? "border-brand/25 bg-brand/[0.06]"
                : current
                  ? "border-white/15 bg-white/[0.03] hover:border-brand/40"
                  : "border-white/[0.07] opacity-40"
            )}
          >
            <span>
              <span className="flex items-center gap-2 text-[13px] font-semibold text-white">
                {done && <Check className="h-3.5 w-3.5 text-brand" strokeWidth={3} />}
                {s.id + 1} · {s.label}
              </span>
              <span className="mt-0.5 block text-[11px] text-white/35">{s.note}</span>
            </span>
            <span className="num shrink-0 text-[11px] text-white/40">
              {done ? "done" : onchain.busy ? "…" : current ? "sign →" : "waiting"}
            </span>
          </button>
        );
      })}
      {onchain.done && onchain.pid && (
        <Link
          to="/products/$productId"
          params={{ productId: String(onchain.pid) }}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3 text-[13px] font-semibold text-black transition hover:brightness-105"
        >
          <Rocket className="h-4 w-4" /> Open your live product #{onchain.pid}
        </Link>
      )}
    </div>
  );
}
