import { redirect } from "next/navigation";
import { currentUser } from "@/server/auth/session";
import { AppShell } from "@/components/AppShell";
export const dynamic = "force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const u = await currentUser();
  if (!u) redirect("/login");
  if (u.mfaEnabled && !u.mfaVerified) redirect("/login/mfa");
  if (u.mfaRequired && !u.mfaEnabled) redirect("/account/mfa");
  return <AppShell user={{ name: u.name, role: u.role }}>{children}</AppShell>;
}
