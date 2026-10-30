# HANDOFF · 爆品拆解（viral-video-analyzer）

> 更新：2026-10-31。仓库是公开的，这里不写服务器地址、账号或密钥。

## 部署

- 推送 `main` = 自动部署（`.github/workflows/deploy.yml`：构建 → 离线测试 → 隔离 MySQL 冒烟 → 上传 → 服务器 `update-server.sh --check/--apply`，失败自动回滚到上一版镜像）。
- `codex/verify-handcard-*` 分支只跑隔离验收；其他分支不触发任何流程。
- 服务器目录 `/opt/viral-video-analyzer`；数据在 docker 卷 `viral-video-analyzer_mysql_data`、`viral-video-analyzer_viral_data`（含 `.data/secret.key`、`.data/admin-auth.json`、`.data/media`）。同机还有 TK Radar（`/opt/tk-radar`，Nginx `/radar/`），不要动。
- 运维命令通道：私有仓库 `tk-radar` 的 `ops/run` 分支（推送即在服务器执行 `ops/task.sh`，输出在 `ops/log` 分支）。批量删除生产数据由负责人本人在服务器终端执行。

## 2026-10-31 审查后的范围（负责人确认）

保留：飞书多维表格自动化、产品手卡、飞书应用动作按钮、字幕入口、运维后台。
已删除：网页完整拆解/评分、两条视频对比、学习中心、网页上传、飞书机器人对话、Prompt 调试台、Qwen 完整视频分析与分镜、退役的商品链接解析及历史测试。数据库里的历史表和字段（scenes、learning_*、prompt_* 等）原样保留，代码不再读写。

其他决定：
- 原口播/翻译优先：TokScript 一返回原口播就写回飞书，不等视频下载；文件可以慢一点。TokScript 不加自动重试。
- 本机原片任务结束 30 天后自动删除（`lib/media-retention.ts`，`MEDIA_RETENTION_DAYS`），只删 TikTok 下载缓存；有待回填任务、仍在处理的任务和历史上传文件不删。
- 「任务安排表测试表」字段映射已从生产库删除；保留「新人组拍摄计划·任务安排表」等 4 个映射。

## 测试

```bash
pnpm run check && pnpm run lint && pnpm test   # 数据库用例需隔离 MySQL（PID_AUDIT_MYSQL_SOCKET 或 smoke-test.sh）
pnpm run build
```

新增测试文件必须同时列入 `deploy.yml`、`verify-handcard.yml` 和 `deploy/smoke-test.sh`（`tests/test-suite-boundary.test.mjs` 会检查）。
