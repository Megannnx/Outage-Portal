"use client";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Templates } from "./Templates";
import { Policies, Recipients, Sites, System, Users } from "./Config";

const TABS = [
  { key: "templates", label: "Communication templates" }, { key: "sites", label: "Sites & monitoring" }, { key: "recipients", label: "ISPs & contacts" },
  { key: "policies", label: "Policies & escalations" }, { key: "users", label: "Users" }, { key: "system", label: "System health & audit" },
];
export function AdminTabs({ me }: { me: string }) {
  const [tab, setTab] = useState("templates");
  useEffect(() => {
    const sync = () => { const t = location.hash.slice(1); if (TABS.some((x) => x.key === t)) setTab(t); };
    sync(); window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return (
    <div className="mx-auto max-w-[1500px] p-4">
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => <button key={t.key} onClick={() => { setTab(t.key); history.replaceState(null, "", `#${t.key}`); }} className={clsx("whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-semibold", tab === t.key ? "border-primary text-ink" : "border-transparent text-ink-secondary hover:text-ink")}>{t.label}</button>)}
      </div>
      {tab === "templates" && <Templates me={me} />}
      {tab === "sites" && <Sites />}
      {tab === "recipients" && <Recipients />}
      {tab === "policies" && <Policies />}
      {tab === "users" && <Users />}
      {tab === "system" && <System />}
    </div>
  );
}
