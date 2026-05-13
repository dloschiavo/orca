import ts from "typescript";
import type { FileSummary, SummaryDecl, SummaryFunction, SummaryLanguage } from "./types.js";

const MAX_IMPORTS = 200;
const MAX_SIG = 250;

export function detectLanguage(path: string): SummaryLanguage {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".ts": return "typescript";
    case ".tsx": return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs": return "javascript";
    case ".jsx": return "jsx";
    case ".json": return "json";
    case ".md":
    case ".mdx": return "markdown";
    default: return "unknown";
  }
}

function estTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

function buildSummary(
  path: string,
  sha: string,
  language: SummaryLanguage,
  imports: string[],
  classes: SummaryDecl[],
  functions: SummaryFunction[],
  content: string,
): FileSummary {
  const summaryText = JSON.stringify({ imports, classes, functions });
  return {
    path,
    sha,
    language,
    imports,
    classes,
    functions,
    tokens: estTokens(summaryText),
    originalTokens: estTokens(content),
    generatedAt: new Date().toISOString(),
  };
}

export function summarizeContent(
  content: string,
  relPath: string,
  sha: string,
): FileSummary {
  const language = detectLanguage(relPath);

  switch (language) {
    case "typescript":
    case "tsx":
    case "javascript":
    case "jsx":
      return summarizeTsLike(content, relPath, sha, language);
    case "markdown":
      return summarizeMarkdown(content, relPath, sha);
    case "json":
      return summarizeJson(content, relPath, sha);
    default:
      return regexFallback(content, relPath, sha, language);
  }
}

// ---------------------------------------------------------------------------
// TS / JS via TypeScript Compiler API
// ---------------------------------------------------------------------------

function tsScriptKind(language: SummaryLanguage): ts.ScriptKind {
  switch (language) {
    case "tsx": return ts.ScriptKind.TSX;
    case "jsx": return ts.ScriptKind.JSX;
    case "javascript": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function trimSignature(text: string): string {
  // Drop the function/method body — everything from the first `{` after the params.
  const compact = text.replace(/\s+/g, " ").trim();
  const brace = compact.indexOf("{");
  const sig = brace > 0 ? compact.slice(0, brace).trim() : compact;
  return sig.length > MAX_SIG ? sig.slice(0, MAX_SIG) + "…" : sig;
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return (nl < 0 ? text : text.slice(0, nl)).trim();
}

function summarizeTsLike(
  content: string,
  relPath: string,
  sha: string,
  language: SummaryLanguage,
): FileSummary {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, false, tsScriptKind(language));
  } catch {
    return regexFallback(content, relPath, sha, language);
  }

  const imports: string[] = [];
  const classes: SummaryDecl[] = [];
  const functions: SummaryFunction[] = [];

  const collectFromStatement = (stmt: ts.Statement, exported: boolean): void => {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      if (imports.length < MAX_IMPORTS) {
        imports.push(firstLine(stmt.getText(sf)));
      }
      return;
    }

    if (ts.isExportDeclaration(stmt)) {
      if (imports.length < MAX_IMPORTS) {
        imports.push(firstLine(stmt.getText(sf)));
      }
      return;
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      functions.push({
        name: stmt.name.text,
        line: lineOf(sf, stmt.getStart(sf)),
        signature: trimSignature(stmt.getText(sf)),
        exported,
      });
      return;
    }

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      classes.push({
        name: stmt.name.text,
        line: lineOf(sf, stmt.getStart(sf)),
        kind: "class",
        exported,
      });
      return;
    }

    if (ts.isInterfaceDeclaration(stmt)) {
      classes.push({
        name: stmt.name.text,
        line: lineOf(sf, stmt.getStart(sf)),
        kind: "interface",
        exported,
      });
      return;
    }

    if (ts.isTypeAliasDeclaration(stmt)) {
      classes.push({
        name: stmt.name.text,
        line: lineOf(sf, stmt.getStart(sf)),
        kind: "type",
        exported,
      });
      return;
    }

    if (ts.isEnumDeclaration(stmt)) {
      classes.push({
        name: stmt.name.text,
        line: lineOf(sf, stmt.getStart(sf)),
        kind: "enum",
        exported,
      });
      return;
    }

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const declText = decl.getText(sf);
          functions.push({
            name: decl.name.text,
            line: lineOf(sf, decl.getStart(sf)),
            signature: trimSignature(`${exported ? "export " : ""}${declText}`),
            exported,
          });
        }
      }
    }
  };

  for (const stmt of sf.statements) {
    collectFromStatement(stmt, hasExportModifier(stmt));
  }

  return buildSummary(relPath, sha, language, imports, classes, functions, content);
}

