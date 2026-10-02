import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Debounced autosave for a controlled text editor.
 *
 * Honors the frontend directive:
 *  - [Ref Timer Cleanup]: the debounce timer is cleared on unmount.
 *  - [Input Focus Stability]: while the input is focused (or has unsaved
 *    edits), external value updates do NOT clobber what the user is typing —
 *    the local state is authoritative until blur/flush.
 */
export function useDebouncedAutosave(opts: {
  /** The latest server value. */
  value: string;
  /** Persist the new text. */
  onSave: (v: string) => Promise<void> | void;
  delayMs?: number;
}): {
  text: string;
  setText: (v: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  saving: boolean;
  savedAt: number | null;
} {
  const { value, delayMs = 800 } = opts;
  const [text, setTextState] = useState(value);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const focusedRef = useRef(false);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest text, mirrored into a ref so the empty-deps unmount cleanup can flush
  // the current value — its closure would otherwise capture the initial `text`.
  const latestRef = useRef(value);
  const onSaveRef = useRef(opts.onSave);
  onSaveRef.current = opts.onSave;

  // External → local sync, but only when the user isn't actively editing.
  useEffect(() => {
    if (!focusedRef.current && !dirtyRef.current) {
      setTextState(value);
      latestRef.current = value;
    }
  }, [value]);

  const doSave = useCallback(async (v: string) => {
    setSaving(true);
    try {
      await onSaveRef.current(v);
      dirtyRef.current = false;
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }, []);

  const setText = useCallback(
    (v: string) => {
      setTextState(v);
      latestRef.current = v;
      dirtyRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void doSave(v);
      }, delayMs);
    },
    [delayMs, doSave],
  );

  const onFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);

  const onBlur = useCallback(() => {
    focusedRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (dirtyRef.current) void doSave(text);
  }, [text, doSave]);

  // Unmount cleanup: cancel the pending debounce timer AND flush the unsaved
  // edit, so a card that unmounts mid-edit — tab switch, navigation, or the
  // drafter re-parsing the `❓` block out from under the user on the 4s poll —
  // persists what was typed instead of silently dropping it. Call onSave
  // directly (not doSave) to skip the setSaving/setSavedAt state writes, which
  // would warn on an unmounted component.
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void onSaveRef.current(latestRef.current);
      }
    },
    [],
  );

  return { text, setText, onFocus, onBlur, saving, savedAt };
}
