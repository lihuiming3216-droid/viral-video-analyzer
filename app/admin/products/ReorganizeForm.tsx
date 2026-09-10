"use client";
import { useActionState } from "react";
import { reorganizeProductAction } from "./actions";

export function ReorganizeForm({ requestId }: { requestId: string }) {
  const [state, action, pending] = useActionState(reorganizeProductAction, null);
  return <form action={action} className="admin-card provider-form" style={{ marginBottom: 18 }}>
    <h3>用已有资料重新整理商品</h3>
    <p>只读云端已有文字和图片，不调用出海匠、不重新下载。使用当前商品模型，成功后替换该PID的整理缓存，失败保留旧结果。</p>
    <input name="requestId" type="hidden" value={requestId} />
    <div className="provider-grid"><label>商品PID<input name="pid" required pattern="[0-9]{6,30}" /></label></div>
    <label className="provider-check"><input name="confirmCharge" type="checkbox" required />我确认本次可能产生模型费用（最多按商品设置请求两次），但不会重复产生出海匠取数费用。</label>
    <button disabled={pending || state?.ok} style={{ marginTop: 12 }}>{pending ? "正在整理，请勿重复提交…" : "确认重新整理"}</button>
    {state && <p role="status" style={{ color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</p>}
    {state?.ok && <p>再次操作其他PID前请刷新本页。本页不会自动修改任何飞书手卡。</p>}
  </form>;
}
