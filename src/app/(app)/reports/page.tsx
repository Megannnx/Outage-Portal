import { redirect } from "next/navigation";
import { currentUser } from "@/server/auth/session";
import { Reports } from "@/components/Reports";
export const dynamic = "force-dynamic";
export default async function ReportsPage() {
  const u = await currentUser();
  if (u?.role !== "admin") redirect("/");
  return <Reports />;
}
