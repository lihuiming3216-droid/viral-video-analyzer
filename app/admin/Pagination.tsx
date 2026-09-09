function buildHref(basePath: string, params: Record<string, string | number | undefined>, page: number) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  query.set("page", String(page));
  return `${basePath}?${query.toString()}`;
}

/** Server-rendered prev/next pager driven entirely by URL query params — no client JS needed. */
export function Pagination({
  basePath,
  params,
  page,
  pageSize,
  total,
}: {
  basePath: string;
  params: Record<string, string | number | undefined>;
  page: number;
  pageSize: number;
  total: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, fontSize: 11.5, color: "var(--text-faint)" }}>
      <span style={{ fontFamily: "var(--mono)" }}>
        第 {from}–{to} 条 · 共 {total} 条 · 第 {page}/{totalPages} 页
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <a
          href={page > 1 ? buildHref(basePath, params, page - 1) : undefined}
          aria-disabled={page <= 1}
          style={{
            height: 30, padding: "0 14px", display: "flex", alignItems: "center", borderRadius: 7,
            border: "1px solid var(--border)", fontWeight: 700,
            color: page > 1 ? "var(--text)" : "var(--text-faint)",
            pointerEvents: page > 1 ? "auto" : "none",
            background: "var(--surface-2)",
          }}
        >
          ← 上一页
        </a>
        <a
          href={page < totalPages ? buildHref(basePath, params, page + 1) : undefined}
          aria-disabled={page >= totalPages}
          style={{
            height: 30, padding: "0 14px", display: "flex", alignItems: "center", borderRadius: 7,
            border: "1px solid var(--border)", fontWeight: 700,
            color: page < totalPages ? "var(--text)" : "var(--text-faint)",
            pointerEvents: page < totalPages ? "auto" : "none",
            background: "var(--surface-2)",
          }}
        >
          下一页 →
        </a>
      </div>
    </div>
  );
}
