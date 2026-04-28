import { Hono } from "hono";
import { desc, eq, and, or } from "drizzle-orm";
import { schema } from "@orca/db";
import { z } from "zod";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { AgentName } from "@orca/shared";
import type { OrcaEnv } from "../app.js";
import { parsePromptSections } from "../services/prompt-loader.js";

// Agent registry routes.
//
// The Agents page lists every agent (deduped to its latest version) and
// lets the human edit the model, description, agentsMd, and the flat-file
// prompt at <repo>/prompts/<agent>.md (split on [SYSTEM] / [MAIN]). Git
// owns prompt history — there is no per-edit version row anymore.

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir.length > 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("[orca/agents] could not locate pnpm-workspace.yaml");
}

const PROMPTS_DIR = resolve(findRepoRoot(), "prompts");

function promptFilePath(agentName: string): string {
  return join(PROMPTS_DIR, `${agentName}.md`);
}

function buildPromptFile(system: string, main: string): string {
  const sysBlock = system.trim().length > 0 ? `${system.replace(/\s+$/, "")}\n` : "";
  const mainBlock = main.trim().length > 0 ? `${main.replace(/\s+$/, "")}\n` : "";
  return `[SYSTEM]\n${sysBlock}\n[MAIN]\n${mainBlock}`;
}

const patchSchema = z.object({
  model: z.string().nullable().optional(),
  fastModel: z.string().nullable().optional(),
  description: z.string().optional(),
  agentsMd: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, "name must be lowercase alphanumeric with hyphens"),
  description: z.string().optional().default(""),
  isCodeModifying: z.boolean().optional().default(false),
});

