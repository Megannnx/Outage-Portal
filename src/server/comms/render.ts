/**
 * Strict template renderer.
 *
 *   {{name}}              insert a verified value — rendering FAILS if it is missing
 *   {{#name}}…{{/name}}   section shown only when the value is present
 *   {{^name}}…{{/name}}   section shown only when the value is absent
 *
 * The renderer never rewrites wording: the output is the approved text with
 * placeholders substituted. Unknown placeholders are rejected at approval time
 * and again at render time.
 */
import { PLACEHOLDERS, type Placeholder, kindDef } from "../domain/catalog";

export type Vars = Partial<Record<Placeholder, string | null | undefined>>;

export class MissingValueError extends Error {
  constructor(public placeholder: string) { super(`No verified value for {{${placeholder}}}`); }
}

type Node =
  | { t: "text"; v: string }
  | { t: "var"; name: string }
  | { t: "section"; name: string; inverted: boolean; children: Node[] };

const TOKEN = /\{\{\s*([#^/]?)\s*([a-z_]+)\s*\}\}/g;

export function parseTemplate(src: string): Node[] {
  const root: Node[] = [];
  const stack: { name: string; children: Node[] }[] = [{ name: "", children: root }];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    const [whole, sigil, name] = m;
    const idx = m.index!;
    if (idx > last) stack[stack.length - 1].children.push({ t: "text", v: src.slice(last, idx) });
    last = idx + whole.length;
    if (sigil === "#" || sigil === "^") {
      const node: Node = { t: "section", name, inverted: sigil === "^", children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push({ name, children: node.children });
    } else if (sigil === "/") {
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`Unbalanced section: {{/${name}}}`);
    } else {
      stack[stack.length - 1].children.push({ t: "var", name });
    }
  }
  if (stack.length !== 1) throw new Error(`Unclosed section: {{#${stack[stack.length - 1].name}}}`);
  if (last < src.length) root.push({ t: "text", v: src.slice(last) });
  // Stray braces usually mean a typo such as {{ site name }}.
  const leftover = src.replace(TOKEN, "");
  if (/\{\{|\}\}/.test(leftover)) throw new Error("Malformed placeholder — use {{placeholder_name}}");
  return root;
}

function collect(nodes: Node[], out: { vars: Set<string>; unconditional: Set<string> }, guarded: Set<string>) {
  for (const n of nodes) {
    if (n.t === "var") {
      out.vars.add(n.name);
      if (!guarded.has(n.name)) out.unconditional.add(n.name);
    } else if (n.t === "section") {
      out.vars.add(n.name);
      const g = new Set(guarded);
      if (!n.inverted) g.add(n.name);
      collect(n.children, out, g);
    }
  }
}

export interface TemplateCheck { ok: boolean; errors: string[]; placeholders: string[]; unconditional: string[] }

/** Validation run before a version can be submitted or approved. */
export function checkTemplate(kind: string, subject: string, body: string): TemplateCheck {
  const errors: string[] = [];
  const vars = new Set<string>(), unconditional = new Set<string>();
  for (const [label, src] of [["Subject", subject], ["Body", body]] as const) {
    try {
      collect(parseTemplate(src), { vars, unconditional }, new Set());
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  }
  for (const v of vars) if (!(v in PLACEHOLDERS)) errors.push(`Unknown placeholder {{${v}}}`);
  for (const r of kindDef(kind).required) if (!vars.has(r)) errors.push(`This template must include {{${r}}}`);
  if (!body.trim()) errors.push("Body is empty");
  if (!subject.trim()) errors.push("Subject is empty");
  return { ok: errors.length === 0, errors, placeholders: [...vars], unconditional: [...unconditional] };
}

function present(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function renderNodes(nodes: Node[], vars: Vars): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "var") {
      if (!(n.name in PLACEHOLDERS)) throw new Error(`Unknown placeholder {{${n.name}}}`);
      const v = vars[n.name as Placeholder];
      if (!present(v)) throw new MissingValueError(n.name);
      out += v;
    } else {
      const has = present(vars[n.name as Placeholder]);
      if (has !== n.inverted) out += renderNodes(n.children, vars);
    }
  }
  return out;
}

export function render(src: string, vars: Vars): string {
  return renderNodes(parseTemplate(src), vars)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${esc
    .split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
}
