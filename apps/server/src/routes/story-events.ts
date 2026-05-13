import { Hono } from "hono";
import type { OrcaEnv } from "../app.js";
import { storyEvents, type StoryChangedPayload } from "../services/story-events.js";

export function storyEventsRoutes(): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  app.get("/", (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);

    const encoder = new TextEncoder();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let listener: ((payload: StoryChangedPayload) => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        listener = (payload: StoryChangedPayload) => {
          if (payload.projectId !== projectId) return;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        };
        storyEvents.on("story.changed", listener);

        heartbeatTimer = setInterval(() => {
          controller.enqueue(encoder.encode(": ping\n\n"));
        }, 25_000);
      },
      cancel() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (listener) storyEvents.off("story.changed", listener);
        console.log(`[orca] SSE client disconnected (projectId=${projectId})`);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}
