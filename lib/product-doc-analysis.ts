import type { AnalysisResult, VideoRecord } from "@/lib/types";

const MAX_OUTPUT_LENGTH = 160;

function removeFiller(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/用户可以|用户能够/g, "用户")
    .replace(/(?:通过|进行|能够|可以|有效地?|有助于)/g, "")
    .replace(/让用户|使用户/g, "用户")
    .replace(/产品的/g, "")
    .replace(/产品价值/g, "价值")
    .replace(/观看动机/g, "观看")
    .replace(/理解成本/g, "理解")
    .replace(/，{2,}/g, "，")
    .trim();
}

function compactText(value: unknown, maxLength: number) {
  const text = removeFiller(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function uniqueText(values: unknown[], maxItems: number) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = compactText(value, 24);
    const key = text.replace(/[\s，。；、：:！!？?…]/g, "").toLowerCase();
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function numbered(items: string[]) {
  return items.map((item, index) => `${index + 1}.${item}`).join("；");
}

/** Compact Feishu-table output: three short lines, no score, source URL, remake copy, or storyboard. */
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
  const highlights = uniqueText([
    hook?.description,
    ...points.map((point) => point.description || point.reason),
  ], 2);
  const takeaways = uniqueText([
    ...strengths,
    analysis.structureFormula,
  ], 2);
  const lines = [
    `核心：${compactText(summary || "痛点切入、演示效果、场景促单。", 40)}`,
    highlights.length ? `爆点：${numbered(highlights)}` : "",
    takeaways.length ? `借鉴：${numbered(takeaways)}` : "",
  ].filter(Boolean);
  const output = lines.join("\n");
  return output.length <= MAX_OUTPUT_LENGTH
    ? output
    : `${output.slice(0, MAX_OUTPUT_LENGTH - 1).trimEnd()}…`;
}