// ---------------------------------------------------------------------------
// Markdown — collect headings + opening paragraph
// ---------------------------------------------------------------------------

function summarizeMarkdown(content: string, relPath: string, sha: string): FileSummary {
  const lines = content.split("\n");
  const headings: SummaryDecl[] = [];
  const introParts: string[] = [];
  let inFence = false;
  let introDone = false;

  for (let i = 0; i < lines.length; i++) {
    const stripped = (lines[i] ?? "").trim();
    if (stripped.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (stripped.startsWith("#")) {
      const depth = stripped.length - stripped.replace(/^#+/, "").length;
      const name = stripped.replace(/^#+\s*/, "");
      const kind: SummaryDecl["kind"] = depth === 1 ? "class" : depth === 2 ? "interface" : "type";
      headings.push({ name, line: i + 1, kind, exported: true });
    } else if (stripped && !introDone && headings.length === 0) {
      introParts.push(stripped);
      if (introParts.length >= 3) introDone = true;
    }
  }

  const functions: SummaryFunction[] = [];
  if (introParts.length > 0) {
    functions.push({
      name: "_intro",
      line: 1,
      signature: introParts.join(" ").slice(0, MAX_SIG),
      exported: true,
    });
  }

  return buildSummary(relPath, sha, "markdown", [], headings, functions, content);
}

// ---------------------------------------------------------------------------
// JSON — top-level keys
// ---------------------------------------------------------------------------

function summarizeJson(content: string, relPath: string, sha: string): FileSummary {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed as Record<string, unknown>).slice(0, 50);
      const classes: SummaryDecl[] = keys.map((k) => ({
        name: k,
        line: 1,
        kind: "type",
        exported: true,
      }));
      return buildSummary(relPath, sha, "json", [], classes, [], content);
    }
  } catch {
    // fall through
  }
  return regexFallback(content, relPath, sha, "json");
}

// ---------------------------------------------------------------------------
// Regex fallback for everything else / parse failures
// ---------------------------------------------------------------------------

function regexFallback(
  content: string,
  relPath: string,
  sha: string,
  language: SummaryLanguage,
): FileSummary {
  const lines = content.split("\n").slice(0, 400);
  const imports: string[] = [];
  const functions: SummaryFunction[] = [];
  const classes: SummaryDecl[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (/^(import|from|require|#include|using)\b/.test(line)) {
      if (imports.length < MAX_IMPORTS) imports.push(line.slice(0, MAX_SIG));
      continue;
    }
    let m = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (m?.[1]) {
      functions.push({
        name: m[1],
        line: i + 1,
        signature: line.slice(0, MAX_SIG),
        exported: line.startsWith("export"),
      });
      continue;
    }
    m = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (m?.[1]) {
      classes.push({ name: m[1], line: i + 1, kind: "class", exported: line.startsWith("export") });
      continue;
    }
    m = line.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (m?.[1]) {
      classes.push({ name: m[1], line: i + 1, kind: "interface", exported: line.startsWith("export") });
      continue;
    }
    m = line.match(/^(?:export\s+)?type\s+(\w+)/);
    if (m?.[1]) {
      classes.push({ name: m[1], line: i + 1, kind: "type", exported: line.startsWith("export") });
    }
  }

  return buildSummary(relPath, sha, language, imports, classes, functions, content);
}
