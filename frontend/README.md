# Launchly dashboard

TanStack Start (React 19, plain JavaScript) frontend for Launchly. File-based
routes, SSR by default, self-hosted on plain Node (no worker platform).

## Setup

```bash
npm install
npm run dev        # :5173, talks to the backend at VITE_LAUNCHLY_API
```

Backend + agent defaults live in `src/lib/launchly.js`
(`http://localhost:8090` / `http://localhost:8091`); override with
`VITE_LAUNCHLY_API` / `VITE_LAUNCHLY_AGENT` (relative paths like `/api` work —
the deploy reverse-proxy mounts the backend there).

## Production

```bash
npm run build      # dist/client + dist/server
npm start          # node server-standalone.mjs (PORT/HOST env, default 127.0.0.1:3000)
```

`server-standalone.mjs` serves `dist/client` statically and routes everything
else through the built `{ fetch }` handler. `src/cloudflare-workers-shim.js`
stands in for the `cloudflare:workers` import the Start server core expects.

## Data

Pages read live chain data first (`src/lib/launchly.js`) and fall back to
labelled demo data (`src/lib/demo-data.js`) when the backend is unreachable.
Every figure is either chain-backed or rendered as "—"; nothing is fabricated.

## Conventions

- JavaScript/JSX only — no `.ts`/`.tsx` (the generated `src/routeTree.gen.ts`
  is the sole exception and is never hand-edited).
- No auth layer: pages are public, backend reads are permissionless.
- Run `npm run lint` before finishing code changes.
