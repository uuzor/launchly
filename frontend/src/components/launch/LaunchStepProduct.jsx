import { SelectField, TextAreaField, TextField } from "@/components/launch/LaunchFields";

const categories = ["Developer Tools", "Analytics", "Infrastructure", "Fintech", "Design", "Data", "Other"];

export default function LaunchStepProduct({ form, set }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Product name"
          value={form.name}
          onChange={(v) => set("name", v)}
          placeholder="Vectorly"
          maxLength={60}
        />
        <TextField
          label="Ticker"
          value={form.symbol}
          onChange={(v) => set("symbol", v.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          placeholder="VCTR"
          maxLength={10}
          mono
          hint="A–Z and 0–9. Also becomes the required #tag."
        />
      </div>

      <TextField
        label="Tagline"
        value={form.tagline}
        onChange={(v) => set("tagline", v)}
        placeholder="Ship AI agents that run your back office."
        maxLength={120}
      />

      <TextAreaField
        label="Description"
        value={form.description}
        onChange={(v) => set("description", v)}
        placeholder="What it does, who it is for, and what makes it different."
        maxLength={2000}
        rows={5}
      />

      <TextAreaField
        label="Problem"
        value={form.problem}
        onChange={(v) => set("problem", v)}
        placeholder="The problem this product removes."
        maxLength={500}
        rows={3}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Category"
          value={form.category}
          onChange={(v) => set("category", v)}
          options={categories}
        />
        <TextField
          label="Demo link"
          value={form.demoUrl}
          onChange={(v) => set("demoUrl", v)}
          placeholder="https://demo.vectorly.xyz"
          hint="https only. This becomes the required product link in posts."
        />
      </div>

      <TextField
        label="Tags"
        value={form.tags}
        onChange={(v) => set("tags", v)}
        placeholder="Agents, No-code, Ops"
        hint="Up to five, comma separated."
      />
    </div>
  );
}