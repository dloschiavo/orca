import React from "react";

/** Render a plain-text string with basic markdown: newlines, bullets, **bold**, *italic*. */
export function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const bulletMatch = line.match(/^(\s*)([-*]|\d+\.)\s/);
    const content = bulletMatch
      ? parseInlineMarkdown(line.slice(bulletMatch[0].length))
      : parseInlineMarkdown(line);
    return (
      React.createElement(React.Fragment, { key: i },
        i > 0 ? React.createElement("br") : null,
        bulletMatch
          ? React.createElement("span", {
              style: { paddingLeft: `${((bulletMatch[1]?.length ?? 0) + 1) * 0.75}em` },
            },
            bulletMatch[2]?.match(/\d+\./) ? `${bulletMatch[2]} ` : "• ",
            content,
          )
          : content,
      )
    );
  });
}

/** Parse **bold** and *italic* markers into React elements. */
export function parseInlineMarkdown(text: string): React.ReactNode {
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[2] !== undefined) {
      parts.push(React.createElement("strong", { key: key++ }, match[2]));
    } else if (match[3] !== undefined) {
      parts.push(React.createElement("em", { key: key++ }, match[3]));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : parts;
}

/** If the string looks like JSON, pretty-print it; otherwise return as-is. */
export function maybePrettyJson(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // not valid JSON
    }
  }
  return text;
}
