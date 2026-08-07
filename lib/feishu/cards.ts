import type { ManualLabel, VideoRecord } from "@/lib/types";

type ProgressItem = Pick<VideoRecord, "id" | "title" | "status" | "stage" | "progress" | "scores"> & {
  documentUrl?: string | null;
  productName?: string;
};

function trim(value: string, max = 260) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function statusLabel(status: string) {
  return ({
    waiting: "等待分析", queued: "排队中", downloading: "获取视频", transcribing: "识别文案",
    extracting: "拆分镜头", analyzing: "AI分析", completed: "已完成", delivered: "已完成",
    historical: "历史报告", stopped: "已停止", failed: "失败",
  } as Record<string, string>)[status] || status;
}

function markdown(content: string) {
  return { tag: "markdown", content };
}

function button(text: string, value: Record<string, unknown>, type: "default" | "primary" | "danger" = "default") {
  return { tag: "button", text: { tag: "plain_text", content: text }, type, value };
}

export function buildProgressCard(input: {
  productName: string;
  pid?: string;
  senderOpenId?: string;
  items: ProgressItem[];
}) {
  const completed = input.items.filter((item) => ["completed", "delivered", "historical"].includes(item.status)).length;
  const failed = input.items.filter((item) => ["failed", "stopped"].includes(item.status)).length;
  const finished = completed + failed >= input.items.length;
  const lines = input.items.map((item, index) => {
    const score = ["completed", "delivered", "historical"].includes(item.status)
      ? ` · 流量 ${item.scores.traffic} / 转化 ${item.scores.conversion}` : ` · ${item.progress}%`;
    const report = item.documentUrl ? ` · [完整报告](${item.documentUrl})` : "";
    return `**${index + 1}. ${trim(item.title || "待获取视频信息", 70)}**\n${statusLabel(item.status)} · ${trim(item.stage || "等待处理", 40)}${score}${report}`;
  }).join("\n\n");
  return {
    config: { wide_screen_mode: true, enable_forward: true, update_multi: true },
    header: {
      template: failed ? "orange" : finished ? "green" : "blue",
      title: { tag: "plain_text", content: finished ? "爆片分析已完成" : "爆片分析进行中" },
    },
    elements: [
      markdown(`${input.senderOpenId ? `<at id=${input.senderOpenId}></at> ` : ""}**产品：${input.productName}**${input.pid ? ` · PID ${input.pid}` : ""}\n${completed}/${input.items.length} 条完成${failed ? `，${failed} 条异常` : ""}`),
      { tag: "hr" },
      markdown(lines || "任务正在初始化"),
      { tag: "note", elements: [{ tag: "plain_text", content: finished ? "报告已同步保存到网页产品档案和飞书文档。" : "机器人会自动更新这张卡片，无需重复发送链接。" }] },
    ],
  };
}

export function buildResultCard(video: VideoRecord, input: {
  documentUrl: string;
  localReportUrl: string;
  senderOpenId?: string;
  historical?: boolean;
  selectedLabel?: ManualLabel;
}) {
  const hook = video.analysis?.hook;
  const viral = video.analysis?.viralPoints?.slice(0, 2).map((point) => `${point.timeRange} ${point.description}`).join("；") || "详见完整报告";
  const label = input.selectedLabel ?? video.manualLabel;
  return {
    config: { wide_screen_mode: true, enable_forward: true, update_multi: true },
    header: {
      template: input.historical ? "wathet" : "green",
      title: { tag: "plain_text", content: input.historical ? "发现已有爆片分析报告" : "爆片分析报告已完成" },
    },
    elements: [
      markdown(`${input.senderOpenId ? `<at id=${input.senderOpenId}></at> ` : ""}**${trim(video.productName, 50)} · ${trim(video.title || "TikTok 视频", 80)}**\n${video.accountName ? `@${video.accountName} · ` : ""}${video.language || "语言待识别"}`),
      {
        tag: "div",
        fields: [
          { is_short: true, text: { tag: "lark_md", content: `**流量潜力**\n${video.scores.traffic}` } },
          { is_short: true, text: { tag: "lark_md", content: `**带货转化**\n${video.scores.conversion}` } },
          { is_short: true, text: { tag: "lark_md", content: `**画面质量**\n${video.scores.visual}` } },
          { is_short: true, text: { tag: "lark_md", content: `**产品展示**\n${video.scores.product}` } },
          { is_short: true, text: { tag: "lark_md", content: `**声音情绪**\n${video.scores.audio}` } },
          { is_short: true, text: { tag: "lark_md", content: `**节奏完播**\n${video.scores.rhythm}` } },
        ],
      },
      { tag: "hr" },
      markdown(`**核心判断**\n${trim(video.summary || "分析已完成", 420)}\n\n**开场钩子**\n${hook ? `${hook.timeRange} · ${hook.type}：${trim(hook.description, 220)}` : trim(video.hookSummary || "详见完整报告", 220)}\n\n**爆点**\n${trim(viral, 280)}`),
      {
        tag: "action",
        layout: "bisected",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "查看完整飞书文档" }, type: "primary", url: input.documentUrl },
          { tag: "button", text: { tag: "plain_text", content: "打开网页报告" }, type: "default", url: input.localReportUrl },
        ],
      },
      {
        tag: "action",
        layout: "flow",
        actions: [
          button(label === "优质" ? "✓ 优质" : "标记优质", { action: "label", videoId: video.id, label: "优质" }, label === "优质" ? "primary" : "default"),
          button(label === "普通" ? "✓ 普通" : "标记普通", { action: "label", videoId: video.id, label: "普通" }, label === "普通" ? "primary" : "default"),
          button(label === "较差" ? "✓ 较差" : "标记较差", { action: "label", videoId: video.id, label: "较差" }, label === "较差" ? "danger" : "default"),
          button("重新分析", { action: "reanalyze", videoId: video.id }),
        ],
      },
      { tag: "note", elements: [{ tag: "plain_text", content: "完整文档包含原文案、中文翻译、逐镜头分析、关键截图和爆点片段。" }] },
    ],
  };
}

export function buildErrorCard(input: { title?: string; message: string; senderOpenId?: string; retryVideoId?: string }) {
  const actions = input.retryVideoId ? [{
    tag: "action", actions: [button("重试分析", { action: "reanalyze", videoId: input.retryVideoId }, "primary")],
  }] : [];
  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: { template: "red", title: { tag: "plain_text", content: input.title || "爆片分析未能完成" } },
    elements: [
      markdown(`${input.senderOpenId ? `<at id=${input.senderOpenId}></at> ` : ""}${trim(input.message, 800)}`),
      ...actions,
    ],
  };
}
