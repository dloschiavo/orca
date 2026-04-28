# orca

**Linear-style PM frontend for agentic code development.** The orchestrator.

See the full design spec at `~/.claude/plans/toasty-kindling-fox.md`.

## Layout

```
orca/
├─ apps/
│  ├─ server/      # Hono backend (single-user; Tauri sidecar)
│  └─ web/         # Vite + React + Tailwind + Radix SPA
└─ packages/
   ├─ shared/      # TypeScript types shared across apps
   ├─ db/          # Drizzle ORM + embedded-postgres schema & migrations
   └─ adapters/    # StoryAdapter interface + claude-local, agent-sdk
```

## Stack

- **Runtime:** Node 20+, pnpm workspaces
- **Backend:** Hono
- **Frontend:** Vite + React 18 + Tailwind + Radix UI + TanStack Query
- **DB:** Drizzle ORM + embedded-postgres (local dev)
- **Desktop shell:** Tauri (deferred — add once Rust toolchain is installed)
- **Execution substrate:** `claude-local` adapter for code-modifying dispatches, `agent-sdk` adapter for narrow helpers (Scrum Master, Classifier, Compactor)

## Dev

```bash
pnpm install
pnpm db:push                 # create tables in embedded postgres
pnpm seed:audit              # seed Implementation Audit rows from _recipes/_unmigrated
pnpm dev                     # runs server + web in parallel
```

Then open http://localhost:5173 (web) — the server is at http://localhost:4455.

## Core concepts (quick reference)

- **Story** — atomic unit of work; scrum-ish state machine.
- **Acceptance Card** — the imperative artifact produced during Refinement; implementor dispatches are closed "do exactly these steps" prompts against it.
- **Story Working Memory** — compact, structured, compactor-maintained state that makes cold dispatches cheap.
- **Refinement Q&A Inbox** — global, asynchronous uncertainty extraction surface. Pre-loads the human's thinking before a resource becomes available (the metavine principle).
- **Implementation Certainty Heatbar** — per-story visualization of the same uncertainty, on the Acceptance Card pane.
- **Implementation Audit** — PM pipeline visibility matrix; seeded from `_recipes/_unmigrated/*.md`.
- **Findings** — root-cause-tagged critiques. `pipeline-failure` routes to a tooling backlog; `bad-spec`-family routes to the human. "The agent just failed" is never a terminal verdict.

## Status

Day 0. Scaffold only.
