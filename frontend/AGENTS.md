# AGENTS.md

## Project Context

Launchly dashboard: **TanStack Start** (React 19, plain JavaScript — no
TypeScript), file-based routes, SSR by default, self-hosted on plain Node via
`server-standalone.mjs`. Treat it as user-owned application code, keep changes
focused on the user's request, and preserve the conventions below.

Start with `README.md` for local setup.

## Key Files

- `src/routes/__root.jsx`: the HTML document (`<html>`, `<head>` via
  `HeadContent`, `<Scripts />`). There is **no `index.html`**.
- `src/routes/_site/*.jsx`: pages (discover, coins, products, creators,
  dashboard, launch). `src/routes/api/*.js`: server routes (raw HTTP
  endpoints). `src/routeTree.gen.ts` is generated on every dev/build run —
  never edit it.
- `src/lib/launchly.js`: backend + agent client, mappers, hooks. Live-first
  with demo fallback; unknown figures are `null` and render as "—".
- `src/lib/demo-data.js`: labelled fallback data used only when the backend
  is unreachable.
- `src/start.js`: the Start instance; error-capture middlewares only.
- `src/server.js`, `src/lib/error-capture.js`, `src/lib/error-capture.server.js`:
  structured server-error logging (JSON lines to the server log). They change
  nothing a visitor gets back.
- `src/components/ui/`: shadcn/ui kit. `src/index.css` + `tailwind.config.js`:
  design tokens.
- `vite.config.js`: `cloudflare()` (SSR environment), `tanstackStart()`,
  `react()`. Keep `PREBUNDLE`: Vite bundles every runtime dependency at
  startup so a package first imported mid-session can't make the server render
  load a second React. A new dependency joins it automatically.
- `server-standalone.mjs`: production server (static `dist/client` + built
  `{ fetch }` handler). `src/cloudflare-workers-shim.js`: Node stand-in for
  the `cloudflare:workers` import, mapped in `vite.config.js`.

## Working Notes

- `npm run dev` runs the TanStack dev server (Vite).
- `npm run build` emits `dist/client` (static assets) and `dist/server` (the
  server bundle). Never commit `dist/`.
- Data flows through `src/lib/launchly.js` hooks; pages never fetch backend
  URLs directly.
- Server and first client render must match: read `window`, `document` and
  browser storage only in effects and handlers (never in render or a `useState`
  initializer), and format dates and numbers with an explicit locale.
- Run `npm run lint` before finishing code changes. Write JavaScript/JSX only
  — no `.ts`/`.tsx` files and no type annotations.
