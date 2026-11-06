// Config: MODEL_API_KEY authenticates the Meta Muse API (OpenAI-compatible
// endpoint at MODEL_BASE_URL). The key is read here and passed only to the
// model provider -- it is never logged, returned, or sent anywhere else.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Own .env wins; the backend's intents/.env is the shared fallback.
dotenv.config({ path: path.join(here, "..", ".env") });
dotenv.config({ path: path.join(here, "..", "..", "intents", ".env") });

// Researched 2026-11-06 from Meta's own quickstart (dev.meta.ai/docs):
// base https://api.meta.ai/v1, Bearer $MODEL_API_KEY, model muse-spark-1.3.
export const MUSE_BASE_URL = "https://api.meta.ai/v1";
export const MUSE_MODEL_ID = "muse-spark-1.3";

export function loadConfig(env = process.env) {
  const apiKey = (env.MODEL_API_KEY || "").trim();
  const baseURL = (env.MODEL_BASE_URL || MUSE_BASE_URL).trim().replace(/\/+$/, "");
  const modelId = (env.MODEL_ID || MUSE_MODEL_ID).trim();
  return {
    apiKey,
    baseURL,
    provider: "muse",
    // Only the key gates live mode; URL/model have researched defaults.
    mock: !apiKey,
    modelId,
    dataDir: env.AGENT_DATA_DIR || path.join(here, "..", "data"),
    rpcUrl: env.NEAR_RPC || "https://rpc.testnet.fastnear.com",
    contractId: env.LAUNCHLY_CONTRACT || "",
    memoryUpdate: (env.AGENT_MEMORY_UPDATE || "on").toLowerCase() !== "off",
    operatorToken: env.OPERATOR_TOKEN || "",
    port: parseInt(env.AGENT_PORT || "8091", 10),
    concurrency: Math.min(8, Math.max(1, parseInt(env.AGENT_CONCURRENCY || "4", 10))),
    timeoutMs: parseInt(env.AGENT_TIMEOUT_MS || "45000", 10),
    maxItems: 50,
    maxBodyBytes: 256 * 1024,
  };
}
