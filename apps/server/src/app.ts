import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { OrcaDb } from "@orca/db";
import { projectsRoutes } from "./routes/projects.js";
import { storiesRoutes } from "./routes/stories.js";
import { auditRoutes } from "./routes/audit.js";
import { agentsRoutes } from "./routes/agents.js";
import { settingsRoutes } from "./routes/settings.js";
import { refinementQuestionsRoutes } from "./routes/refinement-questions.js";
import { storyEventsRoutes } from "./routes/story-events.js";
import {
  getUsageFraction,
  loadUsageFractionFromDb,
  backfillUsageFractionFromActivity,
} from "./services/concurrency.js";
import {
  getAvailableModels,
  getAvailableModelsStatus,
} from "./services/available-models.js";

export interface AppDeps {
  db: OrcaDb;
}

export type OrcaEnv = {
  Variables: {
    db: OrcaDb;
  };
};

export function createApp(deps: AppDeps): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: ["http://localhost:5173", "http://localhost:4455"],
      credentials: true,
    }),
  );

  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, service: "orca" }));

  // ─── HOW USAGE DATA WORKS ──────────────────────────────────────────────────
  //
  // Single source: the CLI's `rate_limit_event` stream-json messages, which
  // carry a `utilization` field on the `seven_day` bucket. The stream
  // handler in stories.ts feeds extractUsageFraction → recordUsageFraction
  // → persistUsageFraction live as dispatches run.
  //
  // Boot sequence:
  //   1. loadUsageFractionFromDb — restore last-persisted value.
  //   2. backfillUsageFractionFromActivity — if the activity log has a
  //      `seven_day` event newer than the persisted value, adopt it. This
  //      covers the case where past events were observed but not extracted
  //      (e.g. the CLI-renamed-the-field bug).
  //
  // Don't add a /refresh button or a /push endpoint — neither worked, and
  // the user explicitly removed both. The bar updates passively.
  // ─────────────────────────────────────────────────────────────────────────────

  loadUsageFractionFromDb(deps.db)
    .then(() => backfillUsageFractionFromActivity(deps.db))
    .catch((err) =>
      console.error("[orca] failed to seed usage fraction:", err),
    );

  app.get("/api/rate-limit-usage", (c) => {
    const info = getUsageFraction();
    return c.json({ usage: info });
  });

  app.get("/api/models", (c) =>
    c.json({
      models: getAvailableModels(),
      status: getAvailableModelsStatus(),
    }),
  );

  app.route("/api/projects", projectsRoutes());
  // Mount /events BEFORE /api/stories to prevent /:id catching "events"
  app.route("/api/stories/events", storyEventsRoutes());
  app.route("/api/stories", storiesRoutes());
  app.route("/api/audit", auditRoutes());
  app.route("/api/agents", agentsRoutes());
  app.route("/api/settings", settingsRoutes());
  app.route("/api/refinement-questions", refinementQuestionsRoutes());

  app.onError((err, c) => {
    console.error("[orca] error:", err);
    return c.json({ error: err.message }, 500);
  });

  return app;
}