export function agentsRoutes(): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  // List the latest version of every agent, ordered by name.
  // Pass ?includeArchived=true to include archived agents.
  app.get("/", async (c) => {
    const db = c.get("db");
    const includeArchived = c.req.query("includeArchived") === "true";

    const all = await db
      .select()
      .from(schema.agents)
      .orderBy(desc(schema.agents.version));

    const latestByName = new Map<string, typeof all[number]>();
    for (const row of all) {
      if (!latestByName.has(row.name)) {
        latestByName.set(row.name, row);
      }
    }

    let agents = Array.from(latestByName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    if (!includeArchived) {
      agents = agents.filter((a) => a.archivedAt === null);
    }

    return c.json({ agents });
  });

  // Create a new agent.
  app.post("/", async (c) => {
    const body = createSchema.parse(await c.req.json());
    const db = c.get("db");

    // Check name doesn't already exist
    const [existing] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, body.name as AgentName))
      .limit(1);
    if (existing) {
      return c.json({ error: "agent name already exists" }, 409);
    }

    const [created] = await db
      .insert(schema.agents)
      .values({
        name: body.name as AgentName,
        description: body.description,
        isCodeModifying: body.isCodeModifying,
        version: 1,
      })
      .returning();

    return c.json({ agent: created }, 201);
  });

  // Update fields on the latest-version row of one agent.
  app.patch("/:name", async (c) => {
    const name = c.req.param("name") as AgentName;
    const body = patchSchema.parse(await c.req.json());
    const db = c.get("db");

    const [latest] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, name))
      .orderBy(desc(schema.agents.version))
      .limit(1);
    if (!latest) {
      return c.json({ error: "agent not found" }, 404);
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.model !== undefined) updates.model = body.model;
    if (body.fastModel !== undefined) updates.fastModel = body.fastModel;
    if (body.description !== undefined) updates.description = body.description;
    if (body.agentsMd !== undefined) updates.agentsMd = body.agentsMd;

    const [updated] = await db
      .update(schema.agents)
      .set(updates)
      .where(eq(schema.agents.id, latest.id))
      .returning();

    return c.json({ agent: updated });
  });

  // Archive an agent (soft-delete).
  app.post("/:name/archive", async (c) => {
    const name = c.req.param("name") as AgentName;
    const db = c.get("db");

    const [latest] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, name))
      .orderBy(desc(schema.agents.version))
      .limit(1);
    if (!latest) {
      return c.json({ error: "agent not found" }, 404);
    }

    const [updated] = await db
      .update(schema.agents)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.agents.name, name))
      .returning();

    return c.json({ agent: updated });
  });

  // Unarchive an agent.
  app.post("/:name/unarchive", async (c) => {
    const name = c.req.param("name") as AgentName;
    const db = c.get("db");

    const [latest] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, name))
      .orderBy(desc(schema.agents.version))
      .limit(1);
    if (!latest) {
      return c.json({ error: "agent not found" }, 404);
    }

    const [updated] = await db
      .update(schema.agents)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(schema.agents.name, name))
      .returning();

    return c.json({ agent: updated });
  });

  // Read this agent's prompt file. Returns the parsed [SYSTEM] / [MAIN]
  // sections so the UI can show two textareas. Missing file → both null.
  app.get("/:name/prompt", async (c) => {
    const name = c.req.param("name");
    const body = await readFile(promptFilePath(name), "utf8").catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      },
    );
    if (body == null) {
      return c.json({ system: null, main: null, exists: false });
    }
    const sections = parsePromptSections(body);
    return c.json({ ...sections, exists: true });
  });

  // Write this agent's prompt file. Saves both sections in one go;
  // git owns history. Empty section → omitted from the file body.
  app.put("/:name/prompt", async (c) => {
    const name = c.req.param("name");
    const parsed = z
      .object({ system: z.string().nullable(), main: z.string().nullable() })
      .parse(await c.req.json());
    if (!existsSync(PROMPTS_DIR)) await mkdir(PROMPTS_DIR, { recursive: true });
    const fileBody = buildPromptFile(parsed.system ?? "", parsed.main ?? "");
    await writeFile(promptFilePath(name), fileBody, "utf8");
    return c.json({ system: parsed.system, main: parsed.main, exists: true });
  });

  // List recent LLM invocations for an agent — prompt/response pairs
  // from activity_events where actor matches the agent name.
  app.get("/:name/invocations", async (c) => {
    const name = c.req.param("name");
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const db = c.get("db");

    // Map agent names to their event kind sets.
    // promptKinds: events that represent a prompt being sent to the LLM.
    // completedKinds: events that represent a response received from the LLM.
    // For historical data, _started events serve as proxy for prompt when
    // _prompt events don't exist yet.
    const kindMap: Record<string, { prompt: string[]; completed: string[] }> = {
      triage: { prompt: ["triage_prompt", "triage_started"], completed: ["triage_completed"] },
      reviewer: { prompt: ["qa_prompt", "qa_started"], completed: ["qa_completed"] },
      classifier: { prompt: ["classifier_prompt", "classifier_started"], completed: ["classifier_completed"] },
    };
    const kinds = kindMap[name] ?? {
      prompt: ["agent_prompt", "agent_spawned"],
      completed: ["dispatch_completed"],
    };
    const allKinds = [...kinds.prompt, ...kinds.completed];

    const rows = await db
      .select()
      .from(schema.activityEvents)
      .where(
        and(
          eq(schema.activityEvents.actor, name),
          or(...allKinds.map((k) => eq(schema.activityEvents.kind, k))),
        ),
      )
      .orderBy(desc(schema.activityEvents.createdAt))
      .limit(limit * 3);

    // Group events by storyId, then pair prompt→completed.
    const byStory = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byStory.get(row.storyId) ?? [];
      list.push(row);
      byStory.set(row.storyId, list);
    }

    const promptKindSet = new Set(kinds.prompt);
    const completedKindSet = new Set(kinds.completed);

    const invocations: Array<{
      id: string;
      storyId: string;
      agent: string;
      promptAt: string;
      prompt: string;
      systemPrompt: string | null;
      responseAt: string | null;
      response: Record<string, unknown> | null;
    }> = [];

    for (const [storyId, events] of byStory) {
      events.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      // First pass: build invocations from completed events (always exist).
      // Then try to find a preceding prompt event to attach.
      const completedEvents = events.filter((e) => completedKindSet.has(e.kind));
      const promptEvents = events.filter((e) => promptKindSet.has(e.kind));

      if (completedEvents.length === 0 && promptEvents.length > 0) {
        // Only prompts, no completions (pending invocations)
        for (const pe of promptEvents) {
          const payload = pe.payload as Record<string, unknown>;
          const promptText = (payload.prompt as string) ?? JSON.stringify(payload);
          const systemPromptText = (payload.systemPrompt as string | undefined) ?? null;
          invocations.push({
            id: pe.id,
            storyId,
            agent: name,
            promptAt: pe.createdAt.toISOString(),
            prompt: promptText,
            systemPrompt: systemPromptText,
            responseAt: null,
            response: null,
          });
        }
        continue;
      }

      // For each completed event, find the nearest preceding prompt event.
      let promptIdx = 0;
      for (const ce of completedEvents) {
        const ceTime = new Date(ce.createdAt).getTime();
        let bestPrompt: (typeof events)[number] | null = null;

        // Find the latest prompt event before this completion
        while (promptIdx < promptEvents.length) {
          const pe = promptEvents[promptIdx]!;
          if (new Date(pe.createdAt).getTime() <= ceTime) {
            bestPrompt = pe;
            promptIdx++;
          } else {
            break;
          }
        }

        const payload = ce.payload as Record<string, unknown>;
        const promptPayload = bestPrompt?.payload as Record<string, unknown> | undefined;
        const promptText = promptPayload
          ? ((promptPayload.prompt as string) ?? JSON.stringify(promptPayload))
          : "(prompt not logged)";
        const systemPromptText = (promptPayload?.systemPrompt as string | undefined) ?? null;

        invocations.push({
          id: ce.id,
          storyId,
          agent: name,
          promptAt: bestPrompt?.createdAt.toISOString() ?? ce.createdAt.toISOString(),
          prompt: promptText,
          systemPrompt: systemPromptText,
          responseAt: ce.createdAt.toISOString(),
          response: payload,
        });
      }
    }

    // Sort by promptAt descending (newest first)
    invocations.sort((a, b) => new Date(b.promptAt).getTime() - new Date(a.promptAt).getTime());

    return c.json({ invocations: invocations.slice(0, limit) });
  });

  return app;
}
