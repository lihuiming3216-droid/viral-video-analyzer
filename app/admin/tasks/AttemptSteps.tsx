import type { VideoAttemptCallDiagnostic, VideoRecord } from "@/lib/types";
import { pipelineStepsForMode, stepStatusesForAttempt, type PipelineStepStatus } from "./pipeline";

const STEP_DOT: Record<PipelineStepStatus, { color: string; symbol: string }> = {
  done: { color: "var(--success)", symbol: "✓" },
  current: { color: "var(--accent-strong)", symbol: "●" },
  failed: { color: "var(--danger)", symbol: "✕" },
  pending: { color: "var(--text-faint)", symbol: "" },
};

const CALL_OUTCOME_LABEL: Record<string, { label: string; color: string }> = {
  success: { label: "成功", color: "var(--success)" },
  timeout: { label: "超时", color: "var(--danger)" },
  aborted: { label: "已中止", color: "var(--text-faint)" },
  http_error: { label: "HTTP 错误", color: "var(--danger)" },
  network_error: { label: "网络错误", color: "var(--danger)" },
  invalid_response: { label: "响应格式异常", color: "var(--danger)" },
};

const CALL_PHASE_LABEL: Record<string, string> = {
  awaiting_headers: "等待响应头",
  awaiting_first_token: "等待首个 token",
  streaming: "流式接收中",
  parsing: "解析结果中",
  completed: "已完成",
};

/**
 * Step-by-step breakdown for one attempt. Only the video's current/most
 * recent attempt has reconstructable step data — `videos.progress` is a
 * single live value shared by whichever attempt ran last, so older,
 * superseded attempts have no per-step record to show (see pipeline.ts).
 */
export function AttemptSteps({
  isLatestAttempt,
  attemptStatus,
  videoProgress,
  analysisMode,
  errorMessage,
  calls,
}: {
  isLatestAttempt: boolean;
  attemptStatus: string;
  videoProgress: number;
  analysisMode: VideoRecord["analysisMode"];
  errorMessage: string;
  calls: VideoAttemptCallDiagnostic[];
}) {
  if (!isLatestAttempt) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-faint)", padding: "2px 0 4px" }}>
        这次尝试已被后续重试覆盖，系统没有为它单独保留分步记录（只有最新一次尝试能看到详细步骤）。
      </div>
    );
  }

  const steps = pipelineStepsForMode(analysisMode);
  const statuses = stepStatusesForAttempt(videoProgress, attemptStatus, analysisMode);

  return (
    <div>
      {steps.map((step, index) => {
        const status = statuses[index];
        const dot = STEP_DOT[status];
        const isLast = index === steps.length - 1;
        const isQwenStep = step.key === "qwen";
        const showCalls = isQwenStep && calls.length > 0 && status !== "pending";
        return (
          <div key={step.key} style={{ display: "flex", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span
                style={{
                  width: 18, height: 18, borderRadius: "50%", flex: "0 0 18px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 800, color: status === "pending" ? dot.color : "#fff",
                  background: status === "pending" ? "var(--surface-2)" : dot.color,
                  border: `1px solid ${dot.color}`,
                }}
              >
                {dot.symbol}
              </span>
              {!isLast && <span style={{ width: 1.5, flex: 1, minHeight: 14, background: "var(--border)", margin: "2px 0" }} />}
            </div>
            <div style={{ paddingBottom: isLast ? 4 : 16, flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: status === "pending" ? "var(--text-faint)" : "var(--text)" }}>
                {step.label}
                {status === "current" && <span style={{ marginLeft: 8, fontSize: 10.5, color: "var(--accent-strong)", fontWeight: 700 }}>进行中</span>}
                {status === "failed" && <span style={{ marginLeft: 8, fontSize: 10.5, color: "var(--danger)", fontWeight: 700 }}>失败</span>}
              </div>
              {status === "failed" && errorMessage && (
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)", padding: "8px 10px", background: "var(--danger-soft)", borderRadius: 8 }}>
                  {errorMessage}
                </div>
              )}
              {showCalls && (
                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                  {calls.map((call) => {
                    const outcome = CALL_OUTCOME_LABEL[call.outcome] || { label: call.outcome, color: "var(--text-faint)" };
                    return (
                      <div key={call.clientRequestId} className="admin-card" style={{ padding: "8px 12px", fontSize: 10.5 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 700 }}>请求 #{call.requestIndex}</span>
                          <span style={{ color: outcome.color, fontWeight: 700 }}>{outcome.label}</span>
                          <span style={{ color: "var(--text-faint)" }}>{CALL_PHASE_LABEL[call.phase] || call.phase}</span>
                          {call.httpStatus != null && <span style={{ color: "var(--text-faint)", fontFamily: "var(--mono)" }}>HTTP {call.httpStatus}</span>}
                        </div>
                        <div style={{ display: "flex", gap: 14, color: "var(--text-faint)", fontFamily: "var(--mono)", flexWrap: "wrap" }}>
                          {call.firstTokenMs != null && <span>首 token {call.firstTokenMs}ms</span>}
                          <span>总耗时 {call.totalMs}ms</span>
                          {call.providerRequestId && <span>{call.providerRequestId}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
