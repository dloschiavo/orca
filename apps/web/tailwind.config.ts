import type { Config } from "tailwindcss";

// Linear-ish palette. Dense grid, high-contrast status dots, subtle chrome.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // chrome
        bg: "#0b0d12",
        surface: "#111319",
        surface2: "#171a22",
        border: "#232732",
        text: "#e6e8ee",
        muted: "#8a8f9e",
        // accents
        accent: "#5e6ad2",
        // state machine dots
        icebox: "#94a3b8",
        backlog: "#ffffff",
        "in-progress": "#eab308",
        "in-qa": "#f97316",
        "final-review": "#06b6d4",
        blocked: "#ef4444",
        done: "#22c55e",
        // certainty heatbar
        "cert-high": "#22c55e",
        "cert-medium": "#eab308",
        "cert-low": "#ef4444",
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
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
