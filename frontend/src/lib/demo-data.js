// Launchly prototype data. Every number below is illustrative demo data —
// the product content is real UI, the market and social data is simulated.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spark(seed, base, changePct, length = 32) {
  const rnd = mulberry32(seed);
  const start = base / (1 + changePct / 100);
  const out = [];
  for (let i = 0; i < length; i += 1) {
    const t = i / (length - 1);
    const trend = start + (base - start) * t;
    const noise = (rnd() - 0.5) * base * 0.16 * (1 - t * 0.45);
    out.push(Math.max(base * 0.35, trend + noise));
  }
  return out;
}

function path(seed, base, volatility, length = 140) {
  const rnd = mulberry32(seed);
  let v = base;
  const out = [];
  for (let i = 0; i < length; i += 1) {
    v = Math.max(base * 0.2, v * (1 + (rnd() - 0.48) * volatility));
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

const LABELS = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 7) + i * 86400000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
});

export const feeSplit = { creators: 70, ops: 20, founder: 10 };
export const tokenomics = {
  supply: 1000000000,
  curve: 900000000,
  founderLocked: 100000000,
  feeBps: 1,
  tranches: 4,
};

export const products = [
  {
    id: "vectorly",
    name: "Vectorly",
    symbol: "VCTR",
    tagline: "Ship AI agents that run your back office.",
    category: "Developer Tools",
    stage: "Live",
    tags: ["Agents", "No-code", "Ops"],
    description:
      "Vectorly lets a two-person team stand up an agent that reads invoices, reconciles them against the ledger and writes the journal entry. Agents run inside your own workspace, every action is logged and reversible, and nothing is sent to a shared model history.",
    problem:
      "Small teams spend their evenings on reconciliation, invoice chasing and data entry because the tools they can afford stop at the dashboard.",
    demoUrl: "https://demo.vectorly.xyz",
    websiteUrl: "https://vectorly.xyz",
    repoUrl: "https://github.com/vectorly/vectorly",
    founder: { name: "Ada Rehn", account: "ada.near" },
    ageDays: 12,
    followers: 1840,
    price: 0.04125,
    change24h: 12.4,
    marketCap: 1240000,
    volume24h: 218400,
    holders: 1284,
    curveProgress: 63,
    poolBalance: 18420.55,
    fees24h: 2184.0,
    totalFees: 14620.8,
    creators: 24,
    postsCount: 68,
    gradient: ["#c6f24e", "#2fbf71"],
    spark: spark(11, 0.04125, 12.4),
    rules: {
      requiredLink: "demo.vectorly.xyz",
      requiredTag: "#VCTR",
      minAccountAgeDays: 7,
      maxPosts: 4,
      cycleDays: 30,
      banned: "No price predictions, no screenshots of private dashboards, no reposted threads.",
    },
  },
  {
    id: "hyperlens",
    name: "Hyperlens",
    symbol: "HYPR",
    tagline: "Product analytics that answers in one sentence.",
    category: "Analytics",
    stage: "Building",
    tags: ["Analytics", "LLM", "B2B"],
    description:
      "Ask Hyperlens why activation dropped and get a paragraph with the three funnels that moved, the cohorts behind them and the query it ran. Every answer links back to the saved segment so you can check the work.",
    problem:
      "Dashboards show graphs but nobody has time to read them. Teams need an analyst, but a good one costs more than the whole tool budget.",
    demoUrl: "https://try.hyperlens.so",
    websiteUrl: "https://hyperlens.so",
    repoUrl: "https://github.com/hyperlens/hyperlens",
    founder: { name: "Iker Sala", account: "iker.near" },
    ageDays: 7,
    followers: 960,
    price: 0.00874,
    change24h: 6.1,
    marketCap: 612000,
    volume24h: 84600,
    holders: 742,
    curveProgress: 41,
    poolBalance: 9312.4,
    fees24h: 846.0,
    totalFees: 6120.4,
    creators: 16,
    postsCount: 39,
    gradient: ["#7dd3fc", "#6366f1"],
    spark: spark(23, 0.00874, 6.1),
    rules: {
      requiredLink: "try.hyperlens.so",
      requiredTag: "#HYPR",
      minAccountAgeDays: 7,
      maxPosts: 4,
      cycleDays: 30,
      banned: "No fabricated screenshots, no competitor bashing.",
    },
  },
  {
    id: "kernel",
    name: "Kernel",
    symbol: "KRNL",
    tagline: "One runtime for every model you ship.",
    category: "Infrastructure",
    stage: "Live",
    tags: ["Infra", "Inference", "Open source"],
    description:
      "Kernel routes every request to the cheapest model that passes your quality bar, with automatic fallbacks when a provider degrades. One endpoint, one bill, per-request traces you can replay.",
    problem:
      "Teams wire three providers by hand, then discover their costs and failure modes only in production.",
    demoUrl: "https://demo.kernel.run",
    websiteUrl: "https://kernel.run",
    repoUrl: "https://github.com/kernel-run/kernel",
    founder: { name: "Tomas Brix", account: "tomas.near" },
    ageDays: 21,
    followers: 2410,
    price: 0.1124,
    change24h: -3.4,
    marketCap: 2860000,
    volume24h: 412800,
    holders: 2104,
    curveProgress: 88,
    poolBalance: 34280.1,
    fees24h: 4128.0,
    totalFees: 38120.2,
    creators: 31,
    postsCount: 104,
    gradient: ["#fbbf24", "#f97316"],
    spark: spark(37, 0.1124, -3.4),
    rules: {
      requiredLink: "demo.kernel.run",
      requiredTag: "#KRNL",
      minAccountAgeDays: 14,
      maxPosts: 3,
      cycleDays: 30,
      banned: "No benchmark claims without a public notebook link.",
    },
  },
  {
    id: "driftpay",
    name: "Driftpay",
    symbol: "DRIFT",
    tagline: "Cross-chain payroll for remote teams.",
    category: "Fintech",
    stage: "Live",
    tags: ["Payments", "Intents", "Payroll"],
    description:
      "Pay a team across nine chains from one balance. Driftpay quotes the route, settles in the asset your contractor asked for and keeps a receipt trail that finance can actually use.",
    problem:
      "Remote teams lose days and a slice of every payout to bridging, and contractors hate being paid in a token they have to swap themselves.",
    demoUrl: "https://app.driftpay.money",
    websiteUrl: "https://driftpay.money",
    repoUrl: "https://github.com/driftpay/driftpay",
    founder: { name: "Nadia Okafor", account: "nadia.near" },
    ageDays: 4,
    followers: 620,
    price: 0.02347,
    change24h: 28.9,
    marketCap: 486000,
    volume24h: 96400,
    holders: 486,
    curveProgress: 27,
    poolBalance: 6284.75,
    fees24h: 964.0,
    totalFees: 2814.2,
    creators: 11,
    postsCount: 26,
    gradient: ["#f472b6", "#8b5cf6"],
    spark: spark(53, 0.02347, 28.9),
    rules: {
      requiredLink: "app.driftpay.money",
      requiredTag: "#DRIFT",
      minAccountAgeDays: 7,
      maxPosts: 5,
      cycleDays: 30,
      banned: "No referral links, no payment-amount claims.",
    },
  },
  {
    id: "orbitkit",
    name: "Orbitkit",
    symbol: "ORBT",
    tagline: "Design systems that ship themselves.",
    category: "Design",
    stage: "Building",
    tags: ["Design", "Components", "Figma"],
    description:
      "Orbitkit turns a Figma library into a typed component package, keeps the tokens in sync and opens a pull request when a token changes. Designers stop hand-maintaining a second system in code.",
    problem:
      "Every design system drifts the moment it reaches code, and nobody owns the reconciliation.",
    demoUrl: "https://orbitkit.design/demo",
    websiteUrl: "https://orbitkit.design",
    repoUrl: "https://github.com/orbitkit/orbitkit",
    founder: { name: "Lena Márquez", account: "lena.near" },
    ageDays: 9,
    followers: 780,
    price: 0.00613,
    change24h: 2.2,
    marketCap: 214000,
    volume24h: 38200,
    holders: 318,
    curveProgress: 34,
    poolBalance: 4128.9,
    fees24h: 382.0,
    totalFees: 1642.6,
    creators: 9,
    postsCount: 18,
    gradient: ["#a78bfa", "#22d3ee"],
    spark: spark(71, 0.00613, 2.2),
    rules: {
      requiredLink: "orbitkit.design/demo",
      requiredTag: "#ORBT",
      minAccountAgeDays: 7,
      maxPosts: 4,
      cycleDays: 30,
      banned: "No reposting the founder's launch thread.",
    },
  },
  {
    id: "loomgraph",
    name: "Loomgraph",
    symbol: "LOOM",
    tagline: "The graph layer for your data warehouse.",
    category: "Data",
    stage: "Live",
    tags: ["Data", "Graph", "SQL"],
    description:
      "Point Loomgraph at your warehouse and it infers the entity graph, then answers relationship questions in SQL you can keep. No ETL job to babysit, no new store to operate.",
    problem:
      "Answering a simple 'how are these two things connected' question means a week of modelling work.",
    demoUrl: "https://loomgraph.dev/play",
    websiteUrl: "https://loomgraph.dev",
    repoUrl: "https://github.com/loomgraph/loomgraph",
    founder: { name: "Sam Oduya", account: "sam.near" },
    ageDays: 16,
    followers: 1130,
    price: 0.05432,
    change24h: -1.8,
    marketCap: 908000,
    volume24h: 142600,
    holders: 902,
    curveProgress: 52,
    poolBalance: 11280.3,
    fees24h: 1426.0,
    totalFees: 9840.5,
    creators: 19,
    postsCount: 54,
    gradient: ["#34d399", "#0ea5e9"],
    spark: spark(89, 0.05432, -1.8),
    rules: {
      requiredLink: "loomgraph.dev/play",
      requiredTag: "#LOOM",
      minAccountAgeDays: 7,
      maxPosts: 4,
      cycleDays: 30,
      banned: "No customer names in posts without written permission.",
    },
  },
];

