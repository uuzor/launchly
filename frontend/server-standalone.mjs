// Standalone production server for the built TanStack Start app.
// Usage: npm run build && node server-standalone.mjs
// Serves dist/client statically and routes everything else through the
// worker-style { fetch } handler in dist/server/index.js. No workerd needed.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import handler from "./dist/server/index.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT = new URL("./dist/client/", import.meta.url);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function serveStatic(pathname, res) {
  const rel = normalize(pathname).replace(/^\/+/, "");
  if (!rel || rel.startsWith("..")) return false;
  try {
    const body = await readFile(join(CLIENT.pathname, rel));
    res.writeHead(200, {
      "Content-Type": TYPES[extname(rel)] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && /\.[a-z0-9]+$/i.test(url.pathname)) {
      if (await serveStatic(url.pathname, res)) return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("standalone server error:", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`launchly web on http://${HOST}:${PORT}`);
});
