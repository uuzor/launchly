// Read-only NEAR RPC views exposed as chat tools. This module performs
// zero writes by construction: it only calls `query/call_function`.
// The chat registry MUST only ever contain tools from here (plus the
// pure textStats helper) -- test/chat.test.js asserts that invariant.
import { tool } from "ai";
import { z } from "zod";

const pid = z.number().int().positive().max(1e9);

async function rpcView(rpcUrl, contractId, method, args, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "launchly-chat", method: "query",
        params: {
          request_type: "call_function", finality: "final",
          account_id: contractId, method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
      signal: ctrl.signal,
    });
    const body = await res.json();
    if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error).slice(0, 200)}`);
    const raw = Buffer.from(body.result.result).toString("utf8");
    return raw ? JSON.parse(raw) : null;
  } finally {
    clearTimeout(t);
  }
}

function trunc(obj, n = 2000) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}

export function chatTools({ rpcUrl, contractId }) {
  return {
    getProduct: tool({
      description: "Read a product's on-chain record: name, symbol, status, founder, curve state, cycle.",
      inputSchema: z.object({ product_id: pid }),
      execute: async ({ product_id }) =>
        trunc(await rpcView(rpcUrl, contractId, "get_product", { product_id })),
    }),
    getCyclePosts: tool({
      description: "List a product's posts for a cycle with attested/approved/scores/liveness.",
      inputSchema: z.object({ product_id: pid, cycle_id: z.number().int().min(0).max(1e9) }),
      execute: async ({ product_id, cycle_id }) =>
        trunc(await rpcView(rpcUrl, contractId, "list_cycle_posts", { product_id, cycle_id }), 4000),
    }),
    getPool: tool({
      description: "Read a cycle pool: balance, finalized, total score, payout time.",
      inputSchema: z.object({ product_id: pid, cycle_id: z.number().int().min(0).max(1e9) }),
      execute: async ({ product_id, cycle_id }) =>
        trunc(await rpcView(rpcUrl, contractId, "get_pool", { product_id, cycle_id })),
    }),
    getVault: tool({
      description: "Read a product's vault position: principal, deployed, recall, busy.",
      inputSchema: z.object({ product_id: pid }),
      execute: async ({ product_id }) =>
        trunc(await rpcView(rpcUrl, contractId, "get_vault_position", { product_id })),
    }),
  };
}

// The complete set of tools the chat agent may ever receive. Anything not
// on this list is a bug -- the chat path must never gain an execution tool.
export const CHAT_TOOL_NAMES = ["getProduct", "getCyclePosts", "getPool", "getVault"];
