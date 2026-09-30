import { listFeishuInboxStatuses } from "@/lib/feishu/inbox";
import { requireAdmin } from "@/lib/require-admin";

const labels: Record<string, string> = { pending: "等待处理", running: "处理中", partial: "部分完成", failed: "未完成", paused: "中断待核查" };
export async function InboxStatus() {
  await requireAdmin();
  const tasks = await listFeishuInboxStatuses();
  if (!tasks.length) return null;
  return <details className="admin-card" style={{ margin: "12px 28px", padding: 12 }}>
    <summary>飞书已接收但尚未全部完成的请求（最近 {tasks.length} 条）</summary>
    <p style={{ fontSize: 12 }}>这里保留重启或异常前的请求记录。中断待核查的手卡不自动重新调用收费接口。</p>
    {tasks.map(task => <p key={task.id} style={{ fontSize: 12 }}>
      {task.kind === "handcard" ? "补录手卡" : "视频处理"} · {task.recordId} · {labels[task.state] || task.state}
      {task.error ? `：${task.error}` : ""}
    </p>)}
  </details>;
}
