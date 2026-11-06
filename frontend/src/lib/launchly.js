// Live Launchly backend client. Replaces demo-data with chain-backed facts.
//
// Sources:
//   VITE_LAUNCHLY_API   -> Python backend (default http://localhost:8090)
//   VITE_LAUNCHLY_AGENT  -> verifier/chat agent (default http://localhost:8091)
// Chain is source of truth; anything the backend cannot prove is returned
// as null and the UI must render "—" (never a fabricated number).

import { useCallback, useEffect, useRef, useState } from "react";

export const API = import.meta.env.VITE_LAUNCHLY_API ?? "http://localhost:8090";
export const AGENT = import.meta.env.VITE_LAUNCHLY_AGENT ?? "http://localhost:8091";

// On-chain constants (contracts/launchly): 1B supply, 18-decimals token,
// 10% founder-locked, 90% on the bonding curve.
export const TOKEN_DECIMALS = 18;
const TOTAL_SUPPLY = 1_000_000_000;
const CURVE_SUPPLY = 900_000_000;

const GRADIENTS = [
  ["#c6f24e", "#2fbf71"],
  ["#7dd3fc", "#6366f1"],
  ["#fbbf24", "#f97316"],
  ["#f472b6", "#8b5cf6"],
  ["#a78bfa", "#22d3ee"],
  ["#34d399", "#0ea5e9"],
];

export function gradientFor(id) {
  const n = Number(String(id).replace(/\D/g, "") || 0);
  return GRADIENTS[n % GRADIENTS.length];
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body, token, base = API } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Edit-Token": token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error) || `request failed (${res.status})`);
  }
  return data;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function ageDays(ns) {
  if (!ns) return 0;
  return Math.max(0, Math.floor((Date.now() - Number(ns) / 1e6) / 86_400_000));
}

