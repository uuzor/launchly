// Per-product memory: small file-backed fact store. Facts are UNTRUSTED
// data (anyone can chat): they are size-capped, quarantined on read via
// the gate, and always framed as data -- never instructions -- in prompts.
import fs from "node:fs";
import path from "node:path";
import { scanMemory } from "./gate.js";

export const MAX_FACTS = 20;
export const MAX_FACT_CHARS = 200;

export function memoryFile(dataDir, productId) {
  return path.join(dataDir, `product-${Number(productId)}.json`);
}

export function loadMemory(dataDir, productId) {
  let raw = { facts: [], updated_at: null };
  try {
    raw = JSON.parse(fs.readFileSync(memoryFile(dataDir, productId), "utf8"));
  } catch {
    return { facts: [], updated_at: null, quarantined: 0 };
  }
  const { clean, quarantined } = scanMemory(raw.facts || []);
  return { facts: clean.slice(0, MAX_FACTS), updated_at: raw.updated_at || null, quarantined };
}

export function saveMemory(dataDir, productId, facts) {
  fs.mkdirSync(dataDir, { recursive: true });
  const deduped = [];
  for (const f of facts || []) {
    const s = String(f).trim().slice(0, MAX_FACT_CHARS);
    if (s && !deduped.includes(s)) deduped.push(s);
    if (deduped.length >= MAX_FACTS) break;
  }
  const doc = { facts: deduped, updated_at: new Date().toISOString() };
  fs.writeFileSync(memoryFile(dataDir, productId), JSON.stringify(doc, null, 1));
  return doc;
}

export function addFacts(dataDir, productId, newFacts) {
  const cur = loadMemory(dataDir, productId);
  return saveMemory(dataDir, productId, [...cur.facts, ...(newFacts || [])]);
}

export function clearMemory(dataDir, productId) {
  try {
    fs.unlinkSync(memoryFile(dataDir, productId));
    return true;
  } catch {
    return false;
  }
}
