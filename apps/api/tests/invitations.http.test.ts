import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  resetDatabase,
  startTestDatabase,
  stopTestDatabase,
} from './support/postgres.js';
import {
  createTestApp,
  createWorkspaceViaApi,
  registerUser,
} from './support/app.js';
import type { FastifyInstance } from 'fastify';
import { uniqueEmail } from './support/factories.js';
import { hashInvitationToken } from '../src/invitations/service.js';

describe('workspace invitation HTTP API', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerEmail: string;
  let workspaceId: string;

  beforeAll(async () => {
    prisma = await startTestDatabase();
    app = await createTestApp(prisma);
  });

  afterAll(async () => {
    await app.close();
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ownerEmail = uniqueEmail('owner');
    const owner = await registerUser(app, ownerEmail, 'password123', 'Owner');
    ownerToken = owner.token;
    workspaceId = await createWorkspaceViaApi(app, ownerToken, '家史工作区');
  });

  describe('POST /v1/workspaces/:id/invitations', () => {
    it('requires authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        payload: { email: uniqueEmail(), role: 'VIEWER' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('allows an OWNER to create an invitation and returns the token exactly once', async () => {
      const email = uniqueEmail('member');
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { email, role: 'EDITOR', ttlMinutes: 120 },
      });
      expect(response.statusCode).toBe(201);
      const { data } = response.json() as {
        data: {
          id: string;
          email: string;
          role: string;
          status: string;
          token: string;
          expiresAt: string;
        };
      };
      expect(data).toMatchObject({ email, role: 'EDITOR', status: 'PENDING' });
      expect(typeof data.token).toBe('string');
      expect(data.token.length).toBeGreaterThan(40);

      // 列表接口不再返回令牌
      const list = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(list.statusCode).toBe(200);
      const rows = (list.json() as { data: Array<Record<string, unknown>> }).data;
      expect(rows).toHaveLength(1);
      expect(rows[0].token).toBeUndefined();
      expect(rows[0].tokenHash).toBeUndefined();
      expect(rows[0].activeKey).toBeUndefined();
    });

    it('rejects OWNER as an invitation role', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { email: uniqueEmail(), role: 'OWNER' },
      });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'INVALID_INPUT',
      );
    });

    it('rejects ttl outside of the allowed range', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { email: uniqueEmail(), role: 'VIEWER', ttlMinutes: 0 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('forbids non-owner members from creating invitations', async () => {
      const memberEmail = uniqueEmail('editor');
      const member = await registerUser(app, memberEmail);
      // owner 直接通过数据库把该用户加成 EDITOR
      await prisma.workspaceMember.create({
        data: { workspaceId, userId: member.id, role: 'EDITOR' },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${member.token}` },
        payload: { email: uniqueEmail(), role: 'VIEWER' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('rejects a duplicate pending invitation with 409', async () => {
      const email = uniqueEmail('dup');
      const first = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { email, role: 'VIEWER' },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { email, role: 'EDITOR' },
      });
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: { code: string } }).error.code).toBe(
        'INVITATION_DUPLICATE',
      );
    });
  });

  describe('POST /v1/invitations/accept', () => {
    async function createInvitation(email: string, role = 'VIEWER'): Promise<string> {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { email, role },
      });
      expect(response.statusCode).toBe(201);
      return (response.json() as { data: { token: string } }).data.token;
    }

    it('accepts an invitation and joins the workspace exactly once', async () => {
      const email = uniqueEmail('joiner');
      const user = await registerUser(app, email);
      const token = await createInvitation(email, 'COMMENTER');

      const response = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: { workspaceId, role: 'COMMENTER' },
      });

      // 再次使用同一令牌：确定失败
      const second = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { token },
      });
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: { code: string } }).error.code).toBe(
        'INVITATION_USED',
      );

      // 成员列表（工作区列表接口）包含新成员
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
      });
      expect(member?.role).toBe('COMMENTER');
    });

    it('rejects a user whose email does not match the invitation', async () => {
      const invitedEmail = uniqueEmail('invited');
      await registerUser(app, invitedEmail);
      const stranger = await registerUser(app, uniqueEmail('stranger'));
      const token = await createInvitation(invitedEmail);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { authorization: `Bearer ${stranger.token}` },
        payload: { token },
      });
      expect(response.statusCode).toBe(403);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'INVITATION_FOR_OTHER_USER',
      );
    });

    it('rejects an expired token with 410 and exposes EXPIRED status', async () => {
      const email = uniqueEmail('late');
      const user = await registerUser(app, email);
      const token = await createInvitation(email);
      await prisma.workspaceInvitation.update({
        where: { tokenHash: hashInvitationToken(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { token },
      });
      expect(response.statusCode).toBe(410);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'INVITATION_EXPIRED',
      );
    });

    it('rejects a revoked token with 410', async () => {
      const email = uniqueEmail('revoked');
      const user = await registerUser(app, email);
      const token = await createInvitation(email);

      // 通过列表拿到邀请 id 再撤回
      const list = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      const rows = (list.json() as { data: Array<{ id: string; email: string }> }).data;
      const invitationId = rows.find((row) => row.email === email)?.id;
      expect(invitationId).toBeTruthy();

      const revoke = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${workspaceId}/invitations/${invitationId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(revoke.statusCode).toBe(200);
      expect(
        (revoke.json() as { data: { status: string } }).data.status,
      ).toBe('REVOKED');

      const response = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { token },
      });
      expect(response.statusCode).toBe(410);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'INVITATION_REVOKED',
      );
    });

    it('requires authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        payload: { token: 'x'.repeat(43) },
      });
      expect(response.statusCode).toBe(401);
    });

    it('validates the token shape', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { token: 'short' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 404 for an unknown token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { token: 'x'.repeat(43) },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /v1/workspaces/:id/invitations/:invitationId', () => {
    it('allows the owner to revoke a pending invitation', async () => {
      const email = uniqueEmail('tbd');
      const create = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { email, role: 'VIEWER' },
      });
      const id = (create.json() as { data: { id: string } }).data.id;

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${workspaceId}/invitations/${id}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(response.statusCode).toBe(200);
      const data = (response.json() as { data: { status: string; revokedById: string | null } }).data;
      expect(data.status).toBe('REVOKED');

      // 撤回后同一邮箱可以再次邀请
      const reCreate = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { email, role: 'EDITOR' },
      });
      expect(reCreate.statusCode).toBe(201);
    });

    it('returns 404 for unknown invitations', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${workspaceId}/invitations/${'00000000-0000-4000-8000-000000000000'}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /v1/invitations/:token', () => {
    it('returns a preview without leaking the token hash', async () => {
      const email = uniqueEmail('preview');
      const create = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { email, role: 'VIEWER' },
      });
      const token = (create.json() as { data: { token: string } }).data.token;

      const response = await app.inject({
        method: 'GET',
        url: `/v1/invitations/${token}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: { workspaceName: string; email: string; role: string; status: string };
      };
      expect(body.data).toMatchObject({
        workspaceName: '家史工作区',
        email,
        role: 'VIEWER',
        status: 'PENDING',
      });
    });
  });
});
