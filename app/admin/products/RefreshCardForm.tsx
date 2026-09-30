"use client";
import { useActionState } from "react";
import { refreshProductCardAction } from "./actions";

export function RefreshCardForm({ productId, name }: { productId: string; name: string }) {
  const [state, action, pending] = useActionState(refreshProductCardAction, null);
  return <form action={action} onSubmit={event => {
    if (!window.confirm(`刷新“${name}”这份手卡的基础资料？\n将用已有缓存替换六项基础资料，保留视频分析、翻译和其他区块。不重新请求出海匠或模型。`)) event.preventDefault();
  }} style={{ marginTop: 6 }}>
    <input type="hidden" name="productId" value={productId} />
    <input type="hidden" name="confirmOverwrite" value="yes" />
    <button type="submit" disabled={pending || state?.ok} style={{ fontSize: 11 }}>{pending ? "正在刷新…" : "刷新基础资料"}</button>
    {state && <p role="status" style={{ fontSize: 11, maxWidth: 260, color: state.ok ? "var(--success)" : "var(--danger)" }}>{state.message}</p>}
  </form>;
}
