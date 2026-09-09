import type { VideoRecord } from "@/lib/types";

/**
 * The video pipeline has no persisted per-step log — `videos.stage`/`progress`
 * are overwritten in place as `lib/analysis.ts` moves through it (see the
 * `setStage()` calls there), and failure handling overwrites `stage` to a
 * terminal message while leaving the last real `progress` value untouched.
 * This table mirrors those exact progress checkpoints so the ops console can
 * reconstruct "how far did it get" for the video's current/latest attempt.
 * It cannot reconstruct history for older, superseded attempts — that data
 * was never recorded — so the UI must say so rather than guess.
 *
 * `transcript_only` (任务安排表) never sets progress past "下载原始视频" (22) —
 * analyzeVideo() skips scene extraction, the Qwen video call, and report
 * generation entirely for that mode (see lib/analysis.ts) and jumps straight
 * to progress 100 on completion, so those three steps have no place here.
 */
const FULL_PIPELINE_STEPS = [
  { key: "queued", label: "排队等待", minProgress: 0 },
  { key: "tokscript", label: "TokScript 获取视频信息", minProgress: 12 },
  { key: "download", label: "下载原始视频", minProgress: 22 },
  { key: "extract", label: "识别镜头 / 提取关键画面", minProgress: 36 },
  { key: "qwen", label: "Qwen 视频分析", minProgress: 66 },
  { key: "report", label: "生成中文报告 / 翻译", minProgress: 82 },
  { key: "done", label: "完成", minProgress: 100 },
] as const;

const TRANSCRIPT_ONLY_PIPELINE_STEPS = [
  { key: "queued", label: "排队等待", minProgress: 0 },
  { key: "tokscript", label: "TokScript 获取视频信息", minProgress: 12 },
  { key: "download", label: "下载原始视频", minProgress: 22 },
  { key: "done", label: "完成", minProgress: 100 },
] as const;

export function pipelineStepsForMode(analysisMode: VideoRecord["analysisMode"]) {
  return analysisMode === "transcript_only" ? TRANSCRIPT_ONLY_PIPELINE_STEPS : FULL_PIPELINE_STEPS;
}

export type PipelineStep = ReturnType<typeof pipelineStepsForMode>[number];
export type PipelineStepStatus = "done" | "current" | "failed" | "pending";

export function currentStepIndexForProgress(progress: number, analysisMode: VideoRecord["analysisMode"]) {
  const steps = pipelineStepsForMode(analysisMode);
  let index = 0;
  for (let i = 0; i < steps.length; i += 1) {
    if (progress >= steps[i].minProgress) index = i;
  }
  return index;
}

/**
 * Step statuses for one attempt. Only meaningful for the video's current/most
 * recent attempt, since `progress` reflects whichever attempt ran last.
 */
export function stepStatusesForAttempt(
  progress: number,
  attemptStatus: string,
  analysisMode: VideoRecord["analysisMode"],
): PipelineStepStatus[] {
  const steps = pipelineStepsForMode(analysisMode);
  const reachedIndex = currentStepIndexForProgress(progress, analysisMode);
  return steps.map((step, index) => {
    if (index < reachedIndex) return "done";
    if (index > reachedIndex) return "pending";
    // index === reachedIndex
    if (attemptStatus === "completed") return "done";
    if (attemptStatus === "failed" || attemptStatus === "stopped") return "failed";
    return "current";
  });
}
