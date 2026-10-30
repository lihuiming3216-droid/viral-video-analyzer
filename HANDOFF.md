# HANDOFF · 爆品拆解（viral-video-analyzer）

> 交接时间：2026-10-30。由 Claude 根据仓库文档和 Codex 会话「爆品拆解飞书日常运维」整理。
> ⚠️ **本仓库是公开（public）仓库。** 这份文件不写服务器地址、账号或任何密钥；不要往仓库里提交真实凭据。

## 1. 位置与状态

- 本机目录：`~/Documents/ChatGPT/爆品拆解/viral-video-analyzer`
  - 上一级 `爆品拆解/` 也是一个 git 仓库，但没有任何提交，只放了 PID 代码包、二维码截图、报告等杂项。它不是本项目。
- 交接时本机 `main` 和 `origin/main` 一致（`addce4e`，2026-10-22），没有未提交、也没有未推送的改动。
- 本机还有 4 个 `codex/*` 分支没推送到远端，但它们的提交都已经合进 `main`，无需处理。

## 2. 部署方式（重要）

- **推送 `main` 会自动部署到生产。** 触发的是 `.github/workflows/deploy.yml`（Deploy to AWS Lightsail），流程如下：
  1. 构建镜像
  2. 运行部署保护测试和隔离 MySQL 冒烟测试
  3. 通过 scp 上传 release 包
  4. 通过 ssh 在服务器上执行 `deploy/update-server.sh --check`，再执行 `--apply`
- 服务器地址、用户名和密钥都在 GitHub Secrets 里：`ECS_HOST`、`ECS_USER`、`ECS_SSH_KEY`。
- 推送 `codex/verify-handcard-*` 分支会触发 `.github/workflows/verify-handcard.yml`。这是隔离验收流程，不部署，也不带生产凭证。
- 其他分支（包括本交接用的 `docs/handoff-20261030`）不会触发任何部署。
- 服务器上的目录是 `/opt/viral-video-analyzer`，包括 `.env`、`releases/<sha>` 和 docker compose。生产数据在 docker 卷 `viral-video-analyzer_mysql_data` 和 `viral-video-analyzer_viral_data` 里。`update-server.sh` 只更新应用，从不初始化 MySQL。
- **同一台服务器上还跑着 TK Radar（爆款雷达）**，路径是 `/opt/tk-radar`，Nginx 代理在 `/radar/` 下。清理服务器时不要碰它。

## 3. 文档索引

| 文档 | 内容 |
| --- | --- |
| [README.md](README.md) | 功能、飞书机器人/多维表格自动化、数据位置、开发检查 |
| [deploy/ISOLATED_ACCEPTANCE.md](deploy/ISOLATED_ACCEPTANCE.md) | 隔离验收。Compose 文件指向生产卷，不能直接拿来做本地测试 |
| [deploy/AI_SETTINGS.md](deploy/AI_SETTINGS.md) | 模型设置 |
| [deploy/RELIABILITY_AUDIT_20260930.md](deploy/RELIABILITY_AUDIT_20260930.md) | 2026-09-30 可靠性审计 |
| `deploy/HANDCARD_*.md`、`PDP_SCHEMA_RECOVERY.md`、`PRODUCT_CATALOG.md`、`TIKTOK_DOWNLOAD_FALLBACK.md` | 手卡、商品目录、下载回退等专题说明 |

开发检查：`pnpm run check`、`pnpm test`（需要隔离 MySQL，不能指向生产库）、`pnpm run build`。

## 4. 最近的改动（2026-10-19 ～ 10-22，均已部署）

- **10-19**：新增事件驱动的 TokScript 优质视频库（5 个隔离槽位），修复原生事件精度、并发领取等问题。
- **10-21**：
  - 停用优质视频库的专用链路，改走通用的 `POST /api/feishu/task-table`。
  - 停用手卡里的视频分析功能，保留文件翻译回填。
  - 任务表可复用已授权的 chatgpt 应用凭证。
- **10-22**：
  - `744d217`：每轮检查都扫描所有手卡文档里的视频链接。目前是两层检查：大约每 20 秒检查一次所有手卡有没有修改，有修改的再去读取链接。
  - `addce4e`（**Codex 最后一次代码修复**）：飞书文档读取限流。主要做了三件事：
    - 按节奏读取飞书文档；
    - 被限流后退避重试，不会成倍放大请求；
    - 等待超时后不再继续发请求，并优先处理新修改的内容。
  - 结果：513 项云端测试通过，上线后观察 6 分钟以上，没有出现未恢复的限流报错。

  同一轮还删除了用户批准的两份旧镜像，保留当前版和上一版，磁盘占用降到约 80%。

## 5. 未完成 / 待处理

1. **用户 10-30 的请求，Codex 还没处理：**「删了的功能就不要在服务器上留了，把服务器空间清一清」。
   - 这里「删了的功能」指 10-21 停用的优质视频库专用链路和手卡视频分析。它们的历史数据目前**有意保留**在生产上：
     - 数据表 `feishu_video_library_rows`、`feishu_video_library_tasks`
     - 目录 `.data/media/video-library/` 和旧配置
   - 删之前要先备份，并让用户确认删除范围。生产缓存和原片删了就无法恢复。
   - 清理镜像时保留当前版和上一版；不要碰 `/opt/tk-radar` 和 MySQL 数据卷。
2. 用户随后又提出「项目导出一下」，Codex 也没回应。这次交接（推送仓库 + 本文件）可以部分满足这个需求；要不要连服务器数据一起导出，需要再确认。
3. 历史测试 `pnpm run test:legacy` 有 31 项已知失败，属于已停用的商品链接分析，没有修复，见 `tests/legacy/README.md`。

## 6. 安全提醒

- 密钥放在服务器的 `.env` 和 `.data/secret.key` 里（用于解密已保存的 API Key），后台登录散列在 `.data/admin-auth.json`。这些都不在仓库里，迁移时必须和 MySQL 一起保留。
- README 里有飞书 Base / 表 ID，这些不是密钥，但仓库是公开的，可以考虑把仓库设为私有。
