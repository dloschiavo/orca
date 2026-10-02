// Postgres `text` — and therefore `jsonb`, which stores its strings as text —
// cannot hold a NUL byte (U+0000), and it rejects lone/unpaired UTF-16
// surrogates. Either one surfaces at insert time as:
//
//   PostgresError: unsupported Unicode escape sequence
//   routine: 'json_errsave_error'
//
// Agent CLI dispatch payloads (raw `claude` stdout, parsed JSON of tool
// results / model output, and file contents an agent happened to read) can
// carry these bytes, which made the whole activity event silently drop on the
// floor — the write threw, the catch swallowed it, and the event never
// reached the timeline. Scrub the payload before every activity_events insert.
//
// Hot path: this runs on every activity event, including high-frequency
// `agent_stream` events. It is a single scan that returns the SAME reference
// (zero allocation) whenever a value is already clean — only the rare dirty
// string/object/array is rebuilt.

/** Scan a string; rebuild it only if it carries a char Postgres jsonb rejects. */
function sanitizeString(s: string): string {
  let needsFix = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0) {
      needsFix = true;
      break;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — valid only when immediately followed by a low one.
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      needsFix = true;
      break;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate (a leading low surrogate is always unpaired).
      needsFix = true;
      break;
    }
  }
  if (!needsFix) return s;

  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0) continue; // strip NUL
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1]; // keep valid surrogate pair intact
        i++;
        continue;
      }
      out += "�"; // lone high surrogate → replacement char
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�"; // lone low surrogate → replacement char
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * Deep-walk a value and scrub the strings (and object keys) Postgres jsonb
 * cannot store. Returns the same reference when nothing needed changing, so
 * the common already-clean payload costs one scan and no allocation.
 */
export function sanitizeForJsonb<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeString(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    let result: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const before = value[i];
      const after = sanitizeForJsonb(before);
      if (result === null) {
        if (after !== before) {
          result = value.slice(0, i);
          result.push(after);
        }
      } else {
        result.push(after);
      }
    }
    return (result ?? value) as unknown as T;
  }

  if (value !== null && typeof value === "object") {
    // Only deep-walk plain objects. Leave Date, Buffer, Map, class instances,
    // etc. untouched — spreading their enumerable keys would strip prototype
    // and break round-tripping. (Activity payloads are plain JSON in practice.)
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    let result: Record<string, unknown> | null = null;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const before = obj[key];
      const after = sanitizeForJsonb(before);
      const cleanKey = sanitizeString(key);
      if (result === null) {
        if (after !== before || cleanKey !== key) {
          // First dirty entry — copy the clean keys seen so far, then write
          // this (and every later) entry through the sanitized path.
          result = {};
          for (let j = 0; j < i; j++) result[keys[j]] = obj[keys[j]];
          result[cleanKey] = after;
        }
      } else {
        result[cleanKey] = after;
      }
    }
    return (result ?? value) as unknown as T;
  }

  return value;
}
