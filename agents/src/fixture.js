// Deterministic no-key scorer. Used when MODEL_API_KEY is unset AND as the
// never-fail fallback when the model errors. Labeled mock:true / fallback:true
// so callers can surface exactly what produced the number.
export function fixtureScore(content, product = {}) {
  const text = String(content || "");
  const words = text.toLowerCase().split(/[^a-z0-9#]+/).filter(Boolean);
  const unique = new Set(words);
  const diversity = words.length ? unique.size / words.length : 0;

  const names = [product.name, product.symbol, product.tagline]
    .filter(Boolean).map((s) => String(s).toLowerCase());
  const mentions = names.filter((n) => n.length > 1 && text.toLowerCase().includes(n)).length;

  let bonus = 3; // base: a real post with any substance starts here
  bonus += diversity >= 0.7 ? 3 : diversity >= 0.5 ? 2 : diversity >= 0.3 ? 1 : 0;
  bonus += Math.min(2, mentions);
  bonus += text.length >= 280 ? 2 : text.length >= 140 ? 1 : 0;
  bonus = Math.max(0, Math.min(10, bonus));

  return {
    bonus,
    reason: `fixture-v1: ${words.length} words, diversity ${diversity.toFixed(2)}, ` +
      `${mentions} product mention(s)`,
    model: "fixture-v1",
    mock: true,
    fallback: false,
  };
}
