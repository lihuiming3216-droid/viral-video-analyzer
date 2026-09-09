import "server-only";

import { createProduct, listProducts, updateProduct } from "@/lib/database";

/**
 * Shared by every Feishu entry point (bot message, task-table webhook) that
 * needs to resolve "product name + optional PID" down to one product row,
 * creating it on first mention.
 */
export async function findOrCreateProduct(name: string, pid: string) {
  const products = await listProducts();
  if (pid) {
    const byPid = products.find((product) => product.pid && product.pid.toLowerCase() === pid.toLowerCase());
    if (byPid) return byPid;
  }
  const sameName = products.filter((product) => product.name.trim().toLowerCase() === name.trim().toLowerCase());
  const compatible = sameName.find((product) => !pid || !product.pid || product.pid.toLowerCase() === pid.toLowerCase());
  if (compatible) {
    if (pid && !compatible.pid) return (await updateProduct(compatible.id, { pid }))!;
    return compatible;
  }
  return createProduct({ name, pid, category: "飞书待补充", notes: "由飞书自动接入自动创建" });
}
