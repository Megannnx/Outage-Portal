"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { Button, ErrorNote, Field, inputCls } from "@/components/ui";

/** Public page linked from the dispatch email: the technician acknowledges with one tap. */
export default function Ack({ params }: { params: { token: string } }) {
  const [name, setName] = useState(""); const [done, setDone] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { const r = await api<{ reference: string }>("/api/dispatch-ack", { body: { token: params.token, name } }); setDone(r.reference); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6">
        <div className="flex items-center gap-2"><span className="h-6 w-1.5 rounded bg-primary" /><span className="text-[18px] font-extrabold">ATEC</span><span className="text-ink-muted">Dispatch</span></div>
        {done ? <div className="space-y-2"><div className="text-[18px] font-bold text-success">Acknowledged ✓</div><p className="text-[13px] text-ink-secondary">Dispatch {done} is marked as acknowledged. The Service Desk can see this now.</p></div> : (
          <>
            <h1 className="text-[16px] font-bold">Acknowledge urgent dispatch</h1>
            <ErrorNote error={err} />
            <Field label="Your name"><input className={inputCls} required minLength={2} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Button variant="primary" size="lg" className="w-full">I&apos;m on it</Button>
          </>
        )}
      </form>
    </main>
  );
}
