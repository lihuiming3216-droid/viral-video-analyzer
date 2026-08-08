import type { AnalysisResult, VideoRecord } from "@/lib/types";

/** Compact Feishu-table output: no score, source URL, remake copy, or storyboard. */
export function conciseProductDocAnalysis(video: VideoRecord) {
  const analysis = (video.analysis || {}) as Partial<AnalysisResult>;
  const hook = analysis.hook;
  const points = Array.isArray(analysis.viralPoints) ? analysis.viralPoints : [];
  const strengths = Array.isArray(analysis.strengths) ? analysis.strengths : [];
  const summary = String(video.summary || "通过痛点切入、产品演示和场景证明推动转化。")
    .split(/(?<=[。！？])/)
    .filter((sentence) => !/(评分|分数|潜力\s*[高低]|\d+\s*分|转化率)/.test(sentence))
    .join("")
    .trim();
  const lines = [
    `核心判断：${summary || "通过痛点切入、产品演示和场景证明推动转化。"}`,
    "",
    "分析爆点：",
    hook?.description ? `- 开头钩子：${hook.description}` : "",
    ...points.slice(0, 3).map((point) => `- ${point.description || point.reason || "突出产品价值并推动用户继续观看"}`),
    strengths[0] ? `- 内容优势：${strengths[0]}` : "",
    "",
    "可借鉴：",
    ...strengths.slice(0, 2).map((item: string) => `- ${item}`),
    analysis.structureFormula ? `- 内容结构：${analysis.structureFormula}` : "",
  ];
  return lines.filter((line, index, all) => line || (index > 0 && all[index - 1])).join("\n").trim();
}
