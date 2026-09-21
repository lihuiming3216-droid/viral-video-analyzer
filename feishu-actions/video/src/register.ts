import { basekit, Component } from "@lark-opdev/block-basekit-server-api";

const ENDPOINT = "https://52.37.212.216/api/feishu/app-actions/video";

basekit.addDomainList(["52.37.212.216"]);

function fieldMap(args: Record<string, unknown>) {
  const pairs: Array<[string, unknown]> = [
    ["videoUrl", args.videoUrlField],
    ["videoFile", args.videoFileField],
    ["transcript", args.transcriptField],
    ["translation", args.translationField],
    ["status", args.statusField],
    ["linkedSubtitle", args.linkedSubtitleField],
    ["timestampedTranscript", args.timestampedTranscriptField],
    ["timestampedTranslation", args.timestampedTranslationField],
  ];
  return Object.fromEntries(pairs.filter(([, value]) => typeof value === "string" && value.trim())
    .map(([key, value]) => [key, String(value).trim()]));
}

basekit.addAction({
  description: "读取触发行的 TikTok 链接，调用 TokScript，并把视频文件、原口播和中文翻译分别回填到空白字段。",
  actionText: "处理视频链接",
  useTenantAccessToken: true,
  permission: { type: 2 },
  formItems: [
    {
      itemId: "standardFields",
      component: Component.Tips,
      componentProps: { message: "默认自动识别：视频链接、视频文件、原口播、中文翻译等常用表头。已有文字或附件不会被覆盖。" },
    },
    {
      itemId: "advancedFields",
      component: Component.Collapse,
      componentProps: { displayItems: ["videoUrlField", "videoFileField", "transcriptField", "translationField", "statusField", "linkedSubtitleField", "timestampedTranscriptField", "timestampedTranslationField"] },
    },
    { itemId: "videoUrlField", label: "视频链接字段名", component: Component.Input, required: false, componentProps: { placeholder: "视频链接" } },
    { itemId: "videoFileField", label: "视频文件字段名", component: Component.Input, required: false, componentProps: { placeholder: "视频文件" } },
    { itemId: "transcriptField", label: "原口播字段名", component: Component.Input, required: false, componentProps: { placeholder: "原口播" } },
    { itemId: "translationField", label: "中文翻译字段名", component: Component.Input, required: false, componentProps: { placeholder: "中文翻译" } },
    { itemId: "statusField", label: "状态字段名", component: Component.Input, required: false, componentProps: { placeholder: "分析状态" } },
    { itemId: "linkedSubtitleField", label: "链接字幕字段名", component: Component.Input, required: false, componentProps: { placeholder: "链接字幕" } },
    { itemId: "timestampedTranscriptField", label: "时间戳原口播字段名", component: Component.Input, required: false, componentProps: { placeholder: "时间戳原口播" } },
    { itemId: "timestampedTranslationField", label: "时间戳中文字段名", component: Component.Input, required: false, componentProps: { placeholder: "时间戳中文" } },
  ],
  execute: async (args, context) => {
    const appToken = context.app?.token;
    const tableId = context.app?.trigger?.tableID;
    const recordId = context.app?.trigger?.recordID;
    if (!appToken || !tableId || !recordId) throw new Error("飞书没有提供触发行，请将此动作放在记录新增或修改自动化中");
    if (!context.tenantAccessToken) throw new Error("飞书没有提供应用授权，请确认动作已启用 tenant access token");
    const response = await context.fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${context.tenantAccessToken}`,
      },
      body: JSON.stringify({
        appToken,
        tableId,
        recordId,
        packId: context.packID,
        extensionId: context.extensionID,
        fieldMap: fieldMap(args),
      }),
    });
    const result = await response.json() as { code?: number; msg?: string; accepted?: boolean };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "视频处理请求失败");
    return { accepted: true, message: result.msg || "已接收" };
  },
  resultType: {
    type: "object",
    properties: {
      accepted: { label: "是否已接收", type: "boolean" },
      message: { label: "处理说明", type: "string" },
    },
  },
});

export default basekit;
