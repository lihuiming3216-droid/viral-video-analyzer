# TikTok PDP 数据结构兼容与手卡恢复（2026-09-30）

故障：9月25日以来的新商品页面把主体资料放到了组件的
`component_data.product_info`。旧 `product_model` 只剩 PID 和卖家 ID，
导致旧解析器拒绝有效商品页面，Qwen 尚未开始。

修复同时接受精确 PID 的旧 product_model 和新 product_info。新结构的
title、desc_blocks（包含普通文字和列表）、specifications、SKU price/stock
及 seller 被归一化为原有商品字段。详情图每个图片对象只取一个可用 CDN 地址，
下游最多分析八张，不以主图或 SKU 图补位。

已有失败页面通过 SHA-256 校验后可以重新解析，无需重新抓取或调用付费供应商。
原始 HTML、请求标记及失败回执都会保留。缺失、被改动、错误 PID 或验证页
仍会失败，绝不会通过清空请求标记重复取数。

后台补录和维护脚本共享 `lib/products/backfill.ts`，仅填写六个基础字段中
的空白/失败占位内容，重复字段或 PID 不一致会阻止写入。

## 手工维护

在应用容器的 /app 目录下执行脚本（将本文件夹中的脚本通过 stdin 送入 node）：

```sh
docker exec -i viral-video-analyzer node - --since 2026-09-25 < deploy/recover-public-handcards.cjs
docker exec -i viral-video-analyzer node - --since 2026-09-25 --pid 1732245915614220594 --apply < deploy/recover-public-handcards.cjs
```

默认只读核验。--apply 会发布已校验的缓存、调用当前配置模型整理资料并补录；
它不重新抓取商品页，也不请求出海匠。模型调用可能收费，原有一次性分析标记仍有效。
省略 --pid 时处理日期范围内有手卡的同类失败资料，每个文档串行处理。
分析已失败/结果不确定的记录只报告，不自行再次调用模型。

每份文档的补录前快照和回读结果保存在
`.data/maintenance/pdp-components-v1/<documentId>/`。
脚本验证人工已有字段及六项基础字段之外的所有文档块未改变；不一致时停止批次。

飞书 SDK 日志现在只记录错误码与 HTTP 状态，避免将 Axios 请求头及临时令牌输出。
