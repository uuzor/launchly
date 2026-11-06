export function compactNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  return `${Math.round(n)}`;
}

export function usd(n, opts = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (opts.compact) return `$${compactNum(n)}`;
  const abs = Math.abs(n);
  const digits = abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function num(n, digits = 0) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function pct(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function shortAddr(a = "") {
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function toneFor(n) {
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-muted-foreground";
}

/** "23h 12m" until a nanosecond timestamp; null when passed/unknown. */
export function untilNs(ns) {
  if (ns === null || ns === undefined) return null;
  const ms = Number(ns) / 1e6 - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${mins % 60}m`;
  return `${mins}m`;
}