export const creators = [
  {
    account: "nova.near",
    handle: "@novabuilds",
    name: "Nova",
    qualified: 18,
    rejected: 2,
    score: 16.4,
    pending: 412.8,
    paid: 2840.5,
    rating: 1.24,
    followers: "12.4k",
    joined: "Mar 2026",
    focus: "Dev tools",
    gradient: ["#c6f24e", "#2fbf71"],
    preference: { asset: "USDT", chain: "NEAR", address: "nova.near" },
  },
  {
    account: "kaito.near",
    handle: "@kaito_dev",
    name: "Kaito",
    qualified: 15,
    rejected: 1,
    score: 14.1,
    pending: 348.2,
    paid: 2110.0,
    rating: 1.18,
    followers: "8.9k",
    joined: "Jan 2026",
    focus: "Infra",
    gradient: ["#7dd3fc", "#6366f1"],
    preference: { asset: "NEAR", chain: "NEAR", address: "kaito.near" },
  },
  {
    account: "mira.near",
    handle: "@miraonchain",
    name: "Mira",
    qualified: 13,
    rejected: 0,
    score: 13.9,
    pending: 324.6,
    paid: 1980.4,
    rating: 1.32,
    followers: "21.2k",
    joined: "Feb 2026",
    focus: "Fintech",
    gradient: ["#f472b6", "#8b5cf6"],
    preference: { asset: "USDC", chain: "Base", address: "0x8f2c…91ad" },
  },
  {
    account: "solrunner.near",
    handle: "@solrunner",
    name: "Sol",
    qualified: 11,
    rejected: 3,
    score: 9.2,
    pending: 196.4,
    paid: 1420.8,
    rating: 1.02,
    followers: "5.1k",
    joined: "Apr 2026",
    focus: "Analytics",
    gradient: ["#fbbf24", "#f97316"],
    preference: { asset: "USDT", chain: "Arbitrum", address: "0x4a91…b7f2" },
  },
  {
    account: "tess.near",
    handle: "@tessships",
    name: "Tess",
    qualified: 9,
    rejected: 0,
    score: 9.8,
    pending: 148.0,
    paid: 890.2,
    rating: 1.28,
    followers: "3.8k",
    joined: "May 2026",
    focus: "Design",
    gradient: ["#a78bfa", "#22d3ee"],
    preference: { asset: "USDT", chain: "NEAR", address: "tess.near" },
  },
  {
    account: "degenphys.near",
    handle: "@degenphysics",
    name: "Degen",
    qualified: 8,
    rejected: 4,
    score: 6.1,
    pending: 84.2,
    paid: 612.4,
    rating: 0.88,
    followers: "2.2k",
    joined: "Jun 2026",
    focus: "Data",
    gradient: ["#34d399", "#0ea5e9"],
    preference: { asset: "USDT", chain: "NEAR", address: "degenphys.near" },
  },
];

