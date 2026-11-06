import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("is mock without a key", () => {
    assert.equal(loadConfig({}).mock, true);
    assert.equal(loadConfig({ MODEL_API_KEY: "  " }).mock, true);
  });

  it("uses researched Muse defaults, key alone enables live", () => {
    const c = loadConfig({ MODEL_API_KEY: "k" });
    assert.equal(c.mock, false);
    assert.equal(c.baseURL, "https://api.meta.ai/v1");
    assert.equal(c.modelId, "muse-spark-1.3");
    assert.equal(c.provider, "muse");
  });

  it("lets env override url and model", () => {
    const c = loadConfig({ MODEL_API_KEY: "k", MODEL_BASE_URL: "http://m/", MODEL_ID: "m1" });
    assert.equal(c.baseURL, "http://m");
    assert.equal(c.modelId, "m1");
  });
});
