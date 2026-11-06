import { createFileRoute } from "@tanstack/react-router";

// A server route: a raw HTTP endpoint that lives next to the pages. Currently a
// health-check clock only.
export const Route = createFileRoute("/api/time")({
  server: {
    handlers: {
      GET: async () => Response.json({ now: new Date().toISOString() }, { headers: { "cache-control": "no-store" } }),
    },
  },
});
