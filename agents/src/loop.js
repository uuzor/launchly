// Agent loop: evidence tool -> structured score -> optional revise pass.
// The model proposes a 0..10 quality bonus only; validity (link/tag/age/
// dupe/cap/liveness) is decided by the Python rules engine, never here.
// Any model failure falls back to the deterministic fixture scorer.
import { generateText, generateObject, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { fixtureScore } from "./fixture.js";

const ScoreSchema = z.object({
  bonus: z.number().int().min(0).max(10),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(280),
});

const textStats = tool({
  description: "Compute deterministic text statistics for the post content.",
  inputSchema: z.object({ content: z.string().max(20000) }),
  execute: async ({ content }) => {
    const words = content.split(/\s+/).filter(Boolean);
    return {
      chars: content.length,
      words: words.length,
      uniqueRatio: words.length
        ? new Set(words.map((w) => w.toLowerCase())).size / words.length : 0,
      linkCount: (content.match(/https?:\/\//g) || []).length,
      tagCount: (content.match(/#\w+/g) || []).length,
    };
  },
});

const SYSTEM = `You score creator posts for Launchly, a product-backed promo platform.
Score SUBSTANCE about the product: specific features, experience, insight.
Spam, generic hype ("great project!", "to the moon"), and off-topic text score low.
Return bonus 0-10 plus confidence 0-1. Be strict: most posts deserve 3-6.`;

export async function scorePost(input, deps = {}) {
  const { content, product = {}, rules = {} } = input;
  const config = deps.config || {};
  if (config.mock) return { ...fixtureScore(content, product), fallback: false };

  const genText = deps.generateText || generateText;
  const genObject = deps.generateObject || generateObject;
  const signal = AbortSignal.timeout(config.timeoutMs || 45000);
  const muse = deps.model || createOpenAICompatible({
    name: "muse",
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  })(config.modelId);

  try {
    const context =
      `Product: ${product.name || "?"} (${product.symbol || "?"}) -- ${product.tagline || ""}\n` +
      `Required link: ${rules.required_link || "(product demo url)"}\n` +
      `Required tag: ${rules.required_tag || "(none)"}\n` +
      `Post content:\n${content}`;
    // Temperature 0: scoring must be deterministic, not creative.
    // Repair hook: without response_format the model rarely emits bad
    // JSON; one repair attempt beats an instant fallback.
    const repairText = async ({ text, error }) => {
      const repaired = await genText({
        model: muse,
        system: "You repair invalid JSON. Reply with ONLY the corrected JSON object, no prose.",
        prompt: `This JSON failed to parse (${error.message}):\n\n${text}\n\n` +
          `Return ONLY the corrected object matching {"bonus": 0-10 int, ` +
          `"confidence": 0-1 number, "reason": short string}.`,
        temperature: 0,
        abortSignal: signal,
      });
      return repaired.text;
    };
    // Step 1: evidence gathering (read-only tool, model may call it or not).
    const gathered = await genText({
      model: muse,
      temperature: 0,
      system: SYSTEM,
      prompt: `Gather evidence for scoring. Call textStats once, then summarize ` +
        `in one line whether the post says anything specific about the product.\n\n${context}`,
      tools: { textStats },
      stopWhen: stepCountIs(3),
      abortSignal: signal,
    });
    // Step 2: structured score.
    const first = await genObject({
      model: muse,
      schema: ScoreSchema,
      system: SYSTEM,
      prompt: `Score this post.\n\nEvidence: ${gathered.text}\n\n${context}\n\n` +
        `ALL THREE FIELDS REQUIRED: bonus (int 0-10), confidence (0-1), ` +
        `reason (1-2 sentences on the post's substance, never empty).`,
      temperature: 0,
      experimental_repairText: repairText,
      abortSignal: signal,
    });
    let out = first.object;
    let revised = false;
    // Step 3 (conditional): one revise pass when unsure.
    if (out.confidence < 0.5) {
      const second = await genObject({
        model: muse,
        schema: ScoreSchema,
        system: SYSTEM,
        prompt: `Reconsider. Your first score was bonus=${out.bonus} ` +
          `confidence=${out.confidence} (${out.reason}). Either confirm with ` +
          `higher confidence or correct it. One attempt.\n\n${context}\n\n` +
          `ALL THREE FIELDS REQUIRED: bonus (int 0-10), confidence (0-1), ` +
          `reason (1-2 sentences, never empty).`,
        temperature: 0,
        experimental_repairText: repairText,
        abortSignal: signal,
      });
      out = second.object;
      revised = true;
    }
    return {
      bonus: Math.max(0, Math.min(10, Math.round(out.bonus))),
      reason: String(out.reason).slice(0, 280),
      confidence: out.confidence,
      revised,
      model: config.modelId,
      mock: false,
      fallback: false,
    };
  } catch (err) {
    return {
      ...fixtureScore(content, product),
      mock: false, // a real attempt was made
      fallback: true,
      error: String(err && err.message || err).slice(0, 200),
    };
  }
}