function timeAgo(ns) {
  if (!ns) return "—";
  const s = Math.max(0, Math.floor((Date.now() - Number(ns) / 1e6) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Map one /products feed item to the UI product card shape. */
export function mapProduct(item, tokenFacts = {}) {
  const c = item.chain ?? {};
  const md = item.metadata ?? {};
  const st = item.stats ?? {};
  const dec = Number(c.reserve_decimals ?? 6);
  const sold = num(c.curve_sold) / 10 ** TOKEN_DECIMALS;
  const reserve = num(c.curve_reserve) / 10 ** dec;
  const tpu = num(tokenFacts.tokens_per_unit);
  // tokens_per_unit = raw token units per 1.0 reserve, so price needs no
  // reserve-decimals scaling: 1 USDT buys tpu/1e18 tokens.
  const price = tpu > 0 ? 10 ** TOKEN_DECIMALS / tpu : null;
  const sparkTpu = (st.spark_tpu ?? []).map(Number).filter((t) => t > 0);
  const spark = sparkTpu.length >= 2 ? sparkTpu.map((t) => 10 ** TOKEN_DECIMALS / t) : null;
  const volumeBase = st.volume_24h_base != null ? num(st.volume_24h_base) : null;
  const feesBase = st.fees_24h_base != null ? num(st.fees_24h_base) : null;
  return {
    id: String(item.product_id),
    productId: item.product_id,
    name: c.name ?? md.name ?? `Product ${item.product_id}`,
    symbol: c.symbol ?? md.symbol ?? "???",
    tagline: md.tagline ?? (c.description ?? "").slice(0, 90),
    category: md.category ?? "Uncategorized",
    stage: c.status ?? item.status ?? "Unknown",
    tags: md.tags ?? [],
    description: md.description ?? c.description ?? "",
    problem: md.problem ?? "",
    demoUrl: c.demo_url || md.demo_url || "",
    websiteUrl: md.website_url || c.demo_url || "",
    repoUrl: md.repo_url || "",
    founder: { name: c.founder ?? item.founder ?? "", account: c.founder ?? item.founder ?? "" },
    tokenAccount: item.token_account ?? c.token_account ?? null,
    ageDays: ageDays(c.launched_at_ns),
    followers: null,
    price,
    change24h: st.change_24h_pct ?? null,
    marketCap: price == null ? null : price * TOTAL_SUPPLY,
    volume24h: volumeBase == null ? null : volumeBase / 10 ** dec,
    volumeEstimated: volumeBase != null,
    holders: null, // needs a holder indexer (v6 token counters); see roadmap
    curveProgress: Math.min(100, (sold / CURVE_SUPPLY) * 100),
    poolBalance: reserve,
    fees24h: feesBase == null ? null : feesBase / 10 ** dec,
    feesEstimated: feesBase != null,
    totalFees: null,
    creators: st.creators_count ?? null,
    postsCount: st.posts_count ?? null,
    gradient: gradientFor(item.product_id),
    spark, // keeper snapshots; detail chart appends via useChart
    rules: md.rules
      ? {
          requiredLink: md.rules.required_link ?? "",
          requiredTag: md.rules.required_tag ?? "",
          minAccountAgeDays: md.rules.min_account_age_days ?? 0,
          maxPosts: c.max_posts_per_creator ?? 0,
          cycleDays: Math.round(num(c.cycle_duration_ns) / 1e9 / 86400),
          banned: (md.rules.banned ?? []).join(", "),
        }
      : null,
    chain: c,
    metadataState: item.metadata_state,
  };
}

export function mapPost(entry, productId) {
  const p = entry.post ?? entry;
  return {
    id: `post-${p.post_id}`,
    postId: p.post_id,
    productId: String(productId),
    creator: p.creator ?? "",
    url: p.url ?? "",
    status: p.approved ? "approved" : "pending",
    rating: p.attested ? num(p.verifier_score) / 100 : 0,
    votes: 0,
    submitted: p.created_at_ns ? timeAgo(p.created_at_ns) : "—",
    raw: p,
  };
}

// Store row (title/description draft) + chain milestone (weights/finalized).
export function mapMilestone(row, chainEntry, productId) {
  let content = {};
  try {
    content = JSON.parse(row.content_json || "{}");
  } catch {
    content = {};
  }
  const m = chainEntry?.milestone ?? {};
  const idx = row.milestone_index ?? m.index ?? 0;
  const votingOpen = m.window_end_ns ? Number(m.window_end_ns) > Date.now() * 1e6 : false;
  return {
    id: `m-${row.id ?? idx}`,
    index: Number(idx),
    productId: String(productId),
    title: content.title ?? `Milestone ${Number(idx) + 1}`,
    description: content.description ?? "",
    evidence: [
      ...(m.evidence_url ? [m.evidence_url] : []),
      ...(m.evidence_hash || row.evidence_hash
        ? [`hash:${String(m.evidence_hash || row.evidence_hash).slice(0, 12)}…`]
        : []),
    ],
    status: m.finalized ? "approved" : (votingOpen ? "voting" : (row.status ?? "pending")),
    votesFor: num(m.approve_weight) / 10 ** TOKEN_DECIMALS,
    votesAgainst: num(m.reject_weight) / 10 ** TOKEN_DECIMALS,
    snapshotSupply: num(m.snapshot_circulating) / 10 ** TOKEN_DECIMALS,
    tranche: `Tranche ${Number(idx) + 1}`,
    tokens: 0,
    closes: m.finalized ? "Released" : (votingOpen ? "Voting open" : "—"),
    raw: { row, milestone: m },
  };
}

function useAsync(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(e);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, live: !error && data !== null };
}

/** Live product list. Falls back to null (caller renders demo data + SIMULATED). */
export function useLiveProducts() {
  const { data, error, loading } = useAsync(async () => {
    const [feed, tokens] = await Promise.all([
      api("/products"),
      api("/tokens").catch(() => ({ tokens: [] })),
    ]);
    const facts = {};
    for (const t of tokens.tokens ?? []) facts[t.product_id] = t;
    return (feed.products ?? []).map((p) => mapProduct(p, facts[p.product_id]));
  }, []);
  return { products: data, live: !error && data !== null, error, loading };
}

export function useLiveProduct(id) {
  const { data, error, loading } = useAsync(async () => {
    if (!id) return null;
    const item = await api(`/products/${id}`);
    let facts = {};
    try {
      const t = await api(`/tokens?product_id=${id}`);
      facts = (t.tokens ?? [])[0] ?? {};
    } catch {
      facts = {};
    }
    return mapProduct(item, facts);
  }, [id]);
  return { product: data, live: !error && data !== null, error, loading };
}

export function useChart(tokenAccount) {
  return useAsync(async () => {
    if (!tokenAccount) return null;
    const c = await api(`/tokens/${tokenAccount}/chart`);
    const dec = TOKEN_DECIMALS;
    return (c.points ?? []).map((p) => ({
      t: p.t,
      price: num(p.tokens_per_unit) > 0 ? 10 ** dec / num(p.tokens_per_unit) : null,
      reserve: num(p.reserve) / 1e6,
      sold: num(p.sold) / 10 ** dec,
    }));
  }, [tokenAccount]);
}

export function useQuote(productId, side, amount) {
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    if (!productId || !amount || num(amount) <= 0) {
      setQuote(null);
      return;
    }
    setLoading(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api(`/products/${productId}/quote?side=${side}&amount=${amount}`)
        .then((q) => {
          setQuote(q);
          setError(null);
        })
        .catch((e) => setError(e))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(timer.current);
  }, [productId, side, amount]);
  return { quote, error, loading };
}

export function usePosts(productId) {
  return useAsync(async () => {
    if (!productId) return null;
    const r = await api(`/products/${productId}/posts`);
    return (r.posts ?? []).map((p) => mapPost(p, productId));
  }, [productId]);
}

export function useMilestones(productId) {
  return useAsync(async () => {
    if (!productId) return null;
    const [ms, votes] = await Promise.all([
      api(`/products/${productId}/milestones`),
      api(`/products/${productId}/votes`).catch(() => ({ milestones: [] })),
    ]);
    const chainBy = {};
    for (const v of votes.milestones ?? []) {
      const idx = v.milestone?.index;
      if (idx !== undefined) chainBy[idx] = v;
    }
    const rows = ms.milestones ?? [];
    const mapped = rows.map((r) => mapMilestone(r, chainBy[r.milestone_index], productId));
    // Chain milestones without a store draft still render (title-less).
    for (const [idx, entry] of Object.entries(chainBy)) {
      if (!rows.some((r) => String(r.milestone_index) === String(idx))) {
        mapped.push(mapMilestone({ milestone_index: Number(idx) }, entry, productId));
      }
    }
    return mapped;
  }, [productId]);
}

export function useCreator(account, refreshKey = 0) {
  return useAsync(async () => {
    if (!account) return null;
    const [profile, posts, earnings] = await Promise.all([
      api(`/creators/${account}`),
      api(`/creators/${account}/posts`).catch(() => ({ posts: [] })),
      api(`/creators/${account}/earnings`).catch(() => ({ earnings: [] })),
    ]);
    const list = posts.posts ?? [];
    const pay = earnings.earnings ?? [];
    // Paid = verified claims only; pending = finalized but unclaimed.
    // (Open cycles have no on-chain payout yet, so they add 0.)
    let paid = 0;
    let pending = 0;
    for (const e of pay) {
      const v = num(e.payout) / 1e6;
      if (e.claimed) paid += v;
      else if (e.finalized) pending += v;
    }
    return {
      account,
      handle: `@${account.split(".")[0]}`,
      name: account.split(".")[0],
      qualified: list.length,
      rejected: 0,
      score: null,
      pending,
      paid,
      rating: null,
      followers: null,
      joined: null,
      focus: null,
      gradient: gradientFor(account.length * 7 + account.charCodeAt(0)),
      preference: {
        asset: profile.payout_asset ?? "USDT",
        chain: (profile.payout_chain ?? "near").toUpperCase(),
        address: profile.payout_address ?? account,
      },
      posts: list,
      earnings: pay,
    };
  }, [account, refreshKey]);
}

export function useCreatorDirectory() {
  // No registry endpoint: derive the creator set from every product's posts.
  return useAsync(async () => {
    const feed = await api("/products");
    const seen = new Map();
    await Promise.all(
      (feed.products ?? []).map(async (p) => {
        try {
          const r = await api(`/products/${p.product_id}/posts`);
          for (const entry of r.posts ?? []) {
            const post = entry.post ?? entry;
            if (!seen.has(post.creator)) {
              seen.set(post.creator, {
                account: post.creator,
                handle: `@${String(post.creator).split(".")[0]}`,
                name: String(post.creator).split(".")[0],
                qualified: 0,
                score: null,
                pending: null,
                paid: null,
                rating: null,
                gradient: gradientFor(String(post.creator).length),
              });
            }
            seen.get(post.creator).qualified += 1;
          }
        } catch {
          /* product without posts */
        }
      })
    );
    return [...seen.values()];
  }, []);
}

export function useVerifierQueue() {
  return useAsync(async () => {
    const r = await api("/verifier/posts");
    return r.posts ?? r.items ?? [];
  }, []);
}

export function useKeeperStatus() {
  return useAsync(() => api("/keeper/status"), []);
}

/** Chat with the per-product agent (real model, read-only tools, gated). */
export function useChat(productId) {
  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const send = useCallback(
    async (text) => {
      const user = { role: "user", text };
      setMessages((m) => [...m, user]);
      setSending(true);
      setError(null);
      try {
        const r = await api("/chat", {
          method: "POST",
          base: AGENT,
          body: { product_id: Number(productId), message: text },
        });
        setMessages((m) => [...m, { role: "agent", text: r.reply ?? r.text ?? "" }]);
      } catch (e) {
        setError(e);
      } finally {
        setSending(false);
      }
    },
    [productId]
  );
  return { messages, sending, error, send };
}

// Raw-bytes PUT for draft asset uploads (logo/screenshots).
export async function apiBytes(path, bytes, token) {
  const res = await fetch(`${API}${path}`, {
    method: "PUT",
    headers: { "X-Edit-Token": token, "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error) || `upload failed (${res.status})`);
  }
  return data;
}

// Founder draft flow (backend holds drafts until the founder signs on-chain).
export const drafts = {
  create: (founder_hint) => api("/products/drafts", { method: "POST", body: { founder_hint } }),
  get: (id, token) => api(`/products/drafts/${id}`, { token }),
  update: (id, token, metadata, rules) =>
    api(`/products/drafts/${id}`, { method: "PUT", token, body: { metadata, rules } }),
  finalize: (id, token) => api(`/products/drafts/${id}/finalize`, { method: "POST", token }),
  status: (id, token) => api(`/products/drafts/${id}/status`, { token }),
};

export function fmtUSD(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

export function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
}
