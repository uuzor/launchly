import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixtureScore } from "../src/fixture.js";

const PRODUCT = { name: "Widget", symbol: "WDG", tagline: "does things" };

describe("fixture", () => {
  it("stays in 0..10 and is deterministic", () => {
    const a = fixtureScore("I tried Widget and the onboarding flow is smooth", PRODUCT);
    const b = fixtureScore("I tried Widget and the onboarding flow is smooth", PRODUCT);
    assert.deepEqual(a, b);
    assert.ok(a.bonus >= 0 && a.bonus <= 10);
    assert.equal(a.mock, true);
  });

  it("rewards substance over empty hype", () => {
    const rich = fixtureScore(
      "Widget WDG review: setup took five minutes, the export flow handles large files well, docs are clear", PRODUCT);
    const thin = fixtureScore("great project!", PRODUCT);
    assert.ok(rich.bonus > thin.bonus);
  });

  it("handles empty content without crashing", () => {
    const r = fixtureScore("", PRODUCT);
    assert.ok(r.bonus >= 0 && r.bonus <= 4);
  });
});
