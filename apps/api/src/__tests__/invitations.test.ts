import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';
import {
  acceptInvitation,
  createInvitation,
  revokeInvitation,
} from '../invitations.js';
import { HttpError } from '../errors.js';

const prisma = new PrismaClient();

async function createUser(email: string, displayName = email.split('@')[0]) {
  return prisma.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash: await argon2.hash('password123'),
      displayName: displayName,
    },
    select: { id: true, email: true },
  });
}

async function createWorkspace(ownerId: string, memberLimit = 50) {
  return prisma.workspace.create({
    data: {
      name: `工作区-${cryptoRandom()}`,
      ownerId,
      memberLimit,
      members: { create: { userId: ownerId, role: Role.OWNER } },
    },
    select: { id: true },
  });
}

function cryptoRandom() {
  return Math.random().toString(36).slice(2, 10);
}

async function expectHttpError<T>(
  promise: Promise<T>,
  statusCode: number,
  code: string,
) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const httpError = error as HttpError;
    expect(httpError.statusCode).toBe(statusCode);
    expect(httpError.code).toBe(code);
    return;
  }
  throw new Error(`Expected HttpError ${statusCode} ${code}, but call succeeded`);
}

/** 并发执行，不等待首个结果，避免 Promise.all 的快速失败掩盖其它结果。 */
async function settledResults<T>(tasks: Array<Promise<T>>) {
  return Promise.allSettled(tasks);
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  // 邀请表通过 workspace FK 级联，清空成员与工作区即可回收全部测试数据。
  await prisma.collaborationEvent.deleteMany();
  await prisma.workspaceMember.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
});

