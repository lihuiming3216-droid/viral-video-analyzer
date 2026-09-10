import "server-only";
import { headers } from "next/headers";
import { checkAdminAuthorization } from "@/lib/admin-auth";

export async function requireAdmin() {
  const request = await headers();
  if (await checkAdminAuthorization(request.get("authorization"), request.get("x-real-ip") || "unknown") !== "ok") {
    throw new Error("请先登录后台");
  }
}
