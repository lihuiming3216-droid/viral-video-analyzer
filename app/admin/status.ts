export const STATUS_META: Record<string, { label: string; color: string; soft: string }> = {
  queued: { label: "排队中", color: "var(--text-faint)", soft: "var(--surface-2)" },
  downloading: { label: "下载中", color: "var(--accent-strong)", soft: "var(--accent-soft)" },
  transcribing: { label: "获取口播中", color: "var(--accent-strong)", soft: "var(--accent-soft)" },
  extracting: { label: "识别镜头中", color: "var(--accent-strong)", soft: "var(--accent-soft)" },
  analyzing: { label: "分析中", color: "var(--accent-strong)", soft: "var(--accent-soft)" },
  completed: { label: "已完成", color: "var(--success)", soft: "var(--success-soft)" },
  failed: { label: "失败", color: "var(--danger)", soft: "var(--danger-soft)" },
  stopped: { label: "已停止", color: "var(--text-faint)", soft: "var(--surface-2)" },
  waiting: { label: "待处理", color: "var(--text-faint)", soft: "var(--surface-2)" },
};

export function statusMeta(status: string) {
  return STATUS_META[status] || { label: status, color: "var(--text-faint)", soft: "var(--surface-2)" };
}
