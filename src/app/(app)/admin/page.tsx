import { redirect } from "next/navigation";
import { currentUser } from "@/server/auth/session";
import { AdminTabs } from "@/components/admin/AdminTabs";
export const dynamic = "force-dynamic";
export default async function AdminPage() {
  const u = await currentUser();
  if (u?.role !== "admin") redirect("/");
  return <AdminTabs me={u.id} />;
}
