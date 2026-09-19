import crypto from 'node:crypto';
import {
  InvitationStatus,
  Prisma,
  Role,
  type PrismaClient as PrismaClientType,
} from '@prisma/client';
import {
  invitationAcceptSchema,
  invitationCreateSchema,
  type InvitationCreateInput,
} from '@history/contracts';
import { HttpError, validationError } from '../errors.js';

type Db = PrismaClientType | Prisma.TransactionClient;

const TOKEN_BYTES = 32;
const MAX_RETRIES = 3;

export function hashInvitationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  const meta = error.meta as { code?: string } | undefined;
  return meta?.code === '40001' || meta?.code === '40P01';
}

/**
 * 串行化事务的重试封装：配合 FOR UPDATE 行锁，保证并发接受/撤回/满额判断
 * 不会产生不确定的结果。
 */
async function serializable<T>(
  prisma: PrismaClientType,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error)) throw error;
    }
  }
  throw lastError;
}

async function recordEvent(
  db: Db,
  workspaceId: string,
  actorId: string,
  operation: string,
  invitationId: string,
  payload: unknown,
) {
  await db.collaborationEvent.create({
    data: {
      workspaceId,
      actorId,
      resourceType: 'workspaceInvitation',
      resourceId: invitationId,
      operation,
      payloadJson: payload as Prisma.InputJsonValue,
    },
  });
}

export function invitationDto(invitation: {
  id: string;
  workspaceId: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedById: string | null;
  revokedAt: Date | null;
  revokedById: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  // 令牌哈希、activeKey 等内部字段永远不会返回给客户端
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
    acceptedAt: invitation.acceptedAt ? invitation.acceptedAt.toISOString() : null,
    acceptedById: invitation.acceptedById,
    revokedAt: invitation.revokedAt ? invitation.revokedAt.toISOString() : null,
    revokedById: invitation.revokedById,
    createdById: invitation.createdById,
    createdAt: invitation.createdAt.toISOString(),
    updatedAt: invitation.updatedAt.toISOString(),
  };
}

export async function createInvitation(
  prisma: PrismaClientType,
  input: {
    workspaceId: string;
    actorId: string;
    body: unknown;
  },
): Promise<{ invitation: ReturnType<typeof invitationDto>; token: string }> {
  const body: InvitationCreateInput = validationError(
    invitationCreateSchema,
    input.body,
  );

  const workspace = await prisma.workspace.findFirst({
    where: { id: input.workspaceId, deletedAt: null },
  });
  if (!workspace) {
    throw new HttpError(404, 'NOT_FOUND', '工作区不存在');
  }

  const memberCount = await prisma.workspaceMember.count({
    where: { workspaceId: workspace.id },
  });
  if (memberCount >= workspace.memberLimit) {
    throw new HttpError(409, 'WORKSPACE_FULL', '工作区成员已满，无法邀请新成员');
  }

  const existingMember = await prisma.workspaceMember.findFirst({
    where: { workspaceId: workspace.id, user: { email: body.email } },
    select: { userId: true },
  });
  if (existingMember) {
    throw new HttpError(409, 'ALREADY_MEMBER', '该用户已经是工作区成员');
  }

  const existingPending = await prisma.workspaceInvitation.findUnique({
    where: { activeKey: `${workspace.id}:${body.email}` },
  });
  if (existingPending) {
    if (existingPending.expiresAt <= new Date()) {
      // 过期但仍占用 activeKey 的邀请，先转存为 EXPIRED 再允许重新邀请
      await prisma.workspaceInvitation.update({
        where: { id: existingPending.id },
        data: { status: InvitationStatus.EXPIRED, activeKey: null },
      });
    } else {
      throw new HttpError(
        409,
        'INVITATION_DUPLICATE',
        '该邮箱已有一个待接受的邀请',
      );
    }
  }

  const token = generateToken();
  const now = Date.now();
  const expiresAt = new Date(now + body.ttlMinutes * 60_000);

  try {
    const invitation = await prisma.workspaceInvitation.create({
      data: {
        workspaceId: workspace.id,
        email: body.email,
        role: body.role,
        tokenHash: hashInvitationToken(token),
        expiresAt,
        activeKey: `${workspace.id}:${body.email}`,
        createdById: input.actorId,
      },
    });
    await recordEvent(
      prisma,
      workspace.id,
      input.actorId,
      'created',
      invitation.id,
      { email: invitation.email, role: invitation.role, expiresAt },
    );
    return { invitation: invitationDto(invitation), token };
  } catch (error) {
    // 并发创建同一邮箱的待接受邀请时，activeKey 唯一约束兜底
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new HttpError(
        409,
        'INVITATION_DUPLICATE',
        '该邮箱已有一个待接受的邀请',
      );
    }
    throw error;
  }
}

