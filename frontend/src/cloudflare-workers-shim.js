// Node shim for `cloudflare:workers` (mapped in vite.config.js).
// The TanStack Start server core imports { env, waitUntil } from it; outside
// a worker, env bindings are empty and waitUntil is fire-and-forget.
export const env = {};
export function waitUntil(promise) {
  if (promise && typeof promise.catch === "function") {
    promise.catch(() => {});
  }
}
// Entrypoint base classes the worker toolchain re-exports for type checks.
// Unused outside a worker; present only so the self-hosted build resolves.
export class WorkerEntrypoint {}
export class DurableObject {}
export class WorkflowEntrypoint {}
export default { env, waitUntil };
