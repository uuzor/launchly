# Launchly agent service (`agents/`)

Post quality scoring over the Vercel AI SDK + Meta Meta Muse API, with a
deterministic mock fallback. The agent proposes a 0–10 quality bonus
only — post VALIDITY (link/tag/age/dupe/cap/liveness) is decided by
the Python rules engine in `intents/verifier.py`, never here.

## Setup

```bash
cd agents
npm install
cp .env.example .env   # set MODEL_API_KEY (never commit .env)
node src/server.js     # serves 127.0.0.1:8091
```

No key = mock mode (`fixture-v1`, `mock:true`): every endpoint works
from a clean clone. The service also reads `../intents/.env`, so a key
already there is picked up with no extra config.

`MODEL_API_KEY` is a Meta Model API key (Bearer [REDACTED] It is passed
only to the model provider — never logged, never returned by any
endpoint, never sent anywhere except the configured base URL
(default `https://api.meta.ai/v1`, model `muse-spark-1.3`, per
[Meta's quickstart](https://dev.meta.ai/docs/quickstart)).

## API

```text
GET  /health                    -> {ok, model, mock}
POST /score                     -> {bonus 0..10, reason, model, mock, fallback}
POST /score-batch {items, concurrency?} -> {results:[{index, ...score}]}
POST /chat {product_id, message, history?} -> {reply, tools_used, ...}
GET  /memory?product_id=        -> {facts, updated_at, quarantined}
POST /memory/clear              -> operator-gated memory wipe
```

## Product chat (read-only, injection-gated)

`POST /chat` answers user questions from live chain views
(`getProduct`, `getCyclePosts`, `getPool`, `getVault` via NEAR RPC)
plus per-product memory (`data/product-{id}.json`, 20 facts max).
Mock mode answers from real tool data with canned phrasing.

Execution is impossible by construction: the registry holds
read-only tools only (asserted in tests), and three gate layers back
it up — `scanInput` fails closed on override/role-hijack/tool-smuggle/
chain-command patterns (legit questions like "how do withdrawals
work?" pass), stored facts are quarantined on read, and replies are
stripped of tool-shaped blocks. If asked to act, the model refuses
and points at the wallet/UI path.

Batch items are scored concurrently (default 4, max 8), capped at 50
per call. Bodies capped at 256 KB.

## The loop (`src/loop.js`)

1. **Evidence pass** — `generateText` with a read-only `textStats` tool
   (chars/words/diversity/links/tags), max 3 steps.
2. **Structured score** — `generateObject` against `{bonus, confidence,
   reason}`. Strict prompt: substance over hype, most posts 3–6.
3. **Revise pass (conditional)** — one extra call when confidence < 0.5.

Anything throws, times out (`AGENT_TIMEOUT_MS`), or returns a bad
shape → deterministic fixture fallback labeled `fallback:true`. The
Python caller clamps again and treats an unreachable agent as +0.

## Trust boundaries

- The model never decides validity, never picks a contract call, never
  holds a chain key. It writes one number + one sentence.
- Post content is untrusted input; the tool it can call is read-only
  arithmetic over that same content (no fetching, no side effects).
- Score math stays chain-compatible: rules score + bonus, capped at
  100 (`u8`).

## Tests

```bash
cd agents && npm test         # hermetic unit suite (mocked model + tools)
cd agents && npm run test:live  # LIVE_TESTS=1: real server + real Muse
                                # model + real testnet RPC (costs money)
```

The live suite asserts `mock:false, fallback:false` on score/chat/batch,
checks chat answers from real chain data (`VG5`), verifies memory
persistence, and re-checks the injection gate. Model-dependent tests
retry once: real breakage fails twice, transient flakes pass on retry.
