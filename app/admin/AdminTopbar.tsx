export function AdminTopbar({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 58,
        padding: "0 28px",
        borderBottom: "1px solid var(--border)",
        flex: "0 0 auto",
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 750 }}>{title}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {right}
      </div>
    </div>
  );
}
