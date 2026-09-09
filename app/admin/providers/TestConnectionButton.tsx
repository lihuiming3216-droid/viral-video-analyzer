"use client";

import { useActionState } from "react";
import { testProviderAction, type ProviderTestResult } from "./actions";

const initialState: ProviderTestResult | null = null;

export function TestConnectionButton({ provider }: { provider: string }) {
  const [state, formAction, pending] = useActionState(testProviderAction, initialState);

  return (
    <form action={formAction} style={{ marginTop: 10 }}>
      <input type="hidden" name="provider" value={provider} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="submit"
          disabled={pending}
          style={{
            height: 32, padding: "0 14px", borderRadius: 8, border: "1px solid var(--border)",
            background: pending ? "var(--surface)" : "var(--surface-2)", color: "var(--text)",
            fontSize: 11, fontWeight: 700, cursor: pending ? "default" : "pointer",
          }}
        >
          {pending ? "测试中…" : "测试连接"}
        </button>
        {!state && <span style={{ fontSize: 11, color: "var(--text-faint)" }}>点击后会用当前保存的配置发起一次真实请求</span>}
        {state?.ok && (
          <span style={{ fontSize: 11, color: "var(--success)", fontWeight: 700 }}>✓ {state.message || "连接成功"}</span>
        )}
        {state && !state.ok && (
          <span style={{ fontSize: 11, color: "var(--danger)", fontWeight: 700 }}>✕ {state.error}</span>
        )}
      </div>
    </form>
  );
}
