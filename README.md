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

### 工作区邀请

- `POST /v1/workspaces/:id/invitations`（仅 OWNER）：创建邀请，请求体 `{ email, role, ttlMinutes? }`。`role` 只能是 `EDITOR/COMMENTER/VIEWER`，`ttlMinutes` 范围 1～43200（默认 10080，即 7 天）。明文令牌只在创建响应中返回一次，数据库仅保存 SHA-256 哈希。
- `GET /v1/workspaces/:id/invitations`（仅 OWNER）：列出邀请，状态为 `PENDING/ACCEPTED/REVOKED/EXPIRED`。
- `DELETE /v1/workspaces/:id/invitations/:invitationId`（仅 OWNER）：撤回待接受邀请。
- `POST /v1/invitations/accept`：请求体 `{ token }`，仅接受邮箱与登录账号一致的邀请，成功后以邀请中的角色加入工作区。
- `GET /v1/invitations/:token`：接受前的邀请预览。

邀请为**单次使用**且带有效期；接受操作在单个 `SERIALIZABLE` 事务中完成（`SELECT … FOR UPDATE` 锁定邀请行与工作区行，条件 `updateMany` 原子认领 PENDING 令牌）。因此以下情况在并发下都会确定失败，且不会产生多余成员：令牌被重复接受、邀请已撤回或已过期、工作区成员已达 `Workspace.memberLimit`（默认 50）上限、登录账号与邀请邮箱不一致、同一邮箱已存在待接受邀请（数据库 `activeKey` 唯一约束兜底）。撤回与并发接受互斥（恰好一方成功）。


健康检查为 `GET /health` 和 `GET /ready`。

## 存储

默认将原始音频保存到仓库根目录下的 `storage/`，并通过带权限校验的 API 流式读取。可通过 `STORAGE_DIR` 修改路径。`docker-compose.yml` 中的 MinIO 使用 `object-storage` profile，当前不会随 `postgres redis` 一起启动：

```bash
docker compose --profile object-storage up -d minio
```

生产环境应使用独立数据库、Redis、对象存储和 secret manager，不要把 `.env` 或真实密钥提交到仓库。
