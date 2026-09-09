import "./admin.css";
import { AdminSidebar } from "./AdminSidebar";

export const metadata = {
  title: "爆片分析 · 运维后台",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const mysqlLabel = `MySQL · ${process.env.MYSQL_HOST || "127.0.0.1"}:${process.env.MYSQL_PORT || 3306}`;

  return (
    <div className="admin-root">
      <AdminSidebar mysqlLabel={mysqlLabel} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}
