# Scripts

Every Goliath repo speaks the same five scripts. This page is the
operator-facing reference. Recipe spec:
[recipes/service-ports/SKILL.md](../recipes/service-ports/SKILL.md).

| Script           | What it does                                           |
|------------------|--------------------------------------------------------|
| `pnpm dev`       | Start dev server(s) with watchers + hot reload.        |
| `pnpm build`     | Production build (`dist/`, `.next/`, etc.).            |
| `pnpm start`     | Run the built artifact. Reads `process.env.PORT`.      |
| `pnpm typecheck` | `tsc --noEmit`.                                        |
| `pnpm clean`     | Wipe build output + framework caches.                  |

## How port hunting works

Every `pnpm dev` invocation goes through `scripts/service-ports.mjs`,
which:

1. Tries to claim the service's canonical port (4455 server, 5173 web
   in orca).
2. If taken — by a sibling Goliath project or any other process — hunts
   upward: `5174`, `5175`, …, up to canonical + 20.
3. Writes a registry file at `/tmp/goliath-{port}` describing the
   service, so other Goliath projects can see what's running.
4. On `Ctrl-C` (or any signal) deletes its file. Stale files from
   `kill -9` are cleaned up by the liveness probe on the next run.

Operator inspection:

```bash
ls /tmp/goliath-*       # what's running locally
cat /tmp/goliath-4455   # detail on one entry
```

## Frontend / backend coordination

When the frontend's canonical proxy target shifts because the backend
hunted to a different port, the helper sets an env var (`ORCA_SERVER_URL`
in orca) that the frontend config reads instead of a hardcoded URL.

The backend reciprocates by allowing **any** `localhost:*` origin in
dev-mode CORS, so a shifted frontend port still hits a 200, not a 403.

## Prod (`pnpm start`)

`pnpm start` reads `process.env.PORT` and binds it directly. No
helper, no `/tmp/goliath-*` file. Cloud Run sets `PORT` per service.
This is the contract `admin-gcp-deploy`'s Dockerfile relies on.
