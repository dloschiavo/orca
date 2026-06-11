# Orca API — stories & agents

Use these endpoints when you need to create or update stories, or wake an agent, from outside the orca project directory. No authentication is required — the server is local-only.

**Base URL:** `http://localhost:4455`

---

## Stories

### Create a story

```
POST /api/stories
Content-Type: application/json

{
  "projectId": "<uuid>",          // required
  "title": "<string>",            // required
  "specMd": "<markdown>",         // optional, default ""
  "status": "backlog" | "icebox", // optional, default "backlog"
  "labels": ["<string>"],         // optional
  "priority": <integer>           // optional
}
```

Response `201`: `{ "story": Story }`

Creating with `status: "backlog"` (or omitting status) auto-triggers triage. Use `"icebox"` to park without triggering.

---

### Update a story

```
PATCH /api/stories/:id
Content-Type: application/json

{
  "title": "<string>",
  "specMd": "<markdown>",
  "status": "icebox" | "backlog" | "in_progress" | "in_qa" | "final_review" | "blocked" | "done" | "canceled",
  "labels": ["<string>"],
  "priority": <integer>,
  "blockedReason": "<string> | null",
  "actor": "<your-agent-name>"    // MUST be set by agents — used for activity attribution
}
```

All fields are optional. Response `200`: `{ "story": Story }`

Agents MUST pass `actor` with their agent name on every PATCH.

---

### Get a story

```
GET /api/stories/:id
```

Response: `{ "story": Story, "activity": ActivityEvent[], ... }`

---

### List stories

```
GET /api/stories?projectId=<uuid>&status=<status>
```

`status` is optional. Response: `{ "stories": Story[] }`

---

### Post a comment on a story

Comments feed into the next dispatch as the user turn (instead of resending the full spec). Use this to leave QA-failure feedback or any inter-agent message that should reach the next agent.

```
POST /api/stories/:id/comment
Content-Type: application/json

{
  "body":      "<string>",     // required
  "actor":     "<your-agent-name>",  // who is commenting (e.g. "qa-tester")
  "interrupt": false            // optional; true = kill running agent now and reset to backlog
}
```

Response `200`: `{ "ok": true }`. Returns `400` if `body` is empty.

---

## Waking / dispatching agents

### Wake the currently-assigned agent

Use this to nudge an agent that is already assigned but idle (e.g. after you update a story's spec or status).

```
POST /api/stories/:id/wake
```

Response `202`: `{ "ok": true }` — safe to call even if the agent is already running.
Returns `409` if the story is in a terminal state (`done`, `blocked`, `canceled`).

---

### Dispatch (triage → assign → run)

Use this to fully dispatch a story that has no agent yet, or to re-dispatch after a stop.

```
POST /api/stories/:id/dispatch
```

Response `202`: `{ "ok": true }`
Returns `409` if story is already `in_progress`.

---

### Stop a running agent

```
POST /api/stories/:id/stop
```

Kills the agent process and transitions story to `blocked`.

---

## Canonical story statuses

The valid `status` values are defined in `packages/shared/src/` inside the orca repo. Never use `refinement`, `unreviewed`, or `implementing` — those are retired.

| Status | Meaning |
|---|---|
| `icebox` | Parked, no triage |
| `backlog` | Queued for the assigned agent (heartbeat will pick up) |
| `in_progress` | Agent actively running |
| `in_qa` | Do-er finished, qa-tester is next (automated) |
| `final_review` | Awaiting human review (no automation will pick this up) |
| `blocked` | Blocked (human action needed to resolve issue) |
| `done` | Complete (means human has approved it, NEVER use this yourself) |
| `canceled` | Abandoned (means human has abandoned it, NEVER use this yourself) |

Retired (rejected by the API): `todo`, `in_review`, `refinement`, `unreviewed`, `implementing`.

---

## Typical flow for an external agent

1. **Create** the story with `POST /api/stories` (include a full `specMd`).
2. If you want to assign a specific agent before dispatch, **PATCH** `agent: "<name>"`.
3. Call `POST /api/stories/:id/dispatch` to trigger triage + run.
4. To update the spec of an already-assigned story, **PATCH** the spec then call `/wake` — the running agent will pick it up on next heartbeat.