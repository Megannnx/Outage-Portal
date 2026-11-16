"use client";
import clsx from "clsx";
import { useEffect, useRef, type ReactNode, type ButtonHTMLAttributes } from "react";
import { X } from "lucide-react";

export function Button({ variant = "secondary", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "success"; size?: "sm" | "md" | "lg" | "xl" }) {
  return (
    <button {...p} className={clsx(
      "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none",
      size === "sm" && "h-8 px-3 text-[13px]", size === "md" && "h-9 px-3.5", size === "lg" && "h-11 px-4 text-[15px]", size === "xl" && "min-h-[64px] px-4 py-3 text-[15px] text-left justify-start",
      variant === "primary" && "bg-primary text-white hover:bg-primary-hover",
      variant === "danger" && "bg-primary text-white hover:bg-primary-hover",
      variant === "success" && "bg-success text-black hover:opacity-90",
      variant === "secondary" && "bg-surface-2 text-ink border border-line hover:border-ink-muted",
      variant === "ghost" && "text-ink-secondary hover:text-ink hover:bg-surface-2",
      className)} />
  );
}

const TONES = {
  red: "bg-primary-tint text-primary-bright border-primary-edge",
  amber: "bg-warning-tint text-warning border-warning-edge",
  green: "bg-success-tint text-success border-success-edge",
  grey: "bg-surface-2 text-ink-secondary border-line",
  solid: "bg-primary text-white border-primary",
} as const;
export type Tone = keyof typeof TONES;
export function Badge({ tone = "grey", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide", TONES[tone], className)}>{children}</span>;
}

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  validating: { label: "Validating outage", tone: "amber" },
  awaiting_cause: { label: "Awaiting cause", tone: "solid" },
  power_area: { label: "Power outage — area", tone: "amber" },
  technician_required: { label: "Technician required", tone: "solid" },
  technician_investigating: { label: "Technician investigating", tone: "red" },
  awaiting_backhaul: { label: "Awaiting backhaul update", tone: "red" },
  under_investigation: { label: "Under investigation", tone: "red" },
  restoring: { label: "Restoring — checking stability", tone: "amber" },
  restored_awaiting_rfo: { label: "Restored — awaiting RFO", tone: "green" },
  resolved: { label: "Resolved", tone: "grey" },
  interruption: { label: "Short interruption", tone: "grey" },
};
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "grey" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Card({ title, actions, children, className, tone }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; tone?: "danger" }) {
  return (
    <section className={clsx("min-w-0 rounded-xl border bg-surface", tone === "danger" ? "border-primary" : "border-line", className)}>
      {title && <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5"><h3 className="text-[12px] font-bold uppercase tracking-wider text-ink-secondary">{title}</h3>{actions}</header>}
      <div className="p-3.5">{children}</div>
    </section>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, textarea, input, select")?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => { window.removeEventListener("keydown", k); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" className={clsx("flex max-h-[92vh] w-full flex-col rounded-t-xl border border-line bg-surface shadow-2xl sm:rounded-xl", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3"><h2 className="text-[15px] font-bold">{title}</h2><button aria-label="Close" onClick={onClose} className="rounded p-1 text-ink-muted hover:text-ink"><X size={18} /></button></header>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: ReactNode; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-semibold text-ink-secondary">{label}</span>
      {children}
      {hint && <span className="block text-2xs text-ink-muted">{hint}</span>}
      {error && <span className="block text-2xs text-primary-bright">{error}</span>}
    </label>
  );
}
export const inputCls = "w-full rounded-lg border border-line bg-background px-3 py-2 text-[14px] text-ink placeholder:text-ink-muted focus:border-ink-muted focus:outline-none";

export function MessagePreview({ subject, body, label }: { subject?: string; body?: string; label?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-background">
      {label && <div className="border-b border-line px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</div>}
      {subject && <div className="border-b border-line px-3 py-2 text-[13px] font-semibold">{subject}</div>}
      <pre className="whitespace-pre-wrap px-3 py-2.5 font-sans text-[13px] leading-relaxed text-ink-secondary">{body}</pre>
    </div>
  );
}

export function ErrorNote({ error }: { error: { message: string } | string | null | undefined }) {
  if (!error) return null;
  return <div role="alert" className="rounded-lg border border-primary-edge bg-primary-tint px-3 py-2 text-[13px] text-primary-bright">{typeof error === "string" ? error : error.message}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-[13px] text-ink-muted">{children}</div>;
}
