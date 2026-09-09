"use client";

import { useActionState } from "react";
import { runPromptTestAction, type PromptTestResult } from "./actions";
import type { PromptDebugCapture } from "@/lib/database";

const initialState: PromptTestResult | null = null;

export function PromptTestPanel({
  slug,
  template,
  captures,
  isTranslation,
}: {
  slug: string;
  template: string;
  captures: PromptDebugCapture[];
  isTranslation: boolean;
}) {
  const [state, formAction, pending] = useActionState(runPromptTestAction, initialState);

  return (
    <div style={{ width: 400, flex: "0 0 400px", overflow: "auto", padding: "20px 22px", borderLeft: "1px solid var(--border)" }}>
      <form action={formAction}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="template" value={template} />

        <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 10 }}>
          测试数据来源
        </div>

        {isTranslation ? (
          <textarea
            name="captureId"
            placeholder="粘贴一段真实的 TokScript 原口播文本用于测试翻译"
            rows={4}
            style={{ width: "100%", padding: 10, border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface-2)", color: "var(--text)", fontSize: 11.5, marginBottom: 12, fontFamily: "var(--mono)" }}
          />
        ) : (
          <select
            name="captureId"
            style={{ width: "100%", height: 38, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface-2)", color: "var(--text)", fontSize: 11.5, marginBottom: 12 }}
          >
            <option value="">选择一条真实历史请求</option>
            {captures.map((capture) => (
              <option key={capture.id} value={capture.id}>
                {capture.productName || "未知产品"} · attempt #{capture.attemptNumber} · {new Date(capture.createdAt).toLocaleString("zh-CN", { hour12: false })}
              </option>
            ))}
          </select>
        )}

        <button
          type="submit"
          disabled={pending}
          style={{
            width: "100%", height: 38, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            borderRadius: 8, border: "none", background: pending ? "var(--surface-2)" : "var(--accent)", color: "#fff",
            fontSize: 12, fontWeight: 750, marginBottom: 18, cursor: pending ? "default" : "pointer",
          }}
        >
          {pending ? "正在请求…" : "用新提示词运行测试"}
        </button>
      </form>

      <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 8 }}>测试结果</div>

      {!state && <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>还没有运行过</div>}

      {state && !state.ok && (
        <div style={{ padding: "10px 14px", background: "var(--danger-soft)", borderRadius: 10, fontSize: 12, color: "var(--danger)" }}>{state.error}</div>
      )}

      {state?.ok && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 10.5, color: "var(--success)", fontWeight: 700 }}>✓ 请求成功</span>
            {state.durationMs != null && (
              <span style={{ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>耗时 {(state.durationMs / 1000).toFixed(1)}s</span>
            )}
            {state.diagnostic?.requestId && (
              <span style={{ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>{state.diagnostic.requestId}</span>
            )}
          </div>
          <pre
            style={{
              background: "#0d1119", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px",
              fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)", whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 360, margin: 0,
            }}
          >
            {state.resultJson}
          </pre>
        </>
      )}
    </div>
  );
}