export const posts = [
  { id: "post-1", productId: "vectorly", creator: "nova.near", url: "x.com/novabuilds/status/1846…", status: "approved", rating: 1.28, votes: 214, submitted: "2h ago" },
  { id: "post-2", productId: "vectorly", creator: "kaito.near", url: "x.com/kaito_dev/status/1844…", status: "approved", rating: 1.16, votes: 168, submitted: "5h ago" },
  { id: "post-3", productId: "vectorly", creator: "mira.near", url: "x.com/miraonchain/status/1841…", status: "approved", rating: 1.34, votes: 302, submitted: "8h ago" },
  { id: "post-4", productId: "vectorly", creator: "degenphys.near", url: "x.com/degenphysics/status/1838…", status: "held", rating: 0, votes: 0, submitted: "11h ago" },
  { id: "post-5", productId: "hyperlens", creator: "solrunner.near", url: "x.com/solrunner/status/1833…", status: "approved", rating: 1.04, votes: 96, submitted: "1d ago" },
  { id: "post-6", productId: "hyperlens", creator: "tess.near", url: "x.com/tessships/status/1831…", status: "pending", rating: 0, votes: 0, submitted: "1d ago" },
  { id: "post-7", productId: "kernel", creator: "kaito.near", url: "x.com/kaito_dev/status/1828…", status: "approved", rating: 1.22, votes: 410, submitted: "2d ago" },
  { id: "post-8", productId: "kernel", creator: "nova.near", url: "x.com/novabuilds/status/1826…", status: "approved", rating: 1.3, votes: 388, submitted: "2d ago" },
  { id: "post-9", productId: "driftpay", creator: "mira.near", url: "x.com/miraonchain/status/1822…", status: "approved", rating: 1.38, votes: 274, submitted: "3d ago" },
  { id: "post-10", productId: "orbitkit", creator: "tess.near", url: "x.com/tessships/status/1818…", status: "approved", rating: 1.24, votes: 142, submitted: "3d ago" },
  { id: "post-11", productId: "loomgraph", creator: "solrunner.near", url: "x.com/solrunner/status/1814…", status: "rejected", rating: 0, votes: 0, submitted: "4d ago" },
  { id: "post-12", productId: "loomgraph", creator: "degenphys.near", url: "x.com/degenphysics/status/1811…", status: "approved", rating: 0.94, votes: 118, submitted: "4d ago" },
];

