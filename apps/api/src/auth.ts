import type { FastifyReply, FastifyInstance, FastifyRequest } from 'fastify';
import { Role, type PrismaClient } from '@prisma/client';
import { HttpError } from './errors.js';

export type AuthUser = { id: string; email: string };
export type JwtRequest = FastifyRequest & { user: AuthUser };

export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    await reply.code(401).send({
      error: { code: 'UNAUTHENTICATED', message: '请先登录' },
    });
  }
}

export function authUser(req: FastifyRequest): AuthUser {
  return req.user as AuthUser;
}

export async function findMembership(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  roles?: Role[],
) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!membership || (roles && !roles.includes(membership.role))) {
    return null;
  }
  return membership;
}

export async function requireMembership(
  req: FastifyRequest,
  prisma: PrismaClient,
  workspaceId: string,
  roles?: Role[],
): Promise<void> {
  const membership = await findMembership(
    prisma,
    workspaceId,
    authUser(req).id,
    roles,
  );
  if (!membership) {
    throw new HttpError(404, 'NOT_FOUND', '资源不存在');
  }
}

export async function resolveRequestUser(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  const queryToken =
    typeof (req.query as { token?: unknown } | undefined)?.token === 'string'
      ? (req.query as { token: string }).token
      : undefined;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken;
  if (!token) return null;

  try {
    return await app.jwt.verify<AuthUser>(token);
  } catch {
    return null;
  }
}
