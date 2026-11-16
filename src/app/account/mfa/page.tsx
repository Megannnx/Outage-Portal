"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Button, ErrorNote, Field, inputCls } from "@/components/ui";
export default function MfaSetup() {
  const [s, setS] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState(""); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState(false);
  useEffect(() => { api<{ secret: string; otpauth: string }>("/api/auth/mfa/setup").then(setS).catch((e) => setErr(e.message)); }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api("/api/auth/mfa/setup", { body: { code } }); setDone(true); setTimeout(() => (location.href = "/"), 800); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-xl border border-line bg-surface p-6">
        <h1 className="text-[16px] font-bold">Set up two-factor authentication</h1>
        <p className="text-[13px] text-ink-secondary">Your role requires two-factor authentication. Add this account to an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…) using the setup key, then enter the code it shows.</p>
        <ErrorNote error={err} />
        {s && <div className="space-y-2 rounded-lg border border-line bg-background p-3">
          <div className="text-2xs uppercase tracking-wide text-ink-muted">Setup key</div>
          <code className="block break-all font-mono text-[15px] tracking-wider">{s.secret.match(/.{1,4}/g)?.join(" ")}</code>
          <a className="text-[12px] text-primary-bright underline" href={s.otpauth}>Open in authenticator app (mobile)</a>
        </div>}
        <Field label="6-digit code"><input className={`${inputCls} tabular text-center text-[20px] tracking-[0.4em]`} inputMode="numeric" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Button variant="primary" size="lg" className="w-full" disabled={done}>{done ? "Enabled ✓" : "Enable"}</Button>
      </form>
    </main>
  );
}
