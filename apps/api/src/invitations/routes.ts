import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Role, type PrismaClient } from '@prisma/client';
import { authenticate, authUser, requireMembership } from '../auth.js';
import { HttpError } from '../errors.js';
import {
  acceptInvitation,
  createInvitation,
  hashInvitationToken,
  listInvitations,
  revokeInvitation,
} from './service.js';

export interface InvitationsRoutesDeps {
  prisma: PrismaClient;
}

export const invitationRoutes: FastifyPluginAsync<InvitationsRoutesDeps> = async (
  app: FastifyInstance,
  options,
) => {
  const { prisma } = options;

  // 创建邀请：仅工作区 OWNER
  app.post(
    '/v1/workspaces/:id/invitations',
    { preHandler: authenticate },
    async (req, reply) => {
      const workspaceId = (req.params as { id: string }).id;
      await requireMembership(req, prisma, workspaceId, [Role.OWNER]);
      const { invitation, token } = await createInvitation(prisma, {
        workspaceId,
        actorId: authUser(req).id,
        body: req.body,
      });
      return reply
        .code(201)
        .send({ data: { ...invitation, token } });
    },
  );

  // 邀请列表：仅工作区 OWNER
  app.get(
    '/v1/workspaces/:id/invitations',
    { preHandler: authenticate },
    async (req) => {
      const workspaceId = (req.params as { id: string }).id;
      await requireMembership(req, prisma, workspaceId, [Role.OWNER]);
      return { data: await listInvitations(prisma, workspaceId) };
    },
  );

  // 撤回邀请：仅工作区 OWNER
  app.delete(
    '/v1/workspaces/:id/invitations/:invitationId',
    { preHandler: authenticate },
    async (req) => {
      const workspaceId = (req.params as { id: string }).id;
      const invitationId = (req.params as { invitationId: string }).invitationId;
      await requireMembership(req, prisma, workspaceId, [Role.OWNER]);
      const invitation = await revokeInvitation(prisma, {
        workspaceId,
        invitationId,
        actorId: authUser(req).id,
      });
      return { data: invitation };
    },
  );

  // 接受邀请：任意已登录用户；邮箱、角色、有效期、满额、单次使用由服务层裁定
  app.post('/v1/invitations/accept', { preHandler: authenticate }, async (req) => {
    const user = authUser(req);
    // authUser 只携带 JWT 中的 id/email，邮箱以数据库中的为准（小写规范化）
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true },
    });
    if (!dbUser) {
      throw new HttpError(401, 'UNAUTHENTICATED', '请先登录');
    }
    const body = (req.body ?? {}) as { token?: unknown };
    const result = await acceptInvitation(prisma, {
      token: body.token,
      userId: dbUser.id,
      userEmail: dbUser.email,
    });
    return {
      data: {
        workspaceId: result.workspaceId,
        role: result.role,
        joinedAt: result.membership.joinedAt.toISOString(),
      },
    };
  });

  // 邀请详情（令牌形式）：供接受前确认页面使用，仅返回最小信息
  app.get('/v1/invitations/:token', { preHandler: authenticate }, async (req) => {
    const token = (req.params as { token: string }).token;
    const row = await prisma.workspaceInvitation.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
      include: { workspace: { select: { id: true, name: true } } },
    });
    if (!row) {
      throw new HttpError(404, 'INVITATION_NOT_FOUND', '邀请不存在或链接无效');
    }
    const now = new Date();
    const effectiveStatus =
      row.status === 'PENDING' && row.expiresAt <= now ? 'EXPIRED' : row.status;
    return {
      data: {
        workspaceId: row.workspaceId,
        workspaceName: row.workspace.name,
        email: row.email,
        role: row.role,
        status: effectiveStatus,
        expiresAt: row.expiresAt.toISOString(),
      },
    };
  });
};
