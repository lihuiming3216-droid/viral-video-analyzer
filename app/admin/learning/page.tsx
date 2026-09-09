import { getLearningOverview } from "@/lib/learning";
import { AdminTopbar } from "../AdminTopbar";

export const dynamic = "force-dynamic";

export default async function AdminLearningPage() {
  const overview = await getLearningOverview();
  const productProfiles = overview.profiles.filter((profile) => profile.scopeType === "product" && profile.sampleCount > 0);

  return (
    <>
      <AdminTopbar title="学习中心" />

      <div style={{ flex: 1, padding: "24px 28px 40px", overflow: "auto" }}>
        <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 10 }}>全局画像</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14, marginBottom: 24 }}>
          <StatTile label="样本总数" value={overview.learnedVideos} />
          <StatTile label="已标注" value={overview.labeledVideos} />
          <StatTile label="优质数量" value={overview.positiveVideos} color="var(--success)" />
          <StatTile label="覆盖品类" value={overview.categories} />
          <StatTile label="综合置信度" value={overview.overallConfidence} color="var(--accent-strong)" />
        </div>

        <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 10 }}>按产品分组（共 {productProfiles.length} 个有样本的产品）</div>
        <div style={{ display: "grid", gap: 12 }}>
          {productProfiles.map((profile) => (
            <div key={profile.scopeKey} className="admin-card" style={{ padding: "16px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, fontWeight: 750 }}>{profile.scopeName}</span>
                <span style={{ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>
                  样本 {profile.sampleCount} · 置信度 {profile.confidence}
                </span>
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {profile.insights.provenStrengths.slice(0, 3).map((item) => (
                  <span key={item.name} className="admin-badge" style={{ color: "var(--success)", border: "1px solid rgba(44,200,135,.3)", background: "transparent" }}>{item.name}</span>
                ))}
                {profile.insights.riskPatterns.slice(0, 2).map((item) => (
                  <span key={item.name} className="admin-badge" style={{ color: "var(--danger)", border: "1px solid rgba(255,92,92,.3)", background: "transparent" }}>{item.name}</span>
                ))}
                {!profile.insights.provenStrengths.length && !profile.insights.riskPatterns.length && (
                  <span style={{ fontSize: 11, color: "var(--text-faint)" }}>暂无足够样本沉淀洞察</span>
                )}
              </div>
            </div>
          ))}
          {!productProfiles.length && <div style={{ fontSize: 12, color: "var(--text-faint)" }}>还没有产品积累到学习样本</div>}
        </div>
      </div>
    </>
  );
}

function StatTile({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="admin-card" style={{ padding: "16px 18px" }}>
      <div style={{ fontSize: 10, color: "var(--text-faint)" }}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 22, fontWeight: 800, fontFamily: "var(--mono)", color: color || "var(--text)" }}>{value}</div>
    </div>
  );
}
