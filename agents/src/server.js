// Local scoring service. Localhost only -- the key never leaves this box
// except to the configured model endpoint. Bodies capped, batch sizes capped.
import http from "node:http";
import { loadConfig } from "./config.js";
import { scorePost } from "./loop.js";
import { chat } from "./chat.js";
import { loadMemory, clearMemory } from "./memory.js";

export function createServer(config, scorer = scorePost) {
  return http.createServer((req, res) => {
    const send = (code, obj) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }
    const url = new URL(req.url || "/", "http://x");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(200, { ok: true, provider: config.provider || "muse",
                            model: config.modelId, mock: config.mock });
    }
    if (req.method === "GET" && url.pathname === "/memory") {
      const pid = parseInt(url.searchParams.get("product_id") || "", 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        return send(400, { error: "product_id (positive int) required" });
      }
      const mem = loadMemory(config.dataDir, pid);
      return send(200, { product_id: pid, facts: mem.facts,
                         updated_at: mem.updated_at,
                         quarantined: mem.quarantined });
    }
    if (req.method === "POST" && (url.pathname === "/score" || url.pathname === "/score-batch" || url.pathname === "/chat" || url.pathname === "/memory/clear")) {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > config.maxBodyBytes) { req.destroy(); }
        else chunks.push(c);
      });
      req.on("end", async () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send(400, { error: "invalid JSON body" });
        }
        try {
          if (url.pathname === "/score") {
            return send(200, await scorer(validateItem(body), { config }));
          }
          if (url.pathname === "/chat") {
            return send(200, await chat(body, { config }));
          }
          if (url.pathname === "/memory/clear") {
            const want = "Bearer " + (config.operatorToken || "\0none");
            if (!config.operatorToken || req.headers.authorization !== want) {
              return send(401, { error: "operator auth required" });
            }
            const pid = Number(body.product_id);
            if (!Number.isInteger(pid) || pid <= 0) {
              return send(400, { error: "product_id required" });
            }
            return send(200, { cleared: clearMemory(config.dataDir, pid) });
          }
          return send(200, { results: await scoreBatch(body, config, scorer) });
        } catch (err) {
          return send(err.status || 500, { error: String(err.message || err) });
        }
      });
      return;
    }
    send(404, { error: "no such route" });
  });
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function validateItem(item) {
  if (!item || typeof item.content !== "string" || !item.content.trim()) {
    throw bad("content (non-empty string) required");
  }
  if (item.content.length > 20000) throw bad("content too long (max 20000 chars)");
  return {
    content: item.content,
    product: item.product && typeof item.product === "object" ? item.product : {},
    rules: item.rules && typeof item.rules === "object" ? item.rules : {},
  };
}

async function scoreBatch(body, config, scorer) {
  const items = body && body.items;
  if (!Array.isArray(items) || !items.length) throw bad("items (non-empty array) required");
  if (items.length > config.maxItems) throw bad(`max ${config.maxItems} items per batch`);
  const clean = items.map(validateItem);
  const limit = Math.min(8, Math.max(1, body.concurrency || config.concurrency));
  const results = new Array(clean.length);
  let next = 0;
  const worker = async () => {
    while (next < clean.length) {
      const i = next++;
      results[i] = { index: i, ...(await scorer(clean[i], { config })) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, clean.length) }, worker));
  return results;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isMain) {
  const config = loadConfig();
  createServer(config).listen(config.port, "127.0.0.1", () => {
    console.log(`launchly agent on 127.0.0.1:${config.port} mock=${config.mock}`);
  });
}
