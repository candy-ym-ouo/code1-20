import {
  Prisma,
  PrismaClient,
  Role,
  type PrismaClient as PrismaClientType,
  type WorkspaceInvitation,
} from '@prisma/client';
import crypto from 'node:crypto';
import { HttpError, notFound } from './errors.js';

type DbClient = PrismaClientType | Prisma.TransactionClient;

export const INVITABLE_ROLES = [Role.EDITOR, Role.COMMENTER, Role.VIEWER] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'wvinv_';

const invitationFields = [
  'id',
  'workspaceId',
  'email',
  'role',
  'status',
  'expiresAt',
  'acceptedAt',
  'acceptedById',
  'revokedAt',
  'createdById',
  'createdAt',
  'updatedAt',
] as const;

export type InvitationView = Pick<WorkspaceInvitation, (typeof invitationFields)[number]>;

export type CreatedInvitation = {
  invitation: InvitationView;
  /** 明文令牌仅在创建时返回一次，数据库中只保存 SHA-256 摘要。 */
  token: string;
};

function isInvitableRole(role: Role): role is InvitableRole {
  return (INVITABLE_ROLES as readonly Role[]).includes(role);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashInvitationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateInvitationToken(): string {
  return TOKEN_PREFIX.concat(crypto.randomBytes(32).toString('base64url'));
}

function normalizeTtl(ttlSeconds: number | undefined): number {
  const ttlMs = ttlSeconds === undefined ? DEFAULT_TTL_MS : ttlSeconds * 1000;
  if (ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new HttpError(400, 'INVALID_INVITATION_TTL', '邀请有效期需在 5 分钟到 30 天之间');
  }
  return ttlMs;
}

/**
 * 锁定工作区行。所有创建/撤回/接受操作都先取同一把行锁，
 * 同一工作区的邀请流程因此被串行化，配合唯一约束保证结果确定。
 */
async function lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} AND "deletedAt" IS NULL FOR UPDATE`,
  );
  if (rows.length === 0) throw notFound('工作区不存在');
}

export async function findMembership(
  db: DbClient,
  workspaceId: string,
  userId: string,
): Promise<{ workspaceId: string; userId: string; role: Role } | null> {
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return membership as { workspaceId: string; userId: string; role: Role } | null;
}

export async function recordEvent(
  db: DbClient,
  workspaceId: string,
  actorId: string,
  resourceType: string,
  resourceId: string,
  operation: string,
  payload: unknown,
) {
  return db.collaborationEvent.create({
    data: {
      workspaceId,
      actorId,
      resourceType,
      resourceId,
      operation,
      payloadJson: payload as Prisma.InputJsonValue,
    },
  });
}

function toView(invitation: WorkspaceInvitation): InvitationView {
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    acceptedById: invitation.acceptedById,
    revokedAt: invitation.revokedAt,
    createdById: invitation.createdById,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
  };
}

export type CreateInvitationInput = {
  workspaceId: string;
  actorId: string;
  email: string;
  role: Role;
  ttlSeconds?: number;
};

export async function createInvitation(
  db: PrismaClientType,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  if (!isInvitableRole(input.role)) {
    throw new HttpError(400, 'INVALID_INVITATION_ROLE', '邀请角色只能是 EDITOR、COMMENTER 或 VIEWER');
  }
  const email = normalizeEmail(input.email);
  const ttlMs = normalizeTtl(input.ttlSeconds);
  const token = generateInvitationToken();
  const tokenHash = hashInvitationToken(token);

  try {
    const invitation = await db.$transaction(
      async (tx) => {
        await lockWorkspace(tx, input.workspaceId);

        const actor = await findMembership(tx, input.workspaceId, input.actorId);
        if (!actor || actor.role !== Role.OWNER) {
          throw new HttpError(403, 'FORBIDDEN', '只有工作区所有者可以邀请成员');
        }

        const existingMember = await tx.workspaceMember.findFirst({
          where: { workspaceId: input.workspaceId, user: { email } },
          select: { userId: true },
        });
        if (existingMember) {
          throw new HttpError(409, 'INVITATION_ALREADY_MEMBER', '该用户已经是工作区成员');
        }

        const pending = await tx.workspaceInvitation.findFirst({
          where: { workspaceId: input.workspaceId, email, status: 'PENDING' },
          select: { id: true },
        });
        if (pending) {
          throw new HttpError(409, 'INVITATION_DUPLICATE', '该邮箱已有待接受的邀请');
        }

        return tx.workspaceInvitation.create({
          data: {
            workspaceId: input.workspaceId,
            email,
            role: input.role,
            tokenHash,
            expiresAt: new Date(Date.now() + ttlMs),
            createdById: input.actorId,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    return { invitation: toView(invitation), token };
  } catch (error) {
    // 部分唯一索引 WorkspaceInvitation_pending_email_key 兜底，
    // 即便行锁检查被绕过也不会产生两条待接受邀请。
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new HttpError(409, 'INVITATION_DUPLICATE', '该邮箱已有待接受的邀请');
    }
    throw error;
  }
}

export async function listInvitations(
  db: PrismaClientType,
  workspaceId: string,
  actorId: string,
): Promise<InvitationView[]> {
  const actor = await findMembership(db, workspaceId, actorId);
  if (!actor) throw notFound('工作区不存在');
  if (actor.role !== Role.OWNER) {
    throw new HttpError(403, 'FORBIDDEN', '只有工作区所有者可以查看邀请');
  }

  const rows = await db.workspaceInvitation.findMany({
    where: { workspaceId },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.map(toView);
}

export type InvitationPreview = {
  invitation: InvitationView;
  workspace: { id: string; name: string };
  isExpired: boolean;
};

export async function previewInvitation(
  db: PrismaClientType,
  rawToken: string,
): Promise<InvitationPreview> {
  const invitation = await db.workspaceInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(rawToken) },
  });
  if (!invitation) {
    throw new HttpError(404, 'INVITATION_NOT_FOUND', '邀请不存在或已失效');
  }

  const workspace = await db.workspace.findFirst({
    where: { id: invitation.workspaceId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!workspace) throw new HttpError(404, 'INVITATION_NOT_FOUND', '邀请不存在或已失效');

  return {
    invitation: toView(invitation),
    workspace: { id: workspace.id, name: workspace.name },
    isExpired: invitation.status === 'PENDING' && invitation.expiresAt.getTime() <= Date.now(),
  };
}

export async function revokeInvitation(
  db: PrismaClientType,
  invitationId: string,
  actorId: string,
): Promise<InvitationView> {
  const invitation = await db.$transaction(async (tx) => {
    const current = await tx.workspaceInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!current) throw new HttpError(404, 'INVITATION_NOT_FOUND', '邀请不存在或已失效');

    await lockWorkspace(tx, current.workspaceId);

    const actor = await findMembership(tx, current.workspaceId, actorId);
    if (!actor || actor.role !== Role.OWNER) {
      throw new HttpError(403, 'FORBIDDEN', '只有工作区所有者可以撤回邀请');
    }

    if (current.status !== 'PENDING') {
      throw new HttpError(
        409,
        current.status === 'ACCEPTED' ? 'INVITATION_ALREADY_USED' : 'INVITATION_REVOKED',
        current.status === 'ACCEPTED' ? '邀请已被接受，无法撤回' : '邀请已撤回',
      );
    }
    if (current.expiresAt.getTime() <= Date.now()) {
      throw new HttpError(410, 'INVITATION_EXPIRED', '邀请已过期');
    }

    const revokedCount = await tx.workspaceInvitation.updateMany({
      where: { id: current.id, status: 'PENDING' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    if (revokedCount.count === 0) {
      // 并发情况下可能已被接受或撤回。
      const latest = await tx.workspaceInvitation.findUniqueOrThrow({
        where: { id: current.id },
      });
      throw new HttpError(
        409,
        latest.status === 'ACCEPTED' ? 'INVITATION_ALREADY_USED' : 'INVITATION_REVOKED',
        latest.status === 'ACCEPTED' ? '邀请已被接受，无法撤回' : '邀请已撤回',
      );
    }
    const revoked = await tx.workspaceInvitation.findUniqueOrThrow({
      where: { id: current.id },
    });
    await recordEvent(
      tx,
      current.workspaceId,
      actorId,
      'workspaceInvitation',
      revoked.id,
      'revoked',
      { email: revoked.email, role: revoked.role },
    );
    return revoked;
  });

  return toView(invitation);
}

export type AcceptInvitationResult = {
  invitation: InvitationView;
  workspaceId: string;
  role: Role;
};

/**
 * 接受邀请的核心事务：
 * 1. FOR UPDATE 锁定工作区行，同一工作区的并发接受互相排队；
 * 2. 邀请必须仍为 PENDING，拒绝已接受/已撤回/已过期的令牌（单次使用）；
 * 3. 成员满额或受邀人已是成员时确定失败；
 * 4. 条件更新邀请行（status = PENDING）配合成员表唯一主键，
 *    跨工作区的并发接受也只能有一方成功。
 */
export async function acceptInvitation(
  db: PrismaClientType,
  rawToken: string,
  userId: string,
): Promise<AcceptInvitationResult> {
  const tokenHash = hashInvitationToken(rawToken);

  return db.$transaction(
    async (tx) => {
      const invitation = await tx.workspaceInvitation.findUnique({
        where: { tokenHash },
      });
      if (!invitation) {
        throw new HttpError(404, 'INVITATION_NOT_FOUND', '邀请不存在或已失效');
      }

      await lockWorkspace(tx, invitation.workspaceId);

      if (invitation.status === 'ACCEPTED') {
        throw new HttpError(409, 'INVITATION_ALREADY_USED', '邀请已被使用，令牌仅可使用一次');
      }
      if (invitation.status === 'REVOKED') {
        throw new HttpError(409, 'INVITATION_REVOKED', '邀请已被撤回');
      }
      if (invitation.expiresAt.getTime() <= Date.now()) {
        throw new HttpError(410, 'INVITATION_EXPIRED', '邀请已过期');
      }

      const invitee = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });
      if (!invitee || invitee.email !== invitation.email) {
        throw new HttpError(403, 'INVITATION_EMAIL_MISMATCH', '邀请仅限指定邮箱的账号接受');
      }

      const existingMembership = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId: invitation.workspaceId, userId },
        },
        select: { userId: true },
      });
      if (existingMembership) {
        throw new HttpError(409, 'INVITATION_ALREADY_MEMBER', '你已经是该工作区成员');
      }

      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: invitation.workspaceId },
        select: { memberLimit: true },
      });
      const memberCount = await tx.workspaceMember.count({
        where: { workspaceId: invitation.workspaceId },
      });
      if (memberCount >= workspace.memberLimit) {
        throw new HttpError(409, 'WORKSPACE_MEMBER_LIMIT_REACHED', '工作区成员已满');
      }

      // 条件更新：只有 PENDING 行可以被接受，作为并发场景下的最后一道闸门。
      const claimed = await tx.workspaceInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING' },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          acceptedById: userId,
        },
      });
      if (claimed.count === 0) {
        throw new HttpError(409, 'INVITATION_ALREADY_USED', '邀请已被使用，令牌仅可使用一次');
      }

      // 成员表复合主键 (workspaceId, userId) 兜底：
      // 两张不同邀请在最后阶段并发加入同一工作区时，至多一个事务成功。
      try {
        await tx.workspaceMember.create({
          data: {
            workspaceId: invitation.workspaceId,
            userId,
            role: invitation.role,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new HttpError(409, 'INVITATION_ALREADY_MEMBER', '你已经是该工作区成员');
        }
        throw error;
      }

      const updated = await tx.workspaceInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });
      await recordEvent(
        tx,
        invitation.workspaceId,
        userId,
        'workspaceInvitation',
        invitation.id,
        'accepted',
        { email: invitation.email, role: invitation.role },
      );

      return {
        invitation: toView(updated),
        workspaceId: invitation.workspaceId,
        role: invitation.role,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
