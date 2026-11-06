export function TextField({ label, hint, value, onChange, placeholder, maxLength, mono = false }) {
  return (
    <label className="block">
      <span className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.16em] text-white/35">{label}</span>
        {maxLength && (
          <span className="num text-[9.5px] text-white/20">
            {String(value).length}/{maxLength}
          </span>
        )}
      </span>
      <input
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1.5 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white placeholder:text-white/20 focus:border-brand/40 focus:outline-none ${
          mono ? "num" : ""
        }`}
      />
      {hint && <span className="mt-1 block text-[10px] text-white/25">{hint}</span>}
    </label>
  );
}

export function TextAreaField({ label, value, onChange, placeholder, maxLength, rows = 4 }) {
  return (
    <label className="block">
      <span className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.16em] text-white/35">{label}</span>
        {maxLength && (
          <span className="num text-[9.5px] text-white/20">
            {String(value).length}/{maxLength}
          </span>
        )}
      </span>
      <textarea
        value={value}
        rows={rows}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1.5 w-full resize-none rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[13px] leading-relaxed text-white placeholder:text-white/20 focus:border-brand/40 focus:outline-none"
      />
    </label>
  );
}

export function SelectField({ label, value, onChange, options, hint }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.16em] text-white/35">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white/85 focus:border-brand/40 focus:outline-none"
      >
        {options.map((opt) => (
          <option key={opt} value={opt} className="bg-[#111]">
            {opt}
          </option>
        ))}
      </select>
      {hint && <span className="mt-1 block text-[10px] text-white/25">{hint}</span>}
    </label>
  );
}