describe('createInvitation', () => {
  it('创建带有角色与有效期的待接受邀请并返回一次性明文令牌', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);

    const { invitation, token } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: 'Guest@Example.com',
      role: Role.EDITOR,
      ttlSeconds: 3600,
    });

    expect(token.startsWith('wvinv_')).toBe(true);
    expect(invitation.status).toBe('PENDING');
    expect(invitation.role).toBe(Role.EDITOR);
    expect(invitation.email).toBe('guest@example.com');
    const ttlMs = invitation.expiresAt.getTime() - invitation.createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(3595_000);
    expect(ttlMs).toBeLessThanOrEqual(3600_000);

    // 明文令牌绝不落库。
    const stored = await prisma.workspaceInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(stored.tokenHash).not.toContain(token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('非 OWNER 角色不能发起邀请', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const editor = await createUser(`editor-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: editor.id, role: Role.EDITOR },
    });

    await expectHttpError(
      createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: editor.id,
        email: 'someone@example.com',
        role: Role.VIEWER,
      }),
      403,
      'FORBIDDEN',
    );
  });

  it('不能邀请 OWNER 角色', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);

    await expectHttpError(
      createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        email: 'someone@example.com',
        role: Role.OWNER,
      }),
      400,
      'INVALID_INVITATION_ROLE',
    );
  });

  it('有效期越界被拒绝', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);

    await expectHttpError(
      createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        email: 'short@example.com',
        role: Role.VIEWER,
        ttlSeconds: 60,
      }),
      400,
      'INVALID_INVITATION_TTL',
    );
  });

  it('重复邀请同一邮箱确定失败', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);

    await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: 'twice@example.com',
      role: Role.COMMENTER,
    });

    await expectHttpError(
      createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        email: 'twice@example.com',
        role: Role.VIEWER,
      }),
      409,
      'INVITATION_DUPLICATE',
    );

    // 邮箱大小写归一，大小写不同也视为重复。
    await expectHttpError(
      createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        email: 'TWICE@example.com',
        role: Role.VIEWER,
      }),
      409,
      'INVITATION_DUPLICATE',
    );

    const pendingCount = await prisma.workspaceInvitation.count({
      where: { workspaceId: workspace.id, status: 'PENDING' },
    });
    expect(pendingCount).toBe(1);
  });

  it('并发创建重复邀请时恰好只有一个成功', async () => {
    const owner = await createUser(`owner-race-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);

    const tasks = Array.from({ length: 6 }, () =>
      createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        email: 'race@example.com',
        role: Role.VIEWER,
      }),
    );
    const results = await settledResults(tasks);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const result of rejected) {
      const reason = (result as PromiseRejectedResult).reason as HttpError;
      expect(reason).toBeInstanceOf(HttpError);
      expect(reason.statusCode).toBe(409);
      expect(reason.code).toBe('INVITATION_DUPLICATE');
    }

    const pendingCount = await prisma.workspaceInvitation.count({
      where: { workspaceId: workspace.id, email: 'race@example.com', status: 'PENDING' },
    });
    expect(pendingCount).toBe(1);
  });

  it('邀请已是成员的邮箱失败', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const member = await createUser(`member-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: member.id, role: Role.VIEWER },
    });

    await expectHttpError(
      createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        email: member.email,
        role: Role.VIEWER,
      }),
      409,
      'INVITATION_ALREADY_MEMBER',
    );
  });

  it('撤回后可以再次邀请同一邮箱', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    const first = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: 'redo@example.com',
      role: Role.VIEWER,
    });

    await revokeInvitation(prisma, first.invitation.id, owner.id);

    const second = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: 'redo@example.com',
      role: Role.EDITOR,
    });
    expect(second.invitation.status).toBe('PENDING');
    expect(second.token).not.toBe(first.token);

    const pendingCount = await prisma.workspaceInvitation.count({
      where: { workspaceId: workspace.id, status: 'PENDING' },
    });
    expect(pendingCount).toBe(1);
  });
});

describe('acceptInvitation', () => {
  it('受邀人接受后成为对应角色的成员，令牌状态变为 ACCEPTED', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const guest = await createUser(`guest-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    const { token, invitation } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: guest.email,
      role: Role.COMMENTER,
    });

    const result = await acceptInvitation(prisma, token, guest.id);
    expect(result.workspaceId).toBe(workspace.id);
    expect(result.role).toBe(Role.COMMENTER);
    expect(result.invitation.status).toBe('ACCEPTED');

    const membership = await prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: guest.id } },
    });
    expect(membership.role).toBe(Role.COMMENTER);

    const stored = await prisma.workspaceInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(stored.status).toBe('ACCEPTED');
    expect(stored.acceptedById).toBe(guest.id);
    expect(stored.acceptedAt).toBeInstanceOf(Date);
  });

  it('令牌只能使用一次，重复接受确定失败', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const guest = await createUser(`guest-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    const { token } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: guest.email,
      role: Role.VIEWER,
    });

    await acceptInvitation(prisma, token, guest.id);
    await expectHttpError(
      acceptInvitation(prisma, token, guest.id),
      409,
      'INVITATION_ALREADY_USED',
    );

    const memberCount = await prisma.workspaceMember.count({
      where: { workspaceId: workspace.id },
    });
    expect(memberCount).toBe(2);
  });

  it('同一令牌并发接受恰好一次成功', async () => {
    const owner = await createUser(`owner-race2-${cryptoRandom()}@example.com`);
    const guest = await createUser(`guest-race2-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    const { token } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: guest.email,
      role: Role.VIEWER,
    });

    const results = await settledResults(
      Array.from({ length: 8 }, () => acceptInvitation(prisma, token, guest.id)),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const result of rejected) {
      const reason = (result as PromiseRejectedResult).reason as HttpError;
      expect([409]).toContain(reason.statusCode);
      expect(['INVITATION_ALREADY_USED', 'INVITATION_ALREADY_MEMBER']).toContain(
        reason.code,
      );
    }

    const memberships = await prisma.workspaceMember.count({
      where: { workspaceId: workspace.id, userId: guest.id },
    });
    expect(memberships).toBe(1);
  });

  it('撤回后的令牌即使并发接受也全部失败', async () => {
    const owner = await createUser(`owner-race3-${cryptoRandom()}@example.com`);
    const guest = await createUser(`guest-race3-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    const { token } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: guest.email,
      role: Role.VIEWER,
    });

    await revokeInvitation(prisma, (await prisma.workspaceInvitation.findFirstOrThrow({
      where: { workspaceId: workspace.id },
    })).id, owner.id);

    const results = await settledResults(
      Array.from({ length: 4 }, () => acceptInvitation(prisma, token, guest.id)),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    for (const result of results) {
      const reason = (result as PromiseRejectedResult).reason as HttpError;
      expect(reason.statusCode).toBe(409);
      expect(reason.code).toBe('INVITATION_REVOKED');
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: guest.id } },
    });
    expect(membership).toBeNull();
  });

  it('撤回与接受并发交错时结果确定：成员不会通过已撤回邀请加入', async () => {
    const owner = await createUser(`owner-race4-${cryptoRandom()}@example.com`);
    const guest = await createUser(`guest-race4-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    const { token, invitation } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: guest.email,
      role: Role.VIEWER,
    });

    // 撤回与接受同时发起，无论哪个先拿到工作区行锁，最终状态必须自洽——
    // 成员加入当且仅当邀请最终为 ACCEPTED。
    const [acceptResult, revokeResult] = await Promise.allSettled([
      acceptInvitation(prisma, token, guest.id),
      revokeInvitation(prisma, invitation.id, owner.id),
    ]);

    const stored = await prisma.workspaceInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: guest.id },
      },
    });

    if (stored.status === 'ACCEPTED') {
      expect(membership).not.toBeNull();
      expect(acceptResult.status).toBe('fulfilled');
      expect(revokeResult.status).toBe('rejected');
    } else {
      expect(stored.status).toBe('REVOKED');
      expect(membership).toBeNull();
      expect(acceptResult.status).toBe('rejected');
      expect(revokeResult.status).toBe('fulfilled');
    }
  });

  it('成员满额时接受失败，且并发接受只有 memberLimit 个成功', async () => {
    const owner = await createUser(`owner-cap-${cryptoRandom()}@example.com`);
    // 容量 3：owner 占 1 个，剩余 2 席。
    const workspace = await createWorkspace(owner.id, 3);

    const guests = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createUser(`guest-cap-${cryptoRandom()}-${index}@example.com`),
      ),
    );
    const invites = await Promise.all(
      guests.map((guest) =>
        createInvitation(prisma, {
          workspaceId: workspace.id,
          actorId: owner.id,
          email: guest.email,
          role: Role.VIEWER,
        }),
      ),
    );

    const results = await settledResults(
      invites.map((invite, index) =>
        acceptInvitation(prisma, invite.token, guests[index].id),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      const reason = (result as PromiseRejectedResult).reason as HttpError;
      expect(reason.statusCode).toBe(409);
      expect(reason.code).toBe('WORKSPACE_MEMBER_LIMIT_REACHED');
    }

    const memberCount = await prisma.workspaceMember.count({
      where: { workspaceId: workspace.id },
    });
    expect(memberCount).toBe(3);
  });

  it('非受邀邮箱的账号不能接受', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const guest = await createUser(`guest-${cryptoRandom()}@example.com`);
    const other = await createUser(`other-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    const { token } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: guest.email,
      role: Role.VIEWER,
    });

    await expectHttpError(
      acceptInvitation(prisma, token, other.id),
      403,
      'INVITATION_EMAIL_MISMATCH',
    );
  });

  it('过期令牌被拒绝', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const guest = await createUser(`guest-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    const { token, invitation } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: guest.email,
      role: Role.VIEWER,
      ttlSeconds: 5 * 60,
    });
    await prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expectHttpError(
      acceptInvitation(prisma, token, guest.id),
      410,
      'INVITATION_EXPIRED',
    );

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: guest.id } },
    });
    expect(membership).toBeNull();
  });

  it('不存在的令牌返回 404', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    await expectHttpError(
      acceptInvitation(prisma, `${'a'.repeat(32)}_not_a_real_token`, owner.id),
      404,
      'INVITATION_NOT_FOUND',
    );
  });
});

describe('revokeInvitation', () => {
  it('只有 OWNER 可以撤回', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const editor = await createUser(`editor-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: editor.id, role: Role.EDITOR },
    });
    const { invitation } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: 'x@example.com',
      role: Role.VIEWER,
    });

    await expectHttpError(
      revokeInvitation(prisma, invitation.id, editor.id),
      403,
      'FORBIDDEN',
    );
  });

  it('不能重复撤回', async () => {
    const owner = await createUser(`owner-${cryptoRandom()}@example.com`);
    const workspace = await createWorkspace(owner.id);
    const { invitation } = await createInvitation(prisma, {
      workspaceId: workspace.id,
      actorId: owner.id,
      email: 'x@example.com',
      role: Role.VIEWER,
    });

    await revokeInvitation(prisma, invitation.id, owner.id);
    await expectHttpError(
      revokeInvitation(prisma, invitation.id, owner.id),
      409,
      'INVITATION_REVOKED',
    );
  });
});
