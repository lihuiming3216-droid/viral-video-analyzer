import { getActiveVideos, getLiveQueueCounts, getTodayTaskCounts, listProviderSettings } from "@/lib/database";
import { getDiskUsage, getMediaUsageBytes } from "@/lib/video-processing";
import { getFeishuRuntimeStatus } from "@/lib/feishu/runtime";
import { AdminTopbar } from "../AdminTopbar";

export const dynamic = "force-dynamic";

const MAX_CONCURRENT_VIDEOS = 2;

const STAGE_LABEL: Record<string, string> = {
  queued: "已加入队列",
  downloading: "TokScript 下载中",
  transcribing: "获取口播中",
  extracting: "识别镜头中",
  analyzing: "Qwen 分析中",
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "刚刚";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

export default async function AdminOverviewPage() {
  const [activeVideos, queueCounts, todayCounts, providers, feishuStatus] = await Promise.all([
    getActiveVideos(MAX_CONCURRENT_VIDEOS),
    getLiveQueueCounts(),
    getTodayTaskCounts(),
    listProviderSettings(),
    getFeishuRuntimeStatus().catch(() => null),
  ]);

  const mediaBytes = getMediaUsageBytes();
  const disk = getDiskUsage();
  const diskPercent = disk && disk.totalBytes > 0 ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null;

  const tokscript = providers.find((item) => item.provider === "tokscript");
  const qwen = providers.find((item) => item.provider === "qwen");

  const emptySlots = Math.max(0, MAX_CONCURRENT_VIDEOS - activeVideos.length);

  return (
    <>
      <AdminTopbar title="总览" right={<span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>刷新时间 · {new Date().toLocaleTimeString("zh-CN", { hour12: false })}</span>} />

      <div style={{ flex: 1, padding: "24px 28px 40px", display: "grid", gap: 20, overflow: "auto" }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 10 }}>
            队列状态 · {activeVideos.length} / {MAX_CONCURRENT_VIDEOS} 槽位使用中
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${MAX_CONCURRENT_VIDEOS}, 1fr)`, gap: 14 }}>
            {activeVideos.map((video, index) => (
              <div key={video.id} className="admin-card" style={{ padding: "18px 20px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span className="admin-badge" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>
                    <span className="admin-dot" style={{ background: "var(--accent-strong)" }} />处理中 · 槽位 {index + 1}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>attempt #{video.attemptCount || 1}</span>
                </div>
                <div style={{ marginTop: 12, fontSize: 15, fontWeight: 750 }}>{video.productName}</div>
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {video.sourceUrl || video.sourceFileName || "本地上传"}
                </div>
                <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
                  <span>{STAGE_LABEL[video.status] || video.stage}</span>
                  <span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{video.progress}%</span>
                </div>
                <div style={{ marginTop: 6, height: 6, borderRadius: 999, background: "var(--surface-2)", overflow: "hidden" }}>
                  <div style={{ width: `${video.progress}%`, height: "100%", background: "linear-gradient(90deg,var(--accent),var(--accent-strong))" }} />
                </div>
                <div style={{ marginTop: 12, fontSize: 10, color: "var(--text-faint)" }}>
                  来源 {video.sourceType === "upload" ? "本地上传" : "TikTok"} · 已运行 {timeAgo(video.processingStartedAt)}
                </div>
              </div>
            ))}
            {Array.from({ length: emptySlots }).map((_, index) => (
              <div key={`empty-${index}`} className="admin-card" style={{ padding: "18px 20px", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)", fontSize: 12 }}>
                空闲槽位
              </div>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 10 }}>今日任务</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
            <div className="admin-card" style={{ padding: "16px 18px" }}>
              <div style={{ fontSize: 10, color: "var(--text-faint)" }}>已完成</div>
              <div style={{ marginTop: 8, fontSize: 26, fontWeight: 800, fontFamily: "var(--mono)" }}>{todayCounts.completed}</div>
            </div>
            <div className="admin-card" style={{ padding: "16px 18px" }}>
              <div style={{ fontSize: 10, color: "var(--text-faint)" }}>失败</div>
              <div style={{ marginTop: 8, fontSize: 26, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--danger)" }}>{todayCounts.failed}</div>
            </div>
            <div className="admin-card" style={{ padding: "16px 18px" }}>
              <div style={{ fontSize: 10, color: "var(--text-faint)" }}>处理中</div>
              <div style={{ marginTop: 8, fontSize: 26, fontWeight: 800, fontFamily: "var(--mono)", color: "var(--warning)" }}>{queueCounts.processing}</div>
            </div>
            <div className="admin-card" style={{ padding: "16px 18px" }}>
              <div style={{ fontSize: 10, color: "var(--text-faint)" }}>排队中</div>
              <div style={{ marginTop: 8, fontSize: 26, fontWeight: 800, fontFamily: "var(--mono)" }}>{queueCounts.queued}</div>
            </div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 10 }}>系统健康</div>
          <div className="admin-card" style={{ padding: "6px 20px" }}>
            <HealthRow label="飞书长连接" ok={feishuStatus?.connectionStatus === "connected"} detail={feishuStatus?.connectionStatus || "未知"} />
            <HealthRow label="MySQL" ok detail="已连接" />
            <HealthRow label="TokScript" ok={Boolean(tokscript?.enabled && tokscript?.hasKey)} detail={tokscript?.hasKey ? "已配置密钥" : "未配置密钥"} />
            <HealthRow label="Qwen · DashScope" ok={Boolean(qwen?.enabled && qwen?.hasKey)} detail={qwen ? qwen.model || "未设置模型" : "未配置"} />
            <div style={{ padding: "13px 0" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="admin-dot" style={{ background: diskPercent && diskPercent > 85 ? "var(--danger)" : "var(--warning)", boxShadow: "0 0 0 3px var(--warning-soft)" }} />
                  <span style={{ fontSize: 12, fontWeight: 600 }}>磁盘用量</span>
                </div>
                <span style={{ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>
                  {disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}` : "无法读取"} · 媒体 {formatBytes(mediaBytes)}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: "var(--surface-2)", overflow: "hidden" }}>
                <div style={{ width: `${diskPercent ?? 0}%`, height: "100%", background: "var(--warning)" }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function HealthRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="admin-dot" style={{ background: ok ? "var(--success)" : "var(--text-faint)", boxShadow: ok ? "0 0 0 3px var(--success-soft)" : "none" }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: ok ? "var(--text)" : "var(--text-muted)" }}>{label}</span>
      </div>
      <span style={{ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>{detail}</span>
    </div>
  );
}
