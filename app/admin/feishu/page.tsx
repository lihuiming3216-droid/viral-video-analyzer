import { revalidatePath } from "next/cache";
import { encryptSecret } from "@/lib/crypto";
import { getFeishuRuntimeStatus, restartFeishuConnection, stopFeishuConnection } from "@/lib/feishu/runtime";
import { getRawFeishuSettings, saveFeishuSettings } from "@/lib/feishu/store";
import { AdminTopbar } from "../AdminTopbar";

export const dynamic = "force-dynamic";

async function saveFeishuAction(formData: FormData) {
  "use server";
  const enabled = formData.get("enabled") === "on";
  const appSecret = String(formData.get("appSecret") || "").trim();
  const clearSecret = formData.get("clearSecret") === "on";
  const settings = await saveFeishuSettings({
    appId: String(formData.get("appId") || "").trim(),
    encryptedAppSecret: clearSecret ? null : appSecret ? encryptSecret(appSecret) : undefined,
    enabled,
    publicBaseUrl: String(formData.get("publicBaseUrl") || "").trim(),
    rootFolderToken: String(formData.get("rootFolderToken") || "").trim(),
    productFolderToken: String(formData.get("productFolderToken") || "").trim(),
  });
  try {
    if (enabled && settings.hasAppSecret) await restartFeishuConnection();
    else if (!enabled) await stopFeishuConnection();
  } catch {
    // 连接失败的详情已经写进 feishu_settings.last_error，页面刷新后会显示。
  }
  revalidatePath("/admin/feishu");
}

const CONNECTION_LABEL: Record<string, string> = {
  connected: "已连接",
  connecting: "连接中",
  reconnecting: "重连中",
  disconnected: "未连接",
  failed: "连接失败",
};

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 0", borderBottom: "1px solid var(--border)", fontSize: 11.5 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{value}</span>
    </div>
  );
}

export default async function AdminFeishuPage() {
  const [status, raw] = await Promise.all([getFeishuRuntimeStatus(), getRawFeishuSettings()]);
  const connectionOk = status.connectionStatus === "connected";

  return (
    <>
      <AdminTopbar title="飞书设置" />
      <div style={{ flex: 1, padding: "24px 28px 40px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 1040, overflow: "auto" }}>
        <form action={saveFeishuAction} className="admin-card" style={{ padding: "20px 22px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <span style={{ fontSize: 13.5, fontWeight: 750 }}>应用配置</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: connectionOk ? "var(--success)" : "var(--text-faint)", fontWeight: 700 }}>
              <span className="admin-dot" style={{ background: connectionOk ? "var(--success)" : "var(--text-faint)" }} />
              {CONNECTION_LABEL[status.connectionStatus] || status.connectionStatus}
            </span>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase" }}>App ID</div>
              <input name="appId" defaultValue={status.appId} style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase" }}>
                App Secret {status.hasAppSecret ? "（已配置，留空表示不修改）" : "（未配置）"}
              </div>
              <input name="appSecret" type="password" placeholder={status.hasAppSecret ? "••••••••••••" : "输入 App Secret"} style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase" }}>公开访问地址</div>
              <input name="publicBaseUrl" defaultValue={status.publicBaseUrl} style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase" }}>报告归档根目录 Token</div>
              <input name="rootFolderToken" defaultValue={status.rootFolderToken} style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase" }}>产品说明文档文件夹 Token</div>
              <input name="productFolderToken" defaultValue={status.productFolderToken} style={inputStyle} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
                <input type="checkbox" name="enabled" defaultChecked={status.enabled} /> 启用飞书连接
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
                <input type="checkbox" name="clearSecret" /> 清除已保存的 Secret
              </label>
            </div>
          </div>
          {status.lastError && (
            <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--danger-soft)", borderRadius: 10, fontSize: 12, color: "var(--danger)" }}>
              {status.lastError}
            </div>
          )}
          <button type="submit" style={{ marginTop: 16, height: 32, padding: "0 16px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
            保存并重连
          </button>
        </form>

        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <div className="admin-card" style={{ padding: "20px 22px" }}>
            <div style={{ fontSize: 13.5, fontWeight: 750, marginBottom: 16 }}>Webhook</div>
            <Kv label="Webhook Secret 已配置" value={process.env.FEISHU_AUTOMATION_WEBHOOK_SECRET ? "是" : "否（环境变量未设置）"} />
            <Kv label="/api/feishu/automation" value="见服务端日志" />
            <Kv label="/api/feishu/product-doc-sync" value="见服务端日志" />
          </div>

          <div className="admin-card" style={{ padding: "20px 22px" }}>
            <div style={{ fontSize: 13.5, fontWeight: 750, marginBottom: 16 }}>长连接状态</div>
            <Kv label="连接状态" value={CONNECTION_LABEL[status.connectionStatus] || status.connectionStatus} />
            <Kv label="最近连接时间" value={status.connectedAt ? new Date(status.connectedAt).toLocaleString("zh-CN", { hour12: false }) : "—"} />
            <Kv label="配置更新时间" value={new Date(raw.updated_at as string).toLocaleString("zh-CN", { hour12: false })} />
          </div>
        </div>
      </div>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 36,
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface-2)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 12,
};
