"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  {
    href: "/admin/overview",
    label: "总览",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    href: "/admin/tasks",
    label: "任务",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="14" y2="18" />
      </svg>
    ),
  },
  {
    href: "/admin/products",
    label: "产品与手卡",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l8 4.3v9.4L12 21l-8-4.3V7.3L12 3z" />
        <path d="M4 7.3L12 11.6l8-4.3" />
        <path d="M12 11.6V21" />
      </svg>
    ),
  },
  {
    href: "/admin/providers",
    label: "Provider 设置",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3v4.5" />
        <path d="M15 3v4.5" />
        <path d="M6 7.5h12v3.5a6 6 0 01-12 0V7.5z" />
        <path d="M12 17v4" />
      </svg>
    ),
  },
  {
    href: "/admin/feishu",
    label: "飞书设置",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 5h16v10.5H8.5L4 19V5z" />
      </svg>
    ),
  },
  {
    href: "/admin/field-mapping",
    label: "字段映射",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7h4l9 10h5" />
        <path d="M3 17h4l2.2-2.5" />
        <path d="M13.5 7H21" />
        <path d="M18 4.2L21 7l-3 2.8" />
        <path d="M18 19.8L21 17l-3-2.8" />
      </svg>
    ),
  },
  {
    href: "/admin/learning",
    label: "学习中心",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.7 4.8L18.5 9l-4.8 1.7L12 15.5l-1.7-4.8L5.5 9l4.8-1.7L12 3z" />
        <path d="M19 14.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" />
      </svg>
    ),
  },
  {
    href: "/admin/prompts",
    label: "Prompt 调试",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7.5 9.5l3 2.5-3 2.5" />
        <path d="M13 14.5h4" />
      </svg>
    ),
  },
];

export function AdminSidebar({ mysqlLabel }: { mysqlLabel: string }) {
  const pathname = usePathname();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 232,
        flex: "0 0 232px",
        padding: "18px 12px",
        background: "var(--sidebar-bg)",
        borderRight: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px 22px" }}>
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: 32,
            height: 32,
            borderRadius: 9,
            background: "linear-gradient(145deg,#ff7a52,#ff5a36)",
            boxShadow: "0 6px 16px rgba(255,90,54,.3)",
            flex: "0 0 32px",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 3l14 9-14 9V3z" />
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: "-.01em", color: "#fff" }}>爆片分析</div>
          <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".14em", color: "var(--text-faint)", textTransform: "uppercase", marginTop: 2 }}>
            运维后台 · Ops Console
          </div>
        </div>
      </div>

      <nav style={{ display: "grid", gap: 3 }}>
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link key={item.href} href={item.href} className={`admin-navrow${active ? " active" : ""}`}>
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div style={{ marginTop: "auto", display: "grid", gap: 10 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: 10,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--surface)",
          }}
        >
          <span className="admin-dot" style={{ background: "var(--success)", boxShadow: "0 0 0 3px var(--success-soft)" }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)" }}>本地开发环境</div>
            <div style={{ fontSize: 9, color: "var(--text-faint)", marginTop: 1, fontFamily: "var(--mono)" }}>{mysqlLabel}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
