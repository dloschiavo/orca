export type SummaryLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "json"
  | "markdown"
  | "unknown";

export interface SummaryDecl {
  name: string;
  line: number;
  kind: "class" | "interface" | "type" | "enum";
  exported: boolean;
}

export interface SummaryFunction {
  name: string;
  line: number;
  signature: string;
  exported: boolean;
}

export interface FileSummary {
  path: string;
  sha: string;
  language: SummaryLanguage;
  imports: string[];
  classes: SummaryDecl[];
  functions: SummaryFunction[];
  tokens: number;
  originalTokens: number;
  generatedAt: string;
}

export interface CacheIndexEntry {
  sha: string;
  cacheFile: string;
}

export type CacheIndex = Record<string, CacheIndexEntry>;