export const milestones = [
  {
    id: "m-1",
    productId: "vectorly",
    title: "Live agent runtime + 1,000 workspaces",
    description:
      "Agent runtime is live for all workspaces, with replayable action logs and a rollback for every write. 1,042 workspaces created, 61% weekly active.",
    evidence: ["demo.vectorly.xyz/runtime", "github.com/vectorly/release-0.4"],
    status: "voting",
    votesFor: 62,
    votesAgainst: 18,
    snapshotSupply: 100,
    tranche: "Tranche 2 of 4",
    tokens: 25000000,
    closes: "18h left",
  },
  {
    id: "m-2",
    productId: "vectorly",
    title: "Invoice reconciliation template",
    description: "First published template, used by 210 workspaces in the first month.",
    evidence: ["demo.vectorly.xyz/templates/invoices"],
    status: "approved",
    votesFor: 78,
    votesAgainst: 6,
    snapshotSupply: 100,
    tranche: "Tranche 1 of 4",
    tokens: 25000000,
    closes: "Released",
  },
  {
    id: "m-3",
    productId: "kernel",
    title: "Routing engine v2 with fallback traces",
    description: "All requests now carry a trace with the provider decision and the fallback path.",
    evidence: ["demo.kernel.run/traces", "github.com/kernel-run/kernel/pull/212"],
    status: "voting",
    votesFor: 41,
    votesAgainst: 22,
    snapshotSupply: 100,
    tranche: "Tranche 3 of 4",
    tokens: 25000000,
    closes: "2d left",
  },
  {
    id: "m-4",
    productId: "hyperlens",
    title: "Cohort answers with saved segments",
    description: "Answers now cite the saved segment and the SQL used, so results can be checked.",
    evidence: ["try.hyperlens.so/changelog"],
    status: "rejected",
    votesFor: 34,
    votesAgainst: 44,
    snapshotSupply: 100,
    tranche: "Tranche 1 of 4",
    tokens: 25000000,
    closes: "Rejected",
  },
];

