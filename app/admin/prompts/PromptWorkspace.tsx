"use client";

import { useState } from "react";
import { saveTemplateAction } from "./actions";
import { PromptTestPanel } from "./PromptTestPanel";
import type { PromptDebugCapture } from "@/lib/database";

function variablesUsedIn(template: string) {
  return [...new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1]))];
}

export function PromptWorkspace({
  slug,
  label,
  source,
  currentVersion,
  updatedAt,
  initialTemplate,
  captures,
  isTranslation,
}: {
  slug: string;
  label: string;
  source: string;
  currentVersion: number;
  updatedAt: string;
  initialTemplate: string;
  captures: PromptDebugCapture[];
  isTranslation: boolean;
}) {
  const [template, setTemplate] = useState(initialTemplate);
  const variables = variablesUsedIn(template);

  return (
    <>
      <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 800 }}>{label}</span>
          <span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>
            当前版本 v{currentVersion} · {new Date(updatedAt).toLocaleString("zh-CN", { hour12: false })}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 14 }}>{source}</div>

        <form action={saveTemplateAction}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="template" value={template} />
          <textarea
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            rows={18}
            style={{
              width: "100%", padding: "16px 18px", border: "1px solid var(--border)", borderRadius: 10,
              background: "#0d1119", color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.8,
            }}
          />
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {variables.map((name) => (
              <span key={name} style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent-strong)", background: "var(--accent-soft)", padding: "2px 7px", borderRadius: 5 }}>
                {`{{${name}}}`}
              </span>
            ))}
            {!variables.length && <span style={{ fontSize: 11, color: "var(--text-faint)" }}>这份模板没有用到真实数据占位符</span>}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button
              type="submit"
              style={{ height: 34, padding: "0 16px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: 11.5, fontWeight: 750, cursor: "pointer" }}
            >
              保存为新版本
            </button>
            {template !== initialTemplate && (
              <span style={{ fontSize: 10.5, color: "var(--warning)", alignSelf: "center" }}>有未保存的修改——右侧测试用的就是这份未保存的内容</span>
            )}
          </div>
        </form>
      </div>

      <PromptTestPanel slug={slug} template={template} captures={captures} isTranslation={isTranslation} />
    </>
  );
}
