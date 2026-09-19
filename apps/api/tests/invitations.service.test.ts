import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { InvitationStatus, PrismaClient, Role } from '@prisma/client';
import {
  resetDatabase,
  startTestDatabase,
  stopTestDatabase,
} from './support/postgres.js';
import { createUser, createWorkspace, uniqueEmail } from './support/factories.js';
import { HttpError } from '../src/errors.js';
import {
  acceptByToken,
  createInvitation,
  hashInvitationToken,
  listInvitations,
  revokeInvitation,
} from '../src/invitations/service.js';

describe('workspace invitation service', () => {
  let prisma: PrismaClient;
  let owner: Awaited<ReturnType<typeof createUser>>;
  let invitee: Awaited<ReturnType<typeof createUser>>;
  let workspace: Awaited<ReturnType<typeof createWorkspace>>;

  beforeAll(async () => {
    prisma = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    owner = await createUser(prisma);
    invitee = await createUser(prisma);
    workspace = await createWorkspace(prisma, owner.id);
  });

  describe('createInvitation', () => {
    it('creates a pending invitation with role and expiry, returning the plaintext token once', async () => {
      const email = uniqueEmail('invited');
      const { invitation, token } = await createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        body: { email, role: 'EDITOR', ttlMinutes: 60 },
      });

      expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(invitation).toMatchObject({
        email,
        role: 'EDITOR',
        status: 'PENDING',
        workspaceId: workspace.id,
      });
      expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());

      // 明文令牌仅返回一次，数据库只存哈希
      const row = await prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });
      expect(row.tokenHash).toBe(hashInvitationToken(token));
      expect(Object.values(row)).not.toContain(token);
    });

    it('defaults the ttl to 7 days when omitted', async () => {
      const email = uniqueEmail('invited');
      const { invitation } = await createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        body: { email, role: 'VIEWER' },
      });
      const ttlMs = new Date(invitation.expiresAt).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(6 * 24 * 3600_000);
      expect(ttlMs).toBeLessThanOrEqual(7 * 24 * 3600_000);
    });

    it('rejects the OWNER role for invitations', async () => {
      const email = uniqueEmail('invited');
      await expect(
        createInvitation(prisma, {
          workspaceId: workspace.id,
          actorId: owner.id,
          body: { email, role: 'OWNER' },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('fails deterministically on a duplicate pending invitation', async () => {
      const email = uniqueEmail('dup');
      await createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        body: { email, role: 'VIEWER' },
      });

      await expect(
        createInvitation(prisma, {
          workspaceId: workspace.id,
          actorId: owner.id,
          body: { email, role: 'EDITOR' },
        }),
      ).rejects.toMatchObject({ code: 'INVITATION_DUPLICATE' });
    });

    it('fails when a pending invitation is created concurrently for the same email', async () => {
      const email = uniqueEmail('race-create');
      const attempts = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          createInvitation(prisma, {
            workspaceId: workspace.id,
            actorId: owner.id,
            body: { email, role: 'VIEWER' },
          }),
        ),
      );
      const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      const rejected = attempts.filter((a) => a.status === 'rejected');
      expect(rejected).toHaveLength(3);
      for (const result of rejected) {
        expect((result as PromiseRejectedResult).reason).toMatchObject({
          code: 'INVITATION_DUPLICATE',
        });
      }
      const count = await prisma.workspaceInvitation.count({
        where: { email, workspaceId: workspace.id },
      });
      expect(count).toBe(1);
    });

    it('cannot invite an existing member', async () => {
      await expect(
        createInvitation(prisma, {
          workspaceId: workspace.id,
          actorId: owner.id,
          body: { email: owner.email, role: 'EDITOR' },
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });
    });

    it('cannot invite when the member limit is reached', async () => {
      const fullWorkspace = await createWorkspace(prisma, owner.id, {
        memberLimit: 1,
      });
      await expect(
        createInvitation(prisma, {
          workspaceId: fullWorkspace.id,
          actorId: owner.id,
          body: { email: uniqueEmail('full'), role: 'VIEWER' },
        }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_FULL' });
    });

    it('allows re-inviting after the previous invitation expires', async () => {
      const email = uniqueEmail('expired');
      const first = await createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        body: { email, role: 'VIEWER', ttlMinutes: 1 },
      });
      await prisma.workspaceInvitation.update({
        where: { id: first.invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const second = await createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        body: { email, role: 'EDITOR' },
      });
      expect(second.invitation.status).toBe('PENDING');

      const rows = await listInvitations(prisma, workspace.id);
      const statuses = rows
        .filter((row) => row.email === email)
        .map((row) => row.status)
        .sort();
      expect(statuses).toEqual(['EXPIRED', 'PENDING']);
    });
  });

  describe('acceptByToken', () => {
    async function makeInvitation(email: string, ttlMinutes = 60, role: Role = Role.EDITOR) {
      const created = await createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        body: { email, role, ttlMinutes },
      });
      return created.token;
    }

    it('accepts a valid token once and joins with the invited role', async () => {
      const token = await makeInvitation(invitee.email, 60, Role.COMMENTER);
      const result = await acceptByToken(prisma, {
        token,
        userId: invitee.id,
        userEmail: invitee.email,
      });
      expect(result).toMatchObject({ workspaceId: workspace.id, role: Role.COMMENTER });

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId: workspace.id, userId: invitee.id },
        },
      });
      expect(membership?.role).toBe(Role.COMMENTER);

      const invitation = await prisma.workspaceInvitation.findUniqueOrThrow({
        where: { tokenHash: hashInvitationToken(token) },
      });
      expect(invitation.status).toBe(InvitationStatus.ACCEPTED);
      expect(invitation.acceptedById).toBe(invitee.id);
      expect(invitation.activeKey).toBeNull();
    });

    it('rejects an unknown token', async () => {
      await expect(
        acceptByToken(prisma, {
          token: 'x'.repeat(43),
          userId: invitee.id,
          userEmail: invitee.email,
        }),
      ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    });

    it('rejects accepting when the logged-in email does not match the invite', async () => {
      const other = await createUser(prisma);
      const token = await makeInvitation(invitee.email);
      await expect(
        acceptByToken(prisma, {
          token,
          userId: other.id,
          userEmail: other.email,
        }),
      ).rejects.toMatchObject({ code: 'INVITATION_FOR_OTHER_USER' });

      // 邀请仍然有效，正确的用户仍可接受
      const result = await acceptByToken(prisma, {
        token,
        userId: invitee.id,
        userEmail: invitee.email,
      });
      expect(result.workspaceId).toBe(workspace.id);
    });

    it('fails when the invitation has expired and marks it EXPIRED', async () => {
      const token = await makeInvitation(invitee.email, 1);
      await prisma.workspaceInvitation.update({
        where: { tokenHash: hashInvitationToken(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        acceptByToken(prisma, {
          token,
          userId: invitee.id,
          userEmail: invitee.email,
        }),
      ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });

      const row = await prisma.workspaceInvitation.findUniqueOrThrow({
        where: { tokenHash: hashInvitationToken(token) },
      });
      expect(row.status).toBe(InvitationStatus.EXPIRED);
      expect(row.activeKey).toBeNull();
    });

    it('fails after the invitation has been revoked', async () => {
      const token = await makeInvitation(invitee.email);
      const invitationId = (
        await prisma.workspaceInvitation.findUniqueOrThrow({
          where: { tokenHash: hashInvitationToken(token) },
        })
      ).id;
      await revokeInvitation(prisma, {
        workspaceId: workspace.id,
        invitationId,
        actorId: owner.id,
      });

      await expect(
        acceptByToken(prisma, {
          token,
          userId: invitee.id,
          userEmail: invitee.email,
        }),
      ).rejects.toMatchObject({ code: 'INVITATION_REVOKED' });
    });

    it('is single-use: concurrent accepts of the same token produce exactly one member', async () => {
      const token = await makeInvitation(invitee.email);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          acceptByToken(prisma, {
            token,
            userId: invitee.id,
            userEmail: invitee.email,
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(7);
      for (const result of rejected) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(HttpError);
      }

      const membershipCount = await prisma.workspaceMember.count({
        where: { workspaceId: workspace.id, userId: invitee.id },
      });
      expect(membershipCount).toBe(1);
      const invitationCount = await prisma.workspaceInvitation.count({
        where: { tokenHash: hashInvitationToken(token), status: InvitationStatus.ACCEPTED },
      });
      expect(invitationCount).toBe(1);
    });

    it('is single-use: a second sequential accept fails', async () => {
      const token = await makeInvitation(invitee.email);
      await acceptByToken(prisma, {
        token,
        userId: invitee.id,
        userEmail: invitee.email,
      });
      await expect(
        acceptByToken(prisma, {
          token,
          userId: invitee.id,
          userEmail: invitee.email,
        }),
      ).rejects.toMatchObject({ code: 'INVITATION_USED' });
    });

    it('treats accepting as idempotent when the invitee already became a member after issuing', async () => {
      // 邀请发出后，用户通过其他路径（管理员直接加成员等）已加入：
      // 接受幂等成功——令牌标记 ACCEPTED、保留既有角色，且不产生重复成员行
      const token = await makeInvitation(invitee.email, 60, Role.EDITOR);
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: invitee.id, role: Role.VIEWER },
      });

      const result = await acceptByToken(prisma, {
        token,
        userId: invitee.id,
        userEmail: invitee.email,
      });
      // 保留先加入时的角色，不被邀请覆盖
      expect(result.role).toBe(Role.VIEWER);

      expect(
        await prisma.workspaceMember.count({
          where: { workspaceId: workspace.id, userId: invitee.id },
        }),
      ).toBe(1);
      const row = await prisma.workspaceInvitation.findUniqueOrThrow({
        where: { tokenHash: hashInvitationToken(token) },
      });
      expect(row.status).toBe(InvitationStatus.ACCEPTED);
    });

    it('fails deterministically when accepting would exceed the member limit', async () => {
      // 邀请发出时仍有名额；随后成员占满（上限下调到当前人数），接受必须失败
      const limitedWorkspace = await createWorkspace(prisma, owner.id, {
        memberLimit: 5,
      });
      const created = await createInvitation(prisma, {
        workspaceId: limitedWorkspace.id,
        actorId: owner.id,
        body: { email: invitee.email, role: 'VIEWER' },
      });
      await prisma.workspace.update({
        where: { id: limitedWorkspace.id },
        data: { memberLimit: 1 },
      });

      await expect(
        acceptByToken(prisma, {
          token: created.token,
          userId: invitee.id,
          userEmail: invitee.email,
        }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_FULL' });

      expect(
        await prisma.workspaceMember.count({
          where: { workspaceId: limitedWorkspace.id },
        }),
      ).toBe(1);
      // 邀请保持 PENDING，扩容后仍可使用
      const row = await prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id: created.invitation.id },
      });
      expect(row.status).toBe(InvitationStatus.PENDING);
    });

    it('admits exactly one when multiple invites race against a limit of 2', async () => {
      // owner 已占 1 席，上限 2：两个被邀请人并发接受，恰好 1 人成功
      const limitedWorkspace = await createWorkspace(prisma, owner.id, {
        memberLimit: 2,
      });
      const inviteeA = await createUser(prisma);
      const inviteeB = await createUser(prisma);
      const inviteA = await createInvitation(prisma, {
        workspaceId: limitedWorkspace.id,
        actorId: owner.id,
        body: { email: inviteeA.email, role: 'VIEWER' },
      });
      const inviteB = await createInvitation(prisma, {
        workspaceId: limitedWorkspace.id,
        actorId: owner.id,
        body: { email: inviteeB.email, role: 'VIEWER' },
      });

      const results = await Promise.allSettled([
        acceptByToken(prisma, {
          token: inviteA.token,
          userId: inviteeA.id,
          userEmail: inviteeA.email,
        }),
        acceptByToken(prisma, {
          token: inviteB.token,
          userId: inviteeB.id,
          userEmail: inviteeB.email,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'WORKSPACE_FULL',
      });

      expect(
        await prisma.workspaceMember.count({
          where: { workspaceId: limitedWorkspace.id },
        }),
      ).toBe(2);

      // 多轮重复验证：每次重置后结论都一致
      for (let round = 0; round < 3; round += 1) {
        await resetDatabase(prisma);
        const o = await createUser(prisma);
        const a = await createUser(prisma);
        const b = await createUser(prisma);
        const w = await createWorkspace(prisma, o.id, { memberLimit: 2 });
        const ia = await createInvitation(prisma, {
          workspaceId: w.id,
          actorId: o.id,
          body: { email: a.email, role: 'VIEWER' },
        });
        const ib = await createInvitation(prisma, {
          workspaceId: w.id,
          actorId: o.id,
          body: { email: b.email, role: 'VIEWER' },
        });
        const roundResults = await Promise.allSettled([
          acceptByToken(prisma, { token: ia.token, userId: a.id, userEmail: a.email }),
          acceptByToken(prisma, { token: ib.token, userId: b.id, userEmail: b.email }),
        ]);
        expect(roundResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(roundResults.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(await prisma.workspaceMember.count({ where: { workspaceId: w.id } })).toBe(2);
      }
    });

    it('serialize() does not mask unrelated errors', async () => {
      // 不存在的工作区（被删）时给出明确 404
      const token = await makeInvitation(invitee.email);
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { deletedAt: new Date() },
      });
      await expect(
        acceptByToken(prisma, {
          token,
          userId: invitee.id,
          userEmail: invitee.email,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('revoke + accept race', () => {
    it('concurrent revoke and accept never both succeed, across many iterations', async () => {
      for (let round = 0; round < 10; round += 1) {
        await resetDatabase(prisma);
        const roundOwner = await createUser(prisma);
        const roundInvitee = await createUser(prisma);
        const roundWorkspace = await createWorkspace(prisma, roundOwner.id);
        const created = await createInvitation(prisma, {
          workspaceId: roundWorkspace.id,
          actorId: roundOwner.id,
          body: { email: roundInvitee.email, role: 'VIEWER' },
        });

        const acceptPromise = acceptByToken(prisma, {
          token: created.token,
          userId: roundInvitee.id,
          userEmail: roundInvitee.email,
        });
        const revokePromise = revokeInvitation(prisma, {
          workspaceId: roundWorkspace.id,
          invitationId: created.invitation.id,
          actorId: roundOwner.id,
        });

        const [acceptResult, revokeResult] = await Promise.allSettled([
          acceptPromise,
          revokePromise,
        ]);

        const accepted = acceptResult.status === 'fulfilled';
        const revoked = revokeResult.status === 'fulfilled';
        // 核心不变量：撤回与接受互斥，绝不允许同时成立
        expect(accepted && revoked).toBe(false);

        if (accepted) {
          expect(revokeResult.status).toBe('rejected');
          const membership = await prisma.workspaceMember.findUnique({
            where: {
              workspaceId_userId: {
                workspaceId: roundWorkspace.id,
                userId: roundInvitee.id,
              },
            },
          });
          expect(membership).not.toBeNull();
        } else if (revoked) {
          expect(acceptResult.status).toBe('rejected');
          const membership = await prisma.workspaceMember.findUnique({
            where: {
              workspaceId_userId: {
                workspaceId: roundWorkspace.id,
                userId: roundInvitee.id,
              },
            },
          });
          expect(membership).toBeNull();
        }
      }
    }, 120_000);

    it('cannot revoke an already accepted invitation', async () => {
      const created = await createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        body: { email: invitee.email, role: 'VIEWER' },
      });
      await acceptByToken(prisma, {
        token: created.token,
        userId: invitee.id,
        userEmail: invitee.email,
      });
      await expect(
        revokeInvitation(prisma, {
          workspaceId: workspace.id,
          invitationId: created.invitation.id,
          actorId: owner.id,
        }),
      ).rejects.toMatchObject({ code: 'INVITATION_USED' });
    });

    it('revoking a non-existent or foreign invitation yields not found', async () => {
      await expect(
        revokeInvitation(prisma, {
          workspaceId: workspace.id,
          invitationId: crypto.randomUUID(),
          actorId: owner.id,
        }),
      ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });

      const otherWorkspace = await createWorkspace(prisma, owner.id);
      const created = await createInvitation(prisma, {
        workspaceId: workspace.id,
        actorId: owner.id,
        body: { email: uniqueEmail('x'), role: 'VIEWER' },
      });
      await expect(
        revokeInvitation(prisma, {
          workspaceId: otherWorkspace.id,
          invitationId: created.invitation.id,
          actorId: owner.id,
        }),
      ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    });
  });
});
