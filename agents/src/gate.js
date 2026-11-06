// Anti prompt-injection gate for user chat. Three checkpoints:
//
//  1. scanInput: fail closed on instruction-override attempts, role
//     hijacks, tool-call smuggling, and imperative chain-mutation
//     commands. Plain QUESTIONS about sensitive topics ("how do
//     withdrawals work?") must pass -- patterns require imperative
//     framing, not mere keywords.
//  2. scanMemory: stored product facts are untrusted data (memory
//     poisoning is a classic hole). Poisoned facts are quarantined on
//     read, never fed to the model.
//  3. sanitizeOutput: strips anything shaped like a tool invocation
//     from the reply before it reaches the user.
//
// This gate is defense in depth. The PRIMARY control is architectural:
// the chat registry contains read-only tools only, so even a fully
// jailbroken model has no execution primitive to reach for.

const INPUT_PATTERNS = [
  // Instruction override
  [/\bignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions|prompts?|rules?|constraints?)\b/i, "override"],
  [/\bdisregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions|prompts?|rules?)\b/i, "override"],
  [/\b(system|initial)\s+(prompt|instructions?)\b.{0,40}\b(ignore|reveal|show|print|output|forget|override)\b/i, "system-probe"],
  [/\b(reveal|show|print|output)\b.{0,40}\b(system|initial)\s+(prompt|instructions?)\b/i, "system-probe"],
  // Role hijack
  [/\byou\s+are\s+now\b/i, "role-hijack"],
  [/\bact\s+as\s+(if\s+you\s+(were|are)\s+)?(a\s+)?(different|new|unrestricted|jailbroken|evil)\b/i, "role-hijack"],
  [/\bjailbreak\b/i, "role-hijack"],
  [/\bdo\s+anything\s+now\b/i, "role-hijack"],
  [/\bdeveloper\s+mode\b/i, "role-hijack"],
  // Tool-call smuggling: fake blocks the model might "obey"
  [/```\s*tool\b/i, "tool-smuggle"],
  [/<\s*tool[-_ ]?call\b/i, "tool-smuggle"],
  [/\bfunction\s+call\s*[:{]/i, "tool-smuggle"],
  [/\bassistant\s+to\s*=/i, "tool-smuggle"],
  // Imperative chain mutation: ACTION verb + MUTATING target. Bare nouns
  // ("how do withdrawals work?") do not match -- an imperative is required.
  [/\b(execute|run|call|invoke|trigger|submit|broadcast|sign|do\s+it|go\s+ahead|just\s+do\s+it)\b[^.?!]{0,80}\b(attest|confirm_liveness|vault_|transfer|withdraw|claim|launch_coin|create_product|drain_pending|reconcile|flag)\b/i, "chain-command"],
  [/\b(attest|confirm_liveness|vault_rebalance|vault_withdraw|drain_pending)\b[^.?!]{0,40}\b(my|this|that|the)\s+(post|product|vault|pool|funds?)\b/i, "chain-command"],
  [/\b(you\s+(must|should|will|need\s+to))\b[^.?!]{0,80}\b(transfer|withdraw|move|send|spend)\b[^.?!]{0,40}\b(funds?|money|tokens?|near|usdt)\b/i, "chain-command"],
];

const MEMORY_PATTERNS = [
  [/\bignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions|prompts?|rules?)\b/i, "override"],
  [/\byou\s+are\s+now\b/i, "role-hijack"],
  [/<\s*tool[-_ ]?call\b|```\s*tool\b/i, "tool-smuggle"],
  [/\b(system|initial)\s+(prompt|instructions?)\b/i, "system-probe"],
];

export function scanInput(text) {
  const flags = [];
  for (const [re, flag] of INPUT_PATTERNS) {
    if (re.test(text)) flags.push(flag);
  }
  return { ok: flags.length === 0, flags: [...new Set(flags)] };
}

export function scanMemory(facts) {
  const clean = [];
  let quarantined = 0;
  for (const f of facts || []) {
    const hit = MEMORY_PATTERNS.some(([re]) => re.test(String(f)));
    if (hit) quarantined++;
    else clean.push(f);
  }
  return { clean, quarantined };
}

export function sanitizeOutput(text) {
  return String(text || "")
    .replace(/```\s*tool\b[\s\S]*?```/gi, "[removed tool block]")
    .replace(/<\s*tool[-_ ]?call\b[\s\S]*?<\s*\/\s*tool[-_ ]?call\s*>/gi, "[removed tool block]")
    .replace(/\bfunction\s+call\s*:\s*\{[^}]{0,500}\}/gi, "[removed tool block]")
    .slice(0, 4000);
}
