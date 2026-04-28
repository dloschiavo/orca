import type { StoryAdapter } from "./story-adapter.js";

/**
 * Simple in-process adapter registry. The server populates it at startup
 * and the dispatcher looks up adapters by `type`.
 *
 * Default population on day one (per the spec's §Decisions locked):
 *   - `claude-local` for code-modifying dispatches
 *   - `agent-sdk` for Scrum Master / Classifier / Compactor
 *
 * Neither is bundled yet in this scaffold — the registry is wired so we can
 * drop them in without touching the dispatcher, UI, or state machine.
 */
export class AdapterRegistry {
  private readonly byType = new Map<string, StoryAdapter>();

  register(adapter: StoryAdapter): void {
    if (this.byType.has(adapter.type)) {
      throw new Error(`Adapter already registered: ${adapter.type}`);
    }
    this.byType.set(adapter.type, adapter);
  }

  get(type: string): StoryAdapter {
    const adapter = this.byType.get(type);
    if (!adapter) {
      throw new Error(
        `No adapter registered for type "${type}". ` +
          `Known: ${[...this.byType.keys()].join(", ") || "<none>"}`,
      );
    }
    return adapter;
  }

  has(type: string): boolean {
    return this.byType.has(type);
  }

  list(): StoryAdapter[] {
    return [...this.byType.values()];
  }
}
