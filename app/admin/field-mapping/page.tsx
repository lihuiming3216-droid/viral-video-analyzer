import { listFeishuFieldMappings } from "@/lib/database";
import { defaultFeishuAutomationFieldMap, listBitableTableFieldNames, type FeishuAutomationFieldMap } from "@/lib/feishu/automation";
import { AdminTopbar } from "../AdminTopbar";
import { deleteFieldMappingAction, saveFieldMappingAction, startFieldMappingFromUrlAction } from "./actions";

export const dynamic = "force-dynamic";

const FIELD_LABELS: Record<keyof FeishuAutomationFieldMap, string> = {
  productUrl: "产品链接",
  pid: "商品 PID",
  productName: "产品名称",
  productDocument: "产品手卡",
  productCardStatus: "手卡状态",
  videoUrl: "视频链接",
  analysis: "视频分析结果",
  translation: "中文翻译",
  status: "分析状态",
  transcript: "原口播",
  videoFile: "视频文件",
  subtitle: "音频字幕",
  timestampedTranscript: "时间戳原口播",
  timestampedTranslation: "时间戳中文",
  linkedSubtitle: "链接字幕",
};

const FIELD_KEYS = Object.keys(defaultFeishuAutomationFieldMap) as Array<keyof FeishuAutomationFieldMap>;

const inputStyle: React.CSSProperties = {
  width: "100%", height: 32, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 7,
  background: "var(--surface-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: 11.5,
};

const selectStyle: React.CSSProperties = { ...inputStyle, fontFamily: "var(--font-sans, inherit)" };

