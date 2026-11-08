import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/auth";
import { Console } from "@/components/console";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function Dashboard({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section = [] } = await params;
  if (
    section.length > 1 ||
    (section.length === 1 &&
      !["commands", "logs", "approval", "webhook", "settings"].includes(
        section[0],
      ))
  )
    notFound();
  let name = "管理员";
  try {
    const account = await requireAdmin(await headers());
    name = account.user.name;
  } catch (error) {
    if (error instanceof AuthError)
      redirect(
        `/login?reason=${error.status === 403 ? "forbidden" : error.status === 503 ? "unavailable" : "signin"}`,
      );
    throw error;
  }
  return (
    <Suspense>
      <Console userName={name} sso={process.env.PLATFORM_AUTH_MODE === 'sso'} />
    </Suspense>
  );
}
