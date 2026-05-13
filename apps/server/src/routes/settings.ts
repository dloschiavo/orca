import { Hono } from "hono";
import { schema } from "@orca/db";
import { z } from "zod";
import type { OrcaEnv } from "../app.js";
import {
  getThrottleSettings,
  THROTTLE_KEYS,
} from "../services/throttle.js";

const patchSchema = z.object({
  throttle: z
    .object({
      maxConcurrentPerProject: z.number().int().min(1).optional(),
      maxConcurrentTotal: z.number().int().min(1).optional(),
      maxConcurrentQa: z.number().int().min(1).optional(),
      maxConcurrentSpecWriter: z.number().int().min(1).optional(),
    })
    .optional(),
});

export function settingsRoutes() {
  const app = new Hono<OrcaEnv>();

  // GET /api/settings — return all editable settings
  app.get("/", async (c) => {
    const db = c.get("db");
    const throttle = await getThrottleSettings(db);
    return c.json({ throttle });
  });

  // PATCH /api/settings — update one or more settings
  app.patch("/", async (c) => {
    const db = c.get("db");

    let body: z.infer<typeof patchSchema>;
    try {
      body = patchSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    if (body.throttle) {
      const upsert = async (key: string, value: number) => {
        await db
          .insert(schema.orcaSettings)
          .values({ key, value: String(value), updatedAt: new Date() })
          .onConflictDoUpdate({
            target: schema.orcaSettings.key,
            set: { value: String(value), updatedAt: new Date() },
          });
      };

      if (body.throttle.maxConcurrentPerProject !== undefined) {
        await upsert(
          THROTTLE_KEYS.maxConcurrentPerProject,
          body.throttle.maxConcurrentPerProject,
        );
      }
      if (body.throttle.maxConcurrentTotal !== undefined) {
        await upsert(
          THROTTLE_KEYS.maxConcurrentTotal,
          body.throttle.maxConcurrentTotal,
        );
      }
      if (body.throttle.maxConcurrentQa !== undefined) {
        await upsert(
          THROTTLE_KEYS.maxConcurrentQa,
          body.throttle.maxConcurrentQa,
        );
      }
      if (body.throttle.maxConcurrentSpecWriter !== undefined) {
        await upsert(
          THROTTLE_KEYS.maxConcurrentSpecWriter,
          body.throttle.maxConcurrentSpecWriter,
        );
      }
    }

    const throttle = await getThrottleSettings(db);
    return c.json({ throttle });
  });

  return app;
}