export const recentTrades = [
  { id: "t-1", symbol: "VCTR", side: "BUY", price: 0.04122, size: 24800, fee: 10.21, pool: 7.15, time: "23:01:28" },
  { id: "t-2", symbol: "VCTR", side: "SELL", price: 0.04108, size: 12400, fee: 5.09, pool: 3.56, time: "22:58:02" },
  { id: "t-3", symbol: "KRNL", side: "BUY", price: 0.11204, size: 8620, fee: 9.66, pool: 6.76, time: "22:51:44" },
  { id: "t-4", symbol: "DRIFT", side: "BUY", price: 0.02312, size: 41000, fee: 9.48, pool: 6.64, time: "22:44:19" },
  { id: "t-5", symbol: "LOOM", side: "SELL", price: 0.05428, size: 6100, fee: 3.31, pool: 2.32, time: "22:38:57" },
  { id: "t-6", symbol: "HYPR", side: "BUY", price: 0.00871, size: 92000, fee: 8.01, pool: 5.61, time: "22:31:12" },
  { id: "t-7", symbol: "VCTR", side: "BUY", price: 0.04096, size: 15600, fee: 6.39, pool: 4.47, time: "22:24:38" },
  { id: "t-8", symbol: "ORBT", side: "SELL", price: 0.00608, size: 148000, fee: 9.0, pool: 6.3, time: "22:17:05" },
];

export const payoutHistory = [
  { id: "p-1", creator: "mira.near", cycle: "Cycle 3 · Vectorly", score: 13.9, amount: 486.2, asset: "USDC on Base", via: "Intents", time: "3d ago" },
  { id: "p-2", creator: "nova.near", cycle: "Cycle 3 · Vectorly", score: 16.4, amount: 573.8, asset: "USDT on NEAR", via: "Direct", time: "3d ago" },
  { id: "p-3", creator: "kaito.near", cycle: "Cycle 2 · Kernel", score: 14.1, amount: 512.4, asset: "NEAR on NEAR", via: "Intents", time: "9d ago" },
  { id: "p-4", creator: "tess.near", cycle: "Cycle 2 · Orbitkit", score: 9.8, amount: 284.0, asset: "USDT on NEAR", via: "Direct", time: "9d ago" },
  { id: "p-5", creator: "solrunner.near", cycle: "Cycle 1 · Hyperlens", score: 11.2, amount: 318.6, asset: "USDT on Arbitrum", via: "Intents", time: "16d ago" },
];

