import { listProviderSettings, listQwenPurposeModels } from "@/lib/database";
import {
  QWEN_TRANSLATION_MODEL_SUGGESTIONS,
  QWEN_VIDEO_MODEL_OPTIONS,
  resolveQwenModel,
  type QwenModelSource,
} from "@/lib/providers/qwen";
import type { ProviderName } from "@/lib/types";
import { AdminTopbar } from "../AdminTopbar";
import { saveProviderAction, saveQwenPurposeModelsAction } from "./actions";
import { QWEN_PURPOSES } from "./qwen-purposes";
import { TestConnectionButton } from "./TestConnectionButton";

const QWEN_MODEL_SOURCE_LABELS: Record<QwenModelSource, string> = {
  env: "环境变量 QWEN_VIDEO_MODEL（最高优先级，会覆盖这里保存的所有配置）",
  override: "本页为该用途单独保存的配置",
  default: "沿用上方 Qwen 卡片里的默认模型",
  hardcoded: "以上均未配置或不满足白名单，回退到代码内置兜底值",
};

export const dynamic = "force-dynamic";

const PROVIDER_META: Array<{ provider: ProviderName; label: string }> = [
  { provider: "tokscript", label: "TokScript" },
  { provider: "qwen", label: "Qwen · DashScope" },
];

export default async function AdminProvidersPage() {
  const settings = await listProviderSettings();
  const purposeModels = await listQwenPurposeModels();
  const qwenSetting = settings.find((item) => item.provider === "qwen");
  const qwenDefault = qwenSetting?.model || "qwen3.5-omni-plus";
  const envModelOverride = (process.env.QWEN_VIDEO_MODEL || "").trim();
  const purposeResolutions = await Promise.all(
    QWEN_PURPOSES.map((item) => resolveQwenModel(item.key, qwenDefault)),
  );

  return (
    <>
      <AdminTopbar title="Provider 设置" />
      <div style={{ flex: 1, padding: "24px 28px 40px", display: "grid", gap: 16, maxWidth: 820, overflow: "auto" }}>
        {PROVIDER_META.map((meta) => {
          const setting = settings.find((item) => item.provider === meta.provider);
          return (
            <div key={meta.provider} className="admin-card" style={{ padding: "20px 22px" }}>
              <form action={saveProviderAction}>
                <input type="hidden" name="provider" value={meta.provider} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 750 }}>{meta.label}</span>
                    <span
                      className="admin-badge"
                      style={{
                        background: setting?.enabled ? "var(--success-soft)" : "var(--surface-2)",
                        color: setting?.enabled ? "var(--success)" : "var(--text-faint)",
                      }}
                    >
                      {setting?.enabled ? "已启用" : "已禁用"}
                    </span>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
                    <input type="checkbox" name="enabled" defaultChecked={setting?.enabled} /> 启用
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".04em" }}>Base URL</div>
                    <input
                      name="baseUrl"
                      defaultValue={setting?.baseUrl}
                      style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 12 }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".04em" }}>模型</div>
                    <input
                      name="model"
                      defaultValue={setting?.model}
                      list={meta.provider === "qwen" ? "qwen-default-model-options" : undefined}
                      style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 12 }}
                    />
                    {meta.provider === "qwen" && (
                      <>
                        <datalist id="qwen-default-model-options">
                          {QWEN_VIDEO_MODEL_OPTIONS.map((option) => (
                            <option key={option} value={option} />
                          ))}
                        </datalist>
                        {envModelOverride && (
                          <div style={{ fontSize: 10.5, color: "var(--warning, #f5a524)", marginTop: 6 }}>
                            环境变量 QWEN_VIDEO_MODEL 已设为 <span style={{ fontFamily: "var(--mono)" }}>{envModelOverride}</span>，会覆盖这里保存的值（用于视频分析用途）
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".04em" }}>
                      API Key {setting?.hasKey ? "（已配置，留空表示不修改）" : "（未配置）"}
                    </div>
                    <input
                      name="apiKey"
                      type="password"
                      placeholder={setting?.hasKey ? "••••••••••••" : "输入新的 API Key"}
                      style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 12 }}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-end" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", height: 36 }}>
                      <input type="checkbox" name="clearKey" /> 清除已保存的 Key
                    </label>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button
                    type="submit"
                    style={{ height: 32, padding: "0 16px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
                  >
                    保存
                  </button>
                </div>
              </form>
              <TestConnectionButton provider={meta.provider} />
            </div>
          );
        })}

        <div className="admin-card" style={{ padding: "20px 22px" }}>
          <div style={{ fontSize: 14, fontWeight: 750, marginBottom: 4 }}>Qwen 按用途分别配置模型</div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 16 }}>
            留空则回退到上面 Qwen 卡片保存的默认模型（当前：<span style={{ fontFamily: "var(--mono)" }}>{qwenDefault}</span>）
          </div>
          <form action={saveQwenPurposeModelsAction}>
            <div style={{ display: "grid", gap: 14 }}>
              {QWEN_PURPOSES.map((item, index) => {
                const resolved = purposeResolutions[index];
                const datalistId = `qwen-purpose-options-${item.key}`;
                const options = item.key === "translation" ? QWEN_TRANSLATION_MODEL_SUGGESTIONS : QWEN_VIDEO_MODEL_OPTIONS;
                return (
                  <div key={item.key}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".04em" }}>
                      {item.label} <span style={{ textTransform: "none", fontWeight: 400 }}>· {item.hint}</span>
                    </div>
                    <input
                      name={`purpose_${item.key}`}
                      defaultValue={purposeModels[item.key]}
                      placeholder={`留空 = ${qwenDefault}`}
                      list={datalistId}
                      style={{ width: "100%", height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 12 }}
                    />
                    <datalist id={datalistId}>
                      {options.map((option) => (
                        <option key={option} value={option} />
                      ))}
                    </datalist>
                    <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 6 }}>
                      当前生效：<span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{resolved.value}</span>
                      {" · "}
                      {QWEN_MODEL_SOURCE_LABELS[resolved.source]}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button
                type="submit"
                style={{ height: 32, padding: "0 16px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
              >
                保存
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
