import { EventEmitter } from "node:events";

export interface StoryChangedPayload {
  storyId: string;
  projectId: string;
  type: "created" | "updated" | "deleted";
}

const storyEvents = new EventEmitter();
storyEvents.setMaxListeners(0);

export { storyEvents };