export const feeInflow = LABELS.map((label, i) => {
  const rnd = mulberry32(1000 + i);
  const base = 420 + i * 26;
  return {
    label,
    fees: Math.round(base + rnd() * 260),
    pool: Math.round((base + rnd() * 260) * 0.7),
    yield: Number((18 + rnd() * 14 + i * 0.9).toFixed(2)),
  };
});

export const poolComposition = [
  { name: "Creator pool", value: 70, fill: "hsl(var(--brand))" },
  { name: "Platform ops", value: 20, fill: "#6366f1" },
  { name: "Founder fee", value: 10, fill: "#f59e0b" },
];

export const pricePath = {
  "1H": path(7, 0.0405, 0.012, 60),
  "4H": path(9, 0.0388, 0.02, 90),
  "1D": path(13, 0.0362, 0.03, 120),
  ALL: path(17, 0.0112, 0.045, 160),
};

export const protocolTiers = [
  {
    name: "Fairlaunch",
    lead: "Open, permissionless, and transparent.",
    body: "The most accessible path into Internet Capital Markets. Anyone can list a product and let the curve price it.",
    tone: "light",
  },
  {
    name: "Ignition",
    lead: "For MVP or early-market teams.",
    body: "Coordinated raise with validated traction, plus a reviewed campaign budget before the first cycle opens.",
    tone: "dark",
  },
  {
    name: "Gated",
    lead: "Exclusive entry for proven teams.",
    body: "Compliance-aligned, performance-verified, structured allocation with milestone-gated unlocks.",
    tone: "brand",
  },
];

export const loopSteps = [
  { step: "01", title: "Launch", body: "A founder lists the product and launches its coin. The founder allocation is locked in the contract.", icon: "Rocket" },
  { step: "02", title: "Trade", body: "Buyers and sellers trade on the bonding curve. Every trade pays a fixed 1% fee, or pay in from another chain with Intents.", icon: "CandlestickChart" },
  { step: "03", title: "Fund", body: "The fee splits on-chain: 70% to the promotional pool, 20% operations, 10% to the founder.", icon: "PiggyBank" },
  { step: "04", title: "Promote", body: "Creators post about the product and submit links. A verifier checks each post against the published rules.", icon: "Megaphone" },
  { step: "05", title: "Pay & unlock", body: "The pool pays creators pro rata by score. Holder-approved milestones release founder tranches.", icon: "BadgeCheck" },
];

export const partners = [
  "NEAR",
  "NEAR Intents",
  "Sputnik DAO",
  "Aurora",
  "Ref Finance",
  "Burrow",
  "Mintbase",
  "Tonic",
  "Meta Pool",
  "HERE Wallet",
  "Calimero",
  "Pagoda",
];

export const activity = [
  { id: "a-1", kind: "Trade", text: "0x7f2c…c21a bought 24,800 VCTR", value: "+$10.21 fee", time: "1m" },
  { id: "a-2", kind: "Post", text: "nova.near submitted a post for Vectorly", value: "Approved", time: "6m" },
  { id: "a-3", kind: "Pool", text: "Creator pool credited from trade fees", value: "+$7.15", time: "9m" },
  { id: "a-4", kind: "Vote", text: "Holders voted on Kernel milestone", value: "41 for / 22 against", time: "22m" },
  { id: "a-5", kind: "Payout", text: "mira.near paid out via Intents", value: "$486.20", time: "1h" },
  { id: "a-6", kind: "Yield", text: "Simulated vault yield credited", value: "+$22.40", time: "2h" },
];

export function getProduct(id) {
  return products.find((p) => p.id === id);
}

export function getProductBySymbol(symbol) {
  return products.find((p) => p.symbol.toLowerCase() === String(symbol || "").toLowerCase());
}

export function getCreator(account) {
  return creators.find((c) => c.account === account);
}

export function postsForProduct(id) {
  return posts.filter((p) => p.productId === id);
}

export function milestonesForProduct(id) {
  return milestones.filter((m) => m.productId === id);
}

export const feed = products.map((p) => ({
  ...p,
  posts: postsForProduct(p.id).length,
  approvedPosts: postsForProduct(p.id).filter((post) => post.status === "approved").length,
}));