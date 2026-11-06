import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scorePost } from "../src/loop.js";

const INPUT = {
  content: "Widget review: setup was fast and export works well https://demo.example #WDG",
  product: { name: "Widget", symbol: "WDG", tagline: "does things" },
  rules: { required_link: "https://demo.example", required_tag: "#WDG" },
};
const LIVE = { apiKey: "test-key", baseURL: "http://model", modelId: "test-model", mock: false, timeoutMs: 5000 };

describe("loop", () => {
  it("uses the fixture when no key is configured", async () => {
    const r = await scorePost(INPUT, { config: { apiKey: "", mock: true } });
    assert.equal(r.mock, true);
    assert.equal(r.fallback, false);
    assert.ok(r.bonus >= 0 && r.bonus <= 10);
  });

  it("returns a clamped live score on the happy path", async () => {
    let reviseCalls = 0;
    const r = await scorePost(INPUT, {
      config: LIVE,
      model: "fake-model",
      generateText: async () => ({ text: "says specific things" }),
      generateObject: async (opts) => {
        reviseCalls++;
        assert.ok(opts.abortSignal, "timeout signal passed through");
        return { object: { bonus: 7, confidence: 0.9, reason: "specific and grounded" } };
      },
    });
    assert.equal(r.mock, false);
    assert.equal(r.fallback, false);
    assert.equal(r.bonus, 7);
    assert.equal(r.revised, false);
    assert.equal(reviseCalls, 1, "confident score skips the revise pass");
  });

  it("runs one revise pass when confidence is low", async () => {
    const seen = [];
    const r = await scorePost(INPUT, {
      config: LIVE,
      model: "fake-model",
      generateText: async () => ({ text: "unclear" }),
      generateObject: async (opts) => {
        seen.push(opts.prompt);
        return seen.length === 1
          ? { object: { bonus: 4, confidence: 0.2, reason: "unsure" } }
          : { object: { bonus: 5, confidence: 0.8, reason: "confirmed" } };
      },
    });
    assert.equal(seen.length, 2);
    assert.match(seen[1], /Reconsider/);
    assert.equal(r.bonus, 5);
    assert.equal(r.revised, true);
  });

  it("falls back to the fixture when the model throws", async () => {
    const r = await scorePost(INPUT, {
      config: LIVE,
      model: "fake-model",
      generateText: async () => { throw new Error("provider down"); },
      generateObject: async () => { throw new Error("unreachable"); },
    });
    assert.equal(r.mock, false);
    assert.equal(r.fallback, true);
    assert.ok(r.bonus >= 0 && r.bonus <= 10);
    assert.match(r.error, /provider down/);
  });
});
