import { VIDEO_LIBRARY_FIELDS, VIDEO_LIBRARY_SCOPE } from "@/lib/feishu/video-library-policy";

/** Native workflow definitions, not a polling schedule. Secret stays in headers. */
export function videoLibraryWorkflow(input: {
  kind: "add" | "change"; tableName: string; sourceFieldId: string; endpoint: string; secret: string;
  eventTimeFieldId: string;
  outputFieldIds: { transcript: string; translation: string; file: string };
}) {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "52.37.212.216"
    || endpoint.pathname !== "/api/feishu/video-library" || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("视频库自动化只能请求已确认的 HTTPS 服务器入口");
  }
  if ([input.sourceFieldId, input.eventTimeFieldId, ...Object.values(input.outputFieldIds)].some(id => !/^fld[A-Za-z0-9]+$/.test(id)) || !input.secret || !input.tableName) throw new Error("缺少真实字段或鉴权配置");
  const fieldCondition = { field_name: VIDEO_LIBRARY_FIELDS.source, operator: "isNotEmpty", value: [] };
  const trigger = {
    id: "step_trigger", type: input.kind === "add" ? "AddRecordTrigger" : "SetRecordTrigger",
    title: input.kind === "add" ? "新增非空视频链接" : "视频链接修改为非空时",
    next: "step_call_server",
    data: input.kind === "add" ? {
      table_name: input.tableName, watched_field_name: VIDEO_LIBRARY_FIELDS.source,
      trigger_control_list: ["automationBatchUpdate", "syncUpdate"],
      condition_list: [{ conjunction: "and", conditions: [fieldCondition] }],
    } : {
      table_name: input.tableName, record_watch_conjunction: "and", record_watch_info: [],
      field_watch_info: [fieldCondition], condition_list: null,
      trigger_control_list: ["automationBatchUpdate", "syncUpdate"],
    },
  };
  const literal = (key: string, value: string) => ({ key, value: [{ value_type: "text", value }] });
  const reference = (key: string, value: string) => ({ key, value: [{ value_type: "ref", value }] });
  return {
    title: input.kind === "add" ? "流程A：新增视频自动入库" : "流程B：视频自动转写",
    steps: [trigger, {
      id: "step_call_server", type: "HTTPClientAction", title: "提交原口播、中文和视频文件处理",
      data: {
        method: "POST", url: [{ value_type: "text", value: endpoint.toString() }],
        body_type: "form-urlencoded",
        form_body: [literal("appToken", VIDEO_LIBRARY_SCOPE.appToken), literal("tableId", VIDEO_LIBRARY_SCOPE.tableId),
          reference("recordId", "$.step_trigger.recordId"),
          reference("sourceUrl", `$.step_trigger.${input.sourceFieldId}`),
          // Built-in recordModifiedTime is rendered to minutes in native HTTP
          // forms. A real ModifiedTime field's timestamp child preserves ms.
          reference("eventTime", `$.step_trigger.${input.eventTimeFieldId}.timestamp`),
          reference("snapshotTranscript", `$.step_trigger.${input.outputFieldIds.transcript}`),
          reference("snapshotTranslation", `$.step_trigger.${input.outputFieldIds.translation}`),
          reference("snapshotFileTokens", `$.step_trigger.${input.outputFieldIds.file}.fileToken`)],
        headers: [literal("x-feishu-automation-secret", input.secret)],
        raw_body: [{ value_type: "text", value: "{}" }], response_type: "none", response_value: "{}",
      },
    }],
  };
}
