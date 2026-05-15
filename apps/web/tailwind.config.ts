import type { Config } from "tailwindcss";

// Tokens are aliased to the design-system CSS variables defined in
// `src/index.css`. Editing the look-and-feel lives there, not here.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // chrome — aliased to --bg-*/--fg-*/--border-* in index.css
        bg: "var(--bg-0)",
        surface: "var(--bg-1)",
        surface2: "var(--bg-2)",
        surface3: "var(--bg-3)",
        border: "var(--border-1)",
        text: "var(--fg-0)",
        muted: "var(--fg-2)",
        // accents — aliased to design-system agent / status colors
        accent: "var(--ag-impl)",
        // state machine dots
        icebox: "var(--st-icebox)",
        planning: "var(--st-planning)",
        backlog: "var(--st-backlog)",
        implementing: "var(--st-implementation)",
        qa: "var(--st-qa)",
        review: "var(--st-review)",
        blocked: "var(--st-blocked)",
        done: "var(--st-done)",
        // legacy aliases
        "in-progress": "var(--st-implementation)",
        "in-qa": "var(--st-qa)",
        "final-review": "var(--st-review)",
        // certainty heatbar
        "cert-high": "var(--attn-done)",
        "cert-medium": "var(--attn-high)",
        "cert-low": "var(--attn-error)",
      },
      fontFamily: {
        sans: ["Geist", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: [
          "Geist Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
} satisfies Config;
