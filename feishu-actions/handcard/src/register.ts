import { basekit, Component } from "@lark-opdev/block-basekit-server-api";

const ENDPOINT = "https://52.37.212.216/api/feishu/app-actions/handcard";

basekit.addDomainList(["52.37.212.216"]);

function fieldMap(args: Record<string, unknown>) {
  const pairs: Array<[string, unknown]> = [
    ["pid", args.pidField],
    ["productName", args.productNameField],
    ["productDocument", args.productDocumentField],
    ["productCardStatus", args.productCardStatusField],
  ];
  return Object.fromEntries(pairs.filter(([, value]) => typeof value === "string" && value.trim())
    .map(([key, value]) => [key, String(value).trim()]));
}

basekit.addAction({
  description: "读取触发行的 PID，创建或复用产品手卡，并只回填这一行。产品名称可留空自动获取。",
  actionText: "补录手卡",
  useTenantAccessToken: true,
  permission: { type: 2 },
  formItems: [
    {
      itemId: "standardFields",
      component: Component.Tips,
      componentProps: { message: "默认自动识别：商品ID/PID、产品名称、产品手卡/产品文档、手卡状态。表头不同时再展开高级设置。" },
    },
    {
      itemId: "advancedFields",
      component: Component.Collapse,
      componentProps: { displayItems: ["pidField", "productNameField", "productDocumentField", "productCardStatusField"] },
    },
    { itemId: "pidField", label: "PID 字段名", component: Component.Input, required: false, componentProps: { placeholder: "商品ID" } },
    { itemId: "productNameField", label: "产品名称字段名", component: Component.Input, required: false, componentProps: { placeholder: "产品名称" } },
    { itemId: "productDocumentField", label: "手卡链接字段名", component: Component.Input, required: false, componentProps: { placeholder: "产品手卡" } },
    { itemId: "productCardStatusField", label: "手卡状态字段名", component: Component.Input, required: false, componentProps: { placeholder: "手卡状态" } },
  ],
  execute: async (args, context) => {
    const appToken = context.app?.token;
    const tableId = context.app?.trigger?.tableID;
    const recordId = context.app?.trigger?.recordID;
    if (!appToken || !tableId || !recordId) throw new Error("飞书没有提供触发行，请将此动作放在当前行按钮自动化中");
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
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "补录手卡请求失败");
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
