"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Button, ErrorNote, Field, inputCls } from "@/components/ui";

export default function Setup() {
  const [state, setState] = useState<"loading" | "open" | "done">("loading");
  const [f, setF] = useState({ name: "", email: "", password: "", confirm: "", demo: true });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ needsFirstAdmin: boolean }>("/api/setup").then((r) => setState(r.needsFirstAdmin ? "open" : "done")).catch((e) => setErr(e.message)); }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    if (f.password !== f.confirm) return setErr("Passwords do not match");
    setBusy(true);
    try { await api("/api/setup", { body: { name: f.name, email: f.email, password: f.password, demo: f.demo } }); location.href = "/login"; }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-xl border border-line bg-surface p-6">
        <div className="flex items-center gap-2"><span className="h-6 w-1.5 rounded bg-primary" /><span className="text-[18px] font-extrabold">ATEC</span><span className="text-ink-muted">Outage Operations — first-time setup</span></div>
        {state === "loading" && <p className="text-ink-muted">Checking…</p>}
        {state === "done" && <p className="text-[13px]">Setup is already complete. <a className="underline" href="/login">Sign in</a>.</p>}
        {state === "open" && (
          <>
            <p className="text-[13px] text-ink-secondary">Create the first administrator. This page only works once — after that, administrators add users in Admin › Users. You will set up two-factor authentication on first sign-in.</p>
            <ErrorNote error={err} />
            <Field label="Your name"><input className={inputCls} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Email"><input className={inputCls} type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Password" hint="At least 12 characters"><input className={inputCls} type="password" required minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            <Field label="Confirm password"><input className={inputCls} type="password" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
            <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-1" checked={f.demo} onChange={(e) => setF({ ...f, demo: e.target.checked })} />
              <span>Load demo sites and ISPs, and publish the starter message wording, so you can try the portal straight away with the outage simulator. (Only works in capture mode — nothing is sent. Remove demo data before going live.)</span></label>
            <Button variant="primary" size="lg" className="w-full" disabled={busy}>{busy ? "Setting up the database…" : "Create administrator"}</Button>
          </>
        )}
      </form>
    </main>
  );
}
