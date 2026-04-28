import { useEffect, useState } from "react";

// Tiny global error bus for surfacing fetch / mutation failures. The
// QueryCache + MutationCache onError handlers in main.tsx push into this; the
// <ErrorToaster /> mounted in App.tsx subscribes and renders a stack of
// dismissible toasts. Without this, a 500 from the API silently turns into an
// "empty list" in the UI, which has bitten us before.

interface Toast {
  id: number;
  message: string;
}

let nextId = 1;
const listeners = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];

function emit() {
  for (const l of listeners) l(toasts);
}

export function pushErrorToast(message: string): void {
  const id = nextId++;
  toasts = [...toasts, { id, message }];
  emit();
  // Auto-dismiss after 8s so a flurry of failed polls doesn't paper the screen.
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 8000);
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function ErrorToaster() {
  const [items, setItems] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setItems);
    return () => {
      listeners.delete(setItems);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md">
      {items.map((t) => (
        <div
          key={t.id}
          className="bg-red-950/90 border border-red-700 text-red-100 text-xs rounded-md shadow-lg px-3 py-2 flex items-start gap-2"
        >
          <span className="flex-1 break-all whitespace-pre-wrap">
            {t.message}
          </span>
          <button
            className="text-red-300 hover:text-red-100 shrink-0"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
