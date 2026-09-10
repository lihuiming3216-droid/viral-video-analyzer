import { countProducts, listProducts } from "@/lib/database";
import { AdminTopbar } from "../AdminTopbar";
import { Pagination } from "../Pagination";
import { randomUUID } from "node:crypto";
import { requireAdmin } from "@/lib/require-admin";
import { ReorganizeForm } from "./ReorganizeForm";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

export default async function AdminProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireAdmin();
  const { q, page: pageParam } = await searchParams;
  const search = q?.trim() || "";
  const page = Math.max(1, Number(pageParam) || 1);

  const [products, total, withCardTotal] = await Promise.all([
    listProducts({ excludeSystem: true, search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countProducts({ excludeSystem: true, search }),
    listProducts({ excludeSystem: true }),
  ]);
  const withCard = withCardTotal.filter((product) => product.documentUrl).length;
  const pending = withCardTotal.length - withCard;

  return (
    <>
      <AdminTopbar title="产品与手卡" right={<span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>共 {withCardTotal.length} 个产品</span>} />

      <div style={{ flex: 1, padding: "24px 28px 40px", overflow: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }}>
          <div className="admin-card" style={{ padding: "16px 18px" }}>
            <div style={{ fontSize: 10, color: "var(--text-faint)" }}>产品总数</div>
            <div style={{ marginTop: 8, fontSize: 24, fontWeight: 800, fontFamily: "var(--mono)" }}>{withCardTotal.length}</div>
          </div>
          <div className="admin-card" style={{ padding: "16px 18px" }}>
            <div style={{ fontSize: 10, color: "var(--text-faint)" }}>已建手卡</div>
            <div style={{ marginTop: 8, fontSize: 24, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--success)" }}>{withCard}</div>
          </div>
          <div className="admin-card" style={{ padding: "16px 18px" }}>
            <div style={{ fontSize: 10, color: "var(--text-faint)" }}>待补录手卡</div>
            <div style={{ marginTop: 8, fontSize: 24, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--warning)" }}>{pending}</div>
          </div>
        </div>

        <ReorganizeForm requestId={randomUUID()} />
        <form action="/admin/products" method="get" style={{ marginBottom: 14 }}>
          <input
            type="text"
            name="q"
            defaultValue={search}
            placeholder="按产品名称或 PID 搜索…"
            style={{
              width: 320, height: 34, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 8,
              background: "var(--surface-2)", color: "var(--text)", fontSize: 12,
            }}
          />
          {search && (
            <a href="/admin/products" style={{ marginLeft: 10, fontSize: 11, color: "var(--text-faint)" }}>清除搜索</a>
          )}
        </form>

        <div className="admin-card" style={{ overflow: "hidden" }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>产品名称</th>
                <th>品类</th>
                <th>关联手卡</th>
                <th>视频数</th>
                <th>最近更新</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td style={{ fontFamily: "var(--mono)", color: "var(--text-muted)" }}>{product.pid || "—"}</td>
                  <td style={{ fontWeight: 650 }}>{product.name}</td>
                  <td style={{ color: "var(--text-muted)" }}>{product.category || "—"}</td>
                  <td>
                    {product.documentUrl ? (
                      <a href={product.documentUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                        {product.name}_{product.pid} ↗
                      </a>
                    ) : (
                      <span className="admin-badge" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>待补录</span>
                    )}
                  </td>
                  <td style={{ fontFamily: "var(--mono)" }}>{product.videoCount}</td>
                  <td style={{ color: "var(--text-faint)", fontFamily: "var(--mono)" }}>{new Date(product.updatedAt).toLocaleString("zh-CN", { hour12: false })}</td>
                </tr>
              ))}
              {!products.length && (
                <tr>
                  <td colSpan={6} style={{ color: "var(--text-faint)", textAlign: "center", padding: 24 }}>
                    {search ? "没有匹配的产品" : "还没有产品"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <Pagination basePath="/admin/products" params={{ q: search || undefined }} page={page} pageSize={PAGE_SIZE} total={total} />
      </div>
    </>
  );
}
