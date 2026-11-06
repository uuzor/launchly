import { Info, ShieldCheck } from "lucide-react";
import { TextAreaField, TextField } from "@/components/launch/LaunchFields";

export default function LaunchStepRules({ form, set }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-xl border border-brand/20 bg-brand/[0.05] p-3.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        <p className="text-[11.5px] leading-relaxed text-white/50">
          These rules are hashed and anchored on-chain at launch. The verifier applies exactly what
          you publish here, and creators can read it before they post.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Required link"
          value={form.requiredLink}
          onChange={(v) => set("requiredLink", v)}
          placeholder="demo.vectorly.xyz"
          hint="Every post must contain this link."
        />
        <TextField
          label="Required tag"
          value={form.requiredTag}
          onChange={(v) => set("requiredTag", v)}
          placeholder="#VCTR"
          mono
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Minimum account age (days)"
          value={form.minAccountAgeDays}
          onChange={(v) => set("minAccountAgeDays", v.replace(/[^0-9]/g, ""))}
          mono
          hint="7 days is the platform minimum."
        />
        <TextField
          label="Counted posts per creator"
          value={form.maxPosts}
          onChange={(v) => set("maxPosts", v.replace(/[^0-9]/g, ""))}
          mono
          hint="Must match the on-chain cap."
        />
      </div>

      <TextAreaField
        label="Not allowed in posts"
        value={form.banned}
        onChange={(v) => set("banned", v)}
        placeholder="Price predictions, private screenshots, reposted threads."
        maxLength={500}
        rows={3}
      />

      <div className="rounded-xl border border-white/[0.08] p-3.5">
        <div className="flex items-center gap-2">
          <Info className="h-3.5 w-3.5 text-white/35" />
          <p className="text-[11.5px] text-white/55">Fixed by the contract, not editable here</p>
        </div>
        <ul className="mt-2.5 grid gap-1.5 text-[11px] text-white/35 sm:grid-cols-2">
          <li>Cycle length · 30 days live, minutes in demo</li>
          <li>Dispute window · 48 hours after cycle close</li>
          <li>Multiplier range · 0.5× to 1.5×</li>
          <li>Payout split · pro rata by cycle score</li>
        </ul>
      </div>
    </div>
  );
}