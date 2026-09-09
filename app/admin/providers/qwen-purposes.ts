import type { QwenPurpose } from "@/lib/database";

export const QWEN_PURPOSES: Array<{ key: QwenPurpose; label: string; hint: string }> = [
  { key: "full", label: "完整视频分析", hint: "需要能听懂原始音轨的多模态模型" },
  { key: "product_doc", label: "产品手卡精简分析", hint: "同样需要多模态，可以用更便宜/更快的型号" },
  { key: "translation", label: "口播翻译", hint: "纯文本任务，不需要音视频能力" },
];
