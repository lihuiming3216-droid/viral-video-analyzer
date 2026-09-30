import type { FeishuAutomationFieldMap } from "@/lib/feishu/automation";

/** Only normalized business input; never HTTP headers, tokens or webhook secrets. */
export type FeishuInboxInput = {
  kind: "handcard" | "video";
  credentialSource: "primary" | "chatgpt";
  appToken: string;
  tableId: string;
  recordId: string;
  fields: Record<string, unknown>;
  fieldMap: Partial<FeishuAutomationFieldMap>;
};
