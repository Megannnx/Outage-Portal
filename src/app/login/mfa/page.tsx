"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { Button, ErrorNote, Field, inputCls } from "@/components/ui";
export default function Mfa() {
  const [code, setCode] = useState(""); const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api("/api/auth/mfa/verify", { body: { code } }); const n = new URLSearchParams(location.search).get("next"); location.href = n && n.startsWith("/") && !n.startsWith("//") ? n : "/"; }
    catch (e) { setErr((e as Error).message); }
  }
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6">
        <h1 className="text-[16px] font-bold">Two-factor authentication</h1>
        <p className="text-[13px] text-ink-secondary">Enter the 6-digit code from your authenticator app.</p>
        <ErrorNote error={err} />
        <Field label="Code"><input className={`${inputCls} tabular text-center text-[20px] tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></Field>
        <Button variant="primary" size="lg" className="w-full">Verify</Button>
      </form>
    </main>
  );
}