export async function listInvitations(
  prisma: PrismaClientType,
  workspaceId: string,
) {
  const rows = await prisma.workspaceInvitation.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
  // 读取时顺手把数据库时钟判定已过期的 PENDING 标记为 EXPIRED
  const now = new Date();
  const staleIds = rows
    .filter((row) => row.status === InvitationStatus.PENDING && row.expiresAt <= now)
    .map((row) => row.id);
  if (staleIds.length > 0) {
    await prisma.workspaceInvitation.updateMany({
      where: { id: { in: staleIds } },
      data: { status: InvitationStatus.EXPIRED, activeKey: null },
    });
    for (const id of staleIds) {
      const row = rows.find((item) => item.id === id);
      if (row) row.status = InvitationStatus.EXPIRED;
    }
  }
  return rows.map(invitationDto);
}

export async function revokeInvitation(
  prisma: PrismaClientType,
  input: { workspaceId: string; invitationId: string; actorId: string },
) {
  return serializable(prisma, async (tx) => {
    // 锁定邀请行，与正在进行的接受操作互斥
    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "WorkspaceInvitation" WHERE "id" = ${input.invitationId} FOR UPDATE`,
    );
    if (locked.length === 0) {
      throw new HttpError(404, 'INVITATION_NOT_FOUND', '邀请不存在');
    }

    const invitation = await tx.workspaceInvitation.findUniqueOrThrow({
      where: { id: input.invitationId },
    });
    if (invitation.workspaceId !== input.workspaceId) {
      throw new HttpError(404, 'INVITATION_NOT_FOUND', '邀请不存在');
    }

    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new HttpError(409, 'INVITATION_USED', '邀请已被接受，无法撤回');
    }
    if (invitation.status === InvitationStatus.REVOKED) {
      throw new HttpError(404, 'INVITATION_NOT_FOUND', '邀请不存在或已撤回');
    }

    const revoked = await tx.workspaceInvitation.update({
      where: { id: invitation.id },
      data: {
        status: InvitationStatus.REVOKED,
        activeKey: null,
        revokedAt: new Date(),
        revokedById: input.actorId,
      },
    });
    await recordEvent(
      tx,
      input.workspaceId,
      input.actorId,
      'revoked',
      revoked.id,
      { email: revoked.email },
    );
    return invitationDto(revoked);
  });
}

/**
 * 接受邀请。关键的不变量全部放在单个串行化事务内完成：
 * 1. FOR UPDATE 锁定邀请行与工作区行；
 * 2. 条件 updateMany 原子认领 PENDING 令牌（单次使用）；
 * 3. 成员数与唯一主键共同保证满额/重复加入必定失败。
 */
export async function acceptInvitation(
  prisma: PrismaClientType,
  input: { token: unknown; userId: string; userEmail: string },
): Promise<{ workspaceId: string; role: Role; membership: { joinedAt: Date } }> {
  const body = validationError(invitationAcceptSchema, {
    token: input.token,
  });

  return acceptByToken(prisma, {
    token: body.token,
    userId: input.userId,
    userEmail: input.userEmail,
  });
}

export async function acceptByToken(
  prisma: PrismaClientType,
  input: { token: string; userId: string; userEmail: string },
) {
  const tokenHash = hashInvitationToken(input.token);

  // 事务外先把“数据库时钟判定已过期”的待接受邀请翻转为 EXPIRED 并释放 activeKey。
  // 这是幂等的延迟过期；放在事务外可以保证即使随后接受失败，状态也会落库。
  await prisma.workspaceInvitation.updateMany({
    where: {
      tokenHash,
      status: InvitationStatus.PENDING,
      expiresAt: { lte: new Date() },
    },
    data: { status: InvitationStatus.EXPIRED, activeKey: null },
  });

  return serializable(prisma, async (tx) => {
    // 先按 tokenHash 锁住邀请行（同时锁住其工作区行的关联判定）
    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT wi."id"
        FROM "WorkspaceInvitation" wi
        WHERE wi."tokenHash" = ${tokenHash}
        FOR UPDATE OF wi`,
    );
    if (locked.length === 0) {
      throw new HttpError(404, 'INVITATION_NOT_FOUND', '邀请不存在或链接无效');
    }

    const invitation = await tx.workspaceInvitation.findUniqueOrThrow({
      where: { tokenHash },
      include: { workspace: true },
    });

    if (invitation.workspace.deletedAt) {
      throw new HttpError(404, 'NOT_FOUND', '工作区不存在');
    }

    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new HttpError(409, 'INVITATION_USED', '邀请已被使用，令牌仅限单次使用');
    }
    if (invitation.status === InvitationStatus.REVOKED) {
      throw new HttpError(410, 'INVITATION_REVOKED', '邀请已被撤回');
    }
    if (
      invitation.status === InvitationStatus.EXPIRED ||
      invitation.expiresAt <= new Date()
    ) {
      throw new HttpError(410, 'INVITATION_EXPIRED', '邀请已过期');
    }

    if (invitation.email !== input.userEmail.toLowerCase()) {
      throw new HttpError(
        403,
        'INVITATION_FOR_OTHER_USER',
        '当前账号与邀请邮箱不一致',
      );
    }

    // 锁定工作区行：并发接受不同邀请时，成员计数互斥，杜绝同时越过上限
    await tx.$executeRaw(
      Prisma.sql`SELECT "id" FROM "Workspace" WHERE "id" = ${invitation.workspaceId} FOR UPDATE`,
    );

    const memberCount = await tx.workspaceMember.count({
      where: { workspaceId: invitation.workspaceId },
    });
    if (memberCount >= invitation.workspace.memberLimit) {
      throw new HttpError(409, 'WORKSPACE_FULL', '工作区成员已满，无法加入');
    }

    // 原子认领令牌：只有仍是 PENDING 且未过期的邀请才能被更新一次。
    // 并发的第二个接受请求 count 必为 0，从而确定失败。
    const claimed = await tx.workspaceInvitation.updateMany({
      where: {
        id: invitation.id,
        status: InvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
        activeKey: { not: null },
      },
      data: {
        status: InvitationStatus.ACCEPTED,
        activeKey: null,
        acceptedAt: new Date(),
        acceptedById: input.userId,
      },
    });
    if (claimed.count === 0) {
      throw new HttpError(409, 'INVITATION_UNAVAILABLE', '邀请已失效');
    }

    // 令牌已认领。成员写入使用 ON CONFLICT DO NOTHING 兜底：
    // 如果用户在邀请发出后已通过其他路径成为成员，接受即为幂等完成
    // （令牌标记为 ACCEPTED、保留既有角色），绝不产生重复成员行。
    const inserted = await tx.workspaceMember.createMany({
      data: {
        workspaceId: invitation.workspaceId,
        userId: input.userId,
        role: invitation.role,
      },
      skipDuplicates: true,
    });
    const membership = await tx.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: invitation.workspaceId,
          userId: input.userId,
        },
      },
    });
    const role = inserted.count > 0 ? invitation.role : membership.role;

    await recordEvent(
      tx,
      invitation.workspaceId,
      input.userId,
      'accepted',
      invitation.id,
      { email: invitation.email, role: invitation.role },
    );

    return {
      workspaceId: invitation.workspaceId,
      role,
      membership: { joinedAt: membership.joinedAt },
    };
  });
}
