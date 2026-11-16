"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { Button, ErrorNote, Field, inputCls } from "@/components/ui";

export default function Login() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api<{ mfaPending: boolean }>("/api/auth/login", { body: { email, password } });
      const next = new URLSearchParams(location.search).get("next");
      location.href = r.mfaPending ? `/login/mfa${next ? `?next=${encodeURIComponent(next)}` : ""}` : next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6">
        <div>
          <div className="mb-4 flex items-center gap-2"><span className="h-6 w-1.5 rounded bg-primary" /><span className="text-[18px] font-extrabold tracking-tight">ATEC</span><span className="text-ink-muted">Outage Operations</span></div>
          <h1 className="text-[15px] font-semibold text-ink-secondary">Sign in</h1>
        </div>
        <ErrorNote error={err} />
        <Field label="Email"><input className={inputCls} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
        <Field label="Password"><input className={inputCls} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button variant="primary" size="lg" className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
    </main>
  );
}