export default async function AdminFieldMappingPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; new?: string; edit?: string; urlError?: string }>;
}) {
  const { scope: requestedScope, new: creatingNew, edit, urlError } = await searchParams;
  const mappings = await listFeishuFieldMappings();
  const activeScope = creatingNew ? null : requestedScope && mappings.find((item) => item.scopeKey === requestedScope)
    ? mappings.find((item) => item.scopeKey === requestedScope)!
    : mappings[0] || null;
  const editing = Boolean(edit && requestedScope);
  const overriddenKeys = activeScope
    ? FIELD_KEYS.filter((key) => key in activeScope.fieldMap || activeScope.aliases[key]?.length)
    : [];

  // Editing always resolves a scope key (from the URL) — either one already
  // saved (activeScope) or a brand new one just parsed out of a pasted link
  // (requestedScope with no matching saved row yet).
  const editingScopeKey = editing ? requestedScope! : null;
  const [editAppToken, editTableId] = editingScopeKey?.split(":") ?? [];
  let liveColumns: string[] | null = null;
  let liveColumnsError: string | null = null;
  if (editing && editAppToken && editTableId) {
    try {
      liveColumns = await listBitableTableFieldNames({ appToken: editAppToken, tableId: editTableId });
    } catch (error) {
      liveColumnsError = error instanceof Error ? error.message : "获取飞书表字段失败";
    }
  }
  const columnToSystemKey = new Map<string, string>();
  if (activeScope) {
    for (const key of FIELD_KEYS) {
      const columnName = activeScope.fieldMap[key];
      if (columnName) columnToSystemKey.set(columnName, key);
    }
  }

  return (
    <>
      <AdminTopbar title="字段映射" right={<span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>{mappings.length} 个已保存的映射</span>} />

      <div style={{ flex: 1, padding: "24px 28px 40px", overflow: "auto" }}>
        <div style={{ marginBottom: 16, padding: "11px 14px", background: "var(--warning-soft)", borderRadius: 10, fontSize: 11.5, color: "var(--warning)", maxWidth: 900 }}>
          每张飞书多维表格的列名可能不一样。这里按表分组，把我们后台产出的固定几项数据（原口播、中文翻译、链接字幕……）分别指向这张表里的哪一列。
          左边的列名是直接从飞书实时拉回来的真实列，不是手填的——选错的可能性降到了“选错下拉选项”，不会再出现打错字导致整行写回失败的情况。
          保存后不需要重新部署代码，飞书下一次调用自动化接口就会生效。
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {mappings.map((mapping) => {
            const active = activeScope?.scopeKey === mapping.scopeKey && !creatingNew && !editing;
            return (
              <a
                key={mapping.scopeKey}
                href={`/admin/field-mapping?scope=${encodeURIComponent(mapping.scopeKey)}`}
                style={{
                  height: 32, padding: "0 14px", display: "flex", alignItems: "center", borderRadius: 999,
                  fontSize: 11.5, fontWeight: 700, border: "1px solid var(--border)",
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent-strong)" : "var(--text-muted)",
                }}
              >
                {mapping.label || mapping.scopeKey}
              </a>
            );
          })}
          <a
            href="/admin/field-mapping?new=1"
            style={{
              height: 32, padding: "0 14px", display: "flex", alignItems: "center", borderRadius: 999,
              fontSize: 11.5, fontWeight: 700, border: "1px dashed var(--border)", color: "var(--text-faint)",
            }}
          >
            + 新增映射
          </a>
        </div>

        {!mappings.length && !creatingNew && !editing && (
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginBottom: 16 }}>
            还没有保存过映射，当前所有自动化都在用代码里的默认列名。点击“新增映射”，粘贴这张飞书多维表格的网页链接就能开始配置。
          </div>
        )}

        {creatingNew && (
          <form action={startFieldMappingFromUrlAction} className="admin-card" style={{ padding: "20px 22px", maxWidth: 700 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase" }}>
              粘贴飞书多维表格的网页链接
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                name="pastedUrl"
                placeholder="https://xxx.feishu.cn/base/xxxxxxxx?table=tblxxxxxxxx&view=..."
                style={{ ...inputStyle, flex: 1 }}
              />
              <button type="submit" style={{ height: 32, padding: "0 16px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: 11.5, fontWeight: 700, cursor: "pointer", flex: "0 0 auto" }}>
                获取列名
              </button>
            </div>
            {urlError && (
              <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--danger)" }}>
                没能从这个链接里识别出表格信息，确认粘贴的是打开这张多维表格具体某个视图时浏览器地址栏里的完整链接（应该带有 /base/ 和 ?table= ）。
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-faint)" }}>
              在飞书里打开这张多维表格、切到目标数据表，直接复制浏览器地址栏的链接粘贴到这里即可。
            </div>
          </form>
        )}

        {activeScope && !creatingNew && !editing && (
          <div className="admin-card" style={{ padding: "18px 22px", maxWidth: 900 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 750 }}>{activeScope.label || activeScope.scopeKey}</div>
                <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>{activeScope.scopeKey}</div>
              </div>
              <a
                href={`/admin/field-mapping?scope=${encodeURIComponent(activeScope.scopeKey)}&edit=1`}
                style={{ height: 30, padding: "0 14px", display: "flex", alignItems: "center", borderRadius: 7, border: "1px solid var(--border)", fontSize: 11, fontWeight: 700, color: "var(--text)", flex: "0 0 auto" }}
              >
                编辑
              </a>
            </div>
            <div style={{ marginTop: 14 }}>
              {overriddenKeys.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {overriddenKeys.map((key) => (
                    <span key={key} className="admin-badge" style={{ background: "var(--surface-2)", color: "var(--text)", fontFamily: "var(--mono)" }}>
                      {FIELD_LABELS[key]}
                      {activeScope.fieldMap[key]
                        ? ` → ${activeScope.fieldMap[key]}`
                        : key in activeScope.fieldMap ? " → 不使用" : ""}
                      {activeScope.aliases[key]?.length ? ` (+${activeScope.aliases[key]!.length} 别名)` : ""}
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>这张表还没有配置过映射，全部沿用代码默认列名。</div>
              )}
            </div>
          </div>
        )}

        {editing && liveColumnsError && (
          <div className="admin-card" style={{ padding: "18px 22px", maxWidth: 700 }}>
            <div style={{ fontSize: 12.5, color: "var(--danger)", fontWeight: 700 }}>获取这张表的列名失败</div>
            <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-muted)" }}>{liveColumnsError}</div>
            <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>{editingScopeKey}</div>
            <a href="/admin/field-mapping" style={{ display: "inline-block", marginTop: 12, fontSize: 11.5, color: "var(--accent-strong)", fontWeight: 700 }}>
              返回
            </a>
          </div>
        )}

        {editing && liveColumns && (
          <form action={saveFieldMappingAction} className="admin-card" style={{ padding: "20px 22px", maxWidth: 900 }}>
            <input type="hidden" name="scopeKey" value={editingScopeKey!} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase" }}>飞书 App Token : Table ID</div>
                <div style={{ height: 32, display: "flex", alignItems: "center", fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-faint)" }}>{editingScopeKey}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase" }}>分组名称（给人看的）</div>
                <input name="label" defaultValue={activeScope?.label} placeholder="例如：新人组任务安排表" style={inputStyle} />
              </div>
            </div>

            {!liveColumns.length ? (
              <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>这张表没有拉到任何列，无法配置。</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>飞书表里的真实列名</th>
                    <th>写入哪项数据</th>
                  </tr>
                </thead>
                <tbody>
                  {liveColumns.map((columnName, index) => (
                    <tr key={`${columnName}-${index}`}>
                      <td style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{columnName}</td>
                      <td>
                        <input type="hidden" name={`colname_${index}`} value={columnName} />
                        <select name={`select_${index}`} defaultValue={columnToSystemKey.get(columnName) || ""} style={selectStyle}>
                          <option value="">（不使用）</option>
                          {FIELD_KEYS.map((key) => (
                            <option key={key} value={key}>{FIELD_LABELS[key]}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button type="submit" style={{ height: 32, padding: "0 16px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                保存
              </button>
              <a
                href={activeScope ? `/admin/field-mapping?scope=${encodeURIComponent(activeScope.scopeKey)}` : "/admin/field-mapping"}
                style={{ height: 32, padding: "0 16px", display: "flex", alignItems: "center", borderRadius: 8, border: "1px solid var(--border)", fontSize: 11.5, fontWeight: 700, color: "var(--text)" }}
              >
                取消
              </a>
            </div>
          </form>
        )}

        {activeScope && !creatingNew && !editing && (
          <form action={deleteFieldMappingAction} style={{ marginTop: 12 }}>
            <input type="hidden" name="scopeKey" value={activeScope.scopeKey} />
            <button type="submit" style={{ height: 30, padding: "0 14px", borderRadius: 8, border: "1px solid var(--danger)", background: "transparent", color: "var(--danger)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              删除这张表的映射（恢复为代码默认列名）
            </button>
          </form>
        )}
      </div>
    </>
  );
}
