import { countRecentVideos, getVideo, listRecentVideos, listVideoAttempts } from "@/lib/database";
import type { VideoAttemptDiagnostics } from "@/lib/types";
import { AdminTopbar } from "../AdminTopbar";
import { Pagination } from "../Pagination";
import { STATUS_META, statusMeta } from "../status";
import { AttemptSteps } from "./AttemptSteps";
import { retryVideoAction } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

const STATUS_FILTERS = ["queued", "downloading", "transcribing", "extracting", "analyzing", "completed", "failed", "stopped"];

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "刚刚";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

function durationBetween(startIso: string, endIso: string | null) {
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(startIso).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid var(--border)", fontSize: 11.5 }}>
      <span style={{ color: "var(--text-faint)" }}>{label}</span>
      <span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{value}</span>
    </div>
  );
}

export default async function AdminTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; q?: string; status?: string; page?: string }>;
}) {
  const { id, q, status, page: pageParam } = await searchParams;
  const search = q?.trim() || "";
  const page = Math.max(1, Number(pageParam) || 1);

  const [videos, total] = await Promise.all([
    listRecentVideos({ search, status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countRecentVideos({ search, status }),
  ]);
  const selectedId = id || videos[0]?.id;
  const [video, attempts] = selectedId
    ? await Promise.all([getVideo(selectedId, false), listVideoAttempts(selectedId)])
    : [null, []];
  const latestAttemptId = attempts[0]?.id;

  const filterHref = (nextStatus?: string) => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (nextStatus) params.set("status", nextStatus);
    const query = params.toString();
    return query ? `/admin/tasks?${query}` : "/admin/tasks";
  };

  return (
    <>
      <AdminTopbar title="任务" right={<span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>共 {total} 条任务</span>} />

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ width: 340, flex: "0 0 340px", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", overflow: "auto" }}>
          <div style={{ padding: "12px 12px 0" }}>
            <form action="/admin/tasks" method="get">
              <input
                type="text"
                name="q"
                defaultValue={search}
                placeholder="搜索产品名称或链接…"
                style={{
                  width: "100%", height: 32, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 7,
                  background: "var(--surface-2)", color: "var(--text)", fontSize: 11.5,
                }}
              />
              {status && <input type="hidden" name="status" value={status} />}
            </form>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
              <a
                href={filterHref(undefined)}
                style={{
                  fontSize: 10.5, fontWeight: 700, padding: "4px 9px", borderRadius: 999,
                  border: "1px solid var(--border)",
                  background: !status ? "var(--accent-soft)" : "transparent",
                  color: !status ? "var(--accent-strong)" : "var(--text-faint)",
                }}
              >
                全部
              </a>
              {STATUS_FILTERS.map((key) => {
                const meta = STATUS_META[key];
                const active = status === key;
                return (
                  <a
                    key={key}
                    href={filterHref(key)}
                    style={{
                      fontSize: 10.5, fontWeight: 700, padding: "4px 9px", borderRadius: 999,
                      border: "1px solid var(--border)",
                      background: active ? meta.soft : "transparent",
                      color: active ? meta.color : "var(--text-faint)",
                    }}
                  >
                    {meta.label}
                  </a>
                );
              })}
            </div>
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: "12px 8px", display: "grid", gap: 2, alignContent: "start" }}>
            {videos.map((item) => {
              const meta = statusMeta(item.status);
              const selected = item.id === selectedId;
              return (
                <a
                  key={item.id}
                  href={`/admin/tasks?id=${item.id}${search ? `&q=${encodeURIComponent(search)}` : ""}${status ? `&status=${status}` : ""}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                    padding: "12px 14px",
                    borderRadius: 10,
                    border: `1px solid ${selected ? "var(--border)" : "transparent"}`,
                    background: selected ? "var(--surface-2)" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{item.productName}</span>
                    <span className="admin-badge" style={{ background: meta.soft, color: meta.color }}>
                      <span className="admin-dot" style={{ background: meta.color }} />{meta.label}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10, color: "var(--text-faint)" }}>
                    <span>{item.sourceType === "upload" ? "本地上传" : "TikTok"} · {item.analysisMode === "product_doc" ? "产品手卡模式" : item.analysisMode === "transcript_only" ? "仅口播/字幕" : "完整分析"}</span>
                    <span style={{ fontFamily: "var(--mono)" }}>{timeAgo(item.createdAt)}</span>
                  </div>
                </a>
              );
            })}
            {!videos.length && (
              <div style={{ padding: 20, fontSize: 12, color: "var(--text-faint)" }}>
                {search || status ? "没有匹配的任务" : "还没有任务"}
              </div>
            )}
          </div>

          <div style={{ padding: "0 12px 12px" }}>
            <Pagination basePath="/admin/tasks" params={{ q: search || undefined, status }} page={page} pageSize={PAGE_SIZE} total={total} />
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "22px 28px 40px" }}>
          {!video ? (
            <div style={{ color: "var(--text-faint)", fontSize: 13 }}>选择左侧一条任务查看详情</div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>{video.productName}</span>
                    {(() => {
                      const meta = statusMeta(video.status);
                      return (
                        <span className="admin-badge" style={{ background: meta.soft, color: meta.color }}>
                          <span className="admin-dot" style={{ background: meta.color }} />{meta.label}
                        </span>
                      );
                    })()}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--mono)", wordBreak: "break-all" }}>
                    {video.sourceUrl || video.sourceFileName || "—"}
                  </div>
                </div>
                {["failed", "stopped"].includes(video.status) && (
                  <form action={retryVideoAction}>
                    <input type="hidden" name="videoId" value={video.id} />
                    <button
                      type="submit"
                      style={{
                        height: 32, padding: "0 16px", borderRadius: 8, border: "1px solid var(--accent)",
                        background: "var(--accent)", color: "#fff", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                        flex: "0 0 auto",
                      }}
                    >
                      重试
                    </button>
                  </form>
                )}
              </div>

              <div className="admin-card" style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1fr 1fr", padding: "4px 20px" }}>
                <Kv label="来源类型" value={video.sourceType} />
                <Kv label="分析模式" value={video.analysisMode} />
                <Kv label="创建时间" value={new Date(video.createdAt).toLocaleString("zh-CN", { hour12: false })} />
                <Kv label="更新时间" value={new Date(video.updatedAt).toLocaleString("zh-CN", { hour12: false })} />
              </div>

              <div style={{ marginTop: 22, fontSize: 10.5, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)" }}>
                Attempt 时间线（共 {attempts.length} 次）
              </div>
              <div style={{ marginTop: 14, display: "grid", gap: 22 }}>
                {attempts.map((attempt) => {
                  const meta = statusMeta(attempt.status === "running" ? "analyzing" : attempt.status);
                  const diagnostics = attempt.diagnostics as Partial<VideoAttemptDiagnostics> | undefined;
                  return (
                    <div key={attempt.id} className="admin-card" style={{ padding: "16px 18px" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                        <div style={{ fontSize: 12, fontWeight: 700 }}>
                          Attempt #{attempt.attemptNumber} <span style={{ color: meta.color, marginLeft: 6 }}>{attempt.status === "running" ? "进行中" : meta.label}</span>
                        </div>
                        {diagnostics?.model && (
                          <span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>{diagnostics.model}</span>
                        )}
                      </div>
                      <div style={{ marginBottom: 12, fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>
                        {new Date(attempt.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}
                        {" → "}
                        {attempt.finishedAt ? new Date(attempt.finishedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "至今"}
                        {" · 耗时 "}{durationBetween(attempt.startedAt, attempt.finishedAt)}
                      </div>
                      <AttemptSteps
                        isLatestAttempt={attempt.id === latestAttemptId}
                        attemptStatus={attempt.status}
                        videoProgress={video.progress}
                        analysisMode={video.analysisMode}
                        errorMessage={attempt.errorMessage}
                        calls={diagnostics?.calls || []}
                      />
                    </div>
                  );
                })}
                {!attempts.length && <div style={{ fontSize: 12, color: "var(--text-faint)" }}>还没有 attempt 记录</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
