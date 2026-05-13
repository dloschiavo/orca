import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useStoryEventStream(projectId: string | null | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;

    const source = new EventSource(`/api/stories/events?projectId=${encodeURIComponent(projectId)}`);

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { storyId: string; projectId: string; type: string };
        queryClient.invalidateQueries({ queryKey: ["stories", payload.projectId] });
        queryClient.invalidateQueries({ queryKey: ["story", payload.storyId] });
        queryClient.invalidateQueries({ queryKey: ["story-counts"] });
      } catch {
        // malformed event — ignore
      }
    };

    return () => {
      source.close();
    };
  }, [projectId, queryClient]);
}
