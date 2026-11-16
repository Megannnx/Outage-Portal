import type { Config } from "tailwindcss";
// ATEC design language (shared with the ATEC Training Portal): black + red ops-tool aesthetic,
// semantic CSS-variable tokens, dark by default with an opt-in light theme.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "var(--background)", "background-alt": "var(--background-alt)",
        surface: "var(--surface)", "surface-2": "var(--surface-2)", line: "var(--line)",
        primary: { DEFAULT: "var(--primary)", bright: "var(--primary-bright)", hover: "var(--primary-hover)", tint: "var(--red-tint-50)", tint2: "var(--red-tint-100)", edge: "var(--red-tint-200)" },
        ink: { DEFAULT: "var(--ink)", secondary: "var(--ink-secondary)", muted: "var(--ink-muted)" },
        success: { DEFAULT: "var(--success)", tint: "var(--green-tint-50)", edge: "var(--green-tint-200)" },
        warning: { DEFAULT: "var(--warning)", tint: "var(--amber-tint-50)", edge: "var(--amber-tint-200)" },
        info: { DEFAULT: "var(--info)", tint: "var(--info-tint)" },
      },
      borderRadius: { lg: "8px", xl: "10px" },
      fontFamily: { sans: ["Inter", "Segoe UI", "ui-sans-serif", "system-ui", "sans-serif"], mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"] },
      fontSize: { "2xs": ["11px", "14px"] },
    },
  },
  plugins: [],
};
export default config;
