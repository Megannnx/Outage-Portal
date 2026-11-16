import { currentUser } from "@/server/auth/session";
import { OperationsWorkspace } from "@/components/ops/OperationsWorkspace";
export const dynamic = "force-dynamic";
export default async function Page() {
  const u = await currentUser();
  return <OperationsWorkspace role={u!.role} />;
}
