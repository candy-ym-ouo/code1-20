# 口述家史编辑器

React + TypeScript 前端、Fastify API、BullMQ worker、PostgreSQL 和 Redis 组成的 pnpm monorepo。当前版本支持注册登录、创建工作区、上传真实音频、异步读取音频时长、创建固定时间范围片段、按时间段播放，以及章节/内容块和发布接口。

## 环境要求

- Node.js 22.13 或更高版本
- pnpm 9
- Docker（本地 PostgreSQL、Redis）
- FFmpeg 可选。worker 优先使用 `ffprobe`，未安装时会使用 `music-metadata` 读取常见音频时长

## 本地启动

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

打开 <http://localhost:5173>。首次注册会自动登录并创建一个默认工作区；上传音频后，worker 会异步读取元数据，状态变为 `READY` 后即可创建片段。

开发阶段也可以用 `pnpm db:push` 直接同步 schema。根目录脚本会自动读取 `.env`；若文件不存在则回退到 `.env.example`。

## 检查

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 主要接口

- `POST /v1/auth/register`、`POST /v1/auth/login`
- `GET/POST /v1/workspaces`
- `POST /v1/workspaces/:id/invitations`、`GET /v1/workspaces/:id/invitations`（仅 OWNER）
- `GET /v1/invitations/:token`（令牌预览，无需登录）、`POST /v1/invitations/:token/accept`、`DELETE /v1/invitations/:id`
- `POST /v1/workspaces/:id/recordings/uploads`
- `GET /v1/recordings/:id/file`（支持 HTTP Range）
- `GET/POST /v1/recordings/:id/clips`
- `PATCH /v1/clips/:id`（乐观锁，版本冲突返回 409）
- `GET/POST /v1/workspaces/:id/chapters`
- `PATCH /v1/chapters/:id`
- `POST /v1/chapters/:id/blocks`
- `POST /v1/chapters/:id/publish`
- `GET /v1/workspaces/:id/events`
- `GET /v1/realtime?workspaceId=...`（WebSocket）

健康检查为 `GET /health` 和 `GET /ready`。

## 工作区邀请

邀请由工作区 OWNER 发起，角色限定为 `EDITOR`、`COMMENTER`、`VIEWER`，有效期 5 分钟至 30 天（默认 7 天）。创建时返回一次性明文令牌（`wvinv_` 前缀，32 字节随机），数据库只保存其 SHA-256 摘要；接受后令牌变为 `ACCEPTED`，不可再次使用。受邀邮箱与接受账号的邮箱必须一致。

并发安全由数据库保证：同一工作区的创建/撤回/接受事务先对工作区行 `SELECT … FOR UPDATE` 串行化；`(workspaceId, lower(email)) WHERE status = 'PENDING'` 部分唯一索引防止重复待接受邀请，接受时对邀请行做 `status = 'PENDING'` 条件更新，并依赖 `WorkspaceMember` 复合主键兜底。因此成员满额（`Workspace.memberLimit`，默认 50）、重复邀请或撤回之后的并发接受都确定失败，成员数绝不会超额。

邀请相关集成测试（`apps/api/src/__tests__/`）使用 embedded-postgres 启动真实的 PostgreSQL 16，覆盖单次使用、邮箱角色校验、过期、撤回并发交错与满额竞争场景；可通过 `TEST_DATABASE_URL` 指向外部数据库运行。

## 存储

默认将原始音频保存到仓库根目录下的 `storage/`，并通过带权限校验的 API 流式读取。可通过 `STORAGE_DIR` 修改路径。`docker-compose.yml` 中的 MinIO 使用 `object-storage` profile，当前不会随 `postgres redis` 一起启动：

```bash
docker compose --profile object-storage up -d minio
```

生产环境应使用独立数据库、Redis、对象存储和 secret manager，不要把 `.env` 或真实密钥提交到仓库。
