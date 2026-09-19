import { describe, it, expect, beforeEach } from 'vitest';
import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';
import { app } from '../server.js';

const prisma = new PrismaClient();

async function registerUser(email: string) {
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash: await argon2.hash('password123'),
      displayName: email.split('@')[0],
    },
    select: { id: true, email: true },
  });
  const token = app.jwt.sign({ id: user.id, email: user.email });
  return { user, token };
}

async function createWorkspace(ownerId: string, memberLimit = 50) {
  return prisma.workspace.create({
    data: {
      name: 'HTTP 工作区',
      ownerId,
      memberLimit,
      members: { create: { userId: ownerId, role: Role.OWNER } },
    },
    select: { id: true },
  });
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  await prisma.collaborationEvent.deleteMany();
  await prisma.workspaceMember.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
});

describe('邀请相关 HTTP 接口', () => {
  it('完整邀请生命周期：创建、预览、接受、单次使用、撤回', async () => {
    const owner = await registerUser(`owner-${Date.now()}@example.com`);
    const guest = await registerUser(`guest-${Date.now()}@example.com`);
    const workspace = await createWorkspace(owner.user.id);

    // 1. 创建邀请
    const created = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/invitations`,
      headers: authHeaders(owner.token),
      payload: { email: guest.user.email.toUpperCase(), role: 'VIEWER', ttlSeconds: 86400 },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    expect(createdBody.data.invitation.email).toBe(guest.user.email);
    expect(createdBody.data.invitation.role).toBe('VIEWER');
    const inviteToken: string = createdBody.data.token;
    expect(inviteToken.startsWith('wvinv_')).toBe(true);
    expect(createdBody.data.invitation.tokenHash).toBeUndefined();

    // 2. 未登录也可以凭令牌预览
    const preview = await app.inject({
      method: 'GET',
      url: `/v1/invitations/${inviteToken}`,
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json();
    expect(previewBody.data.workspace.id).toBe(workspace.id);
    expect(previewBody.data.invitation.status).toBe('PENDING');
    expect(previewBody.data.isExpired).toBe(false);

    // 3. 受邀人接受
    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${inviteToken}/accept`,
      headers: authHeaders(guest.token),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.invitation.status).toBe('ACCEPTED');

    // 4. 同一令牌再次使用失败
    const reused = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${inviteToken}/accept`,
      headers: authHeaders(guest.token),
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('INVITATION_ALREADY_USED');

    // 5. 已接受的邀请不能撤回
    const invitationId: string = createdBody.data.invitation.id;
    const revokeAfterAccept = await app.inject({
      method: 'DELETE',
      url: `/v1/invitations/${invitationId}`,
      headers: authHeaders(owner.token),
    });
    expect(revokeAfterAccept.statusCode).toBe(409);
    expect(revokeAfterAccept.json().error.code).toBe('INVITATION_ALREADY_USED');
  });

  it('未接受前撤回，令牌立即失效', async () => {
    const owner = await registerUser(`owner2-${Date.now()}@example.com`);
    const guest = await registerUser(`guest2-${Date.now()}@example.com`);
    const workspace = await createWorkspace(owner.user.id);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/invitations`,
      headers: authHeaders(owner.token),
      payload: { email: guest.user.email, role: 'EDITOR' },
    });
    const { token, invitation } = created.json().data as {
      token: string;
      invitation: { id: string };
    };

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/invitations/${invitation.id}`,
      headers: authHeaders(owner.token),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().data.status).toBe('REVOKED');

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${token}/accept`,
      headers: authHeaders(guest.token),
    });
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.code).toBe('INVITATION_REVOKED');
  });

  it('重复邀请返回 409', async () => {
    const owner = await registerUser(`owner3-${Date.now()}@example.com`);
    const workspace = await createWorkspace(owner.user.id);

    const payload = { email: 'dup@example.com', role: 'VIEWER' };
    const first = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/invitations`,
      headers: authHeaders(owner.token),
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/invitations`,
      headers: authHeaders(owner.token),
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('INVITATION_DUPLICATE');
  });

  it('非法角色与未登录请求被拒绝', async () => {
    const owner = await registerUser(`owner4-${Date.now()}@example.com`);
    const workspace = await createWorkspace(owner.user.id);

    const badRole = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/invitations`,
      headers: authHeaders(owner.token),
      payload: { email: 'x@example.com', role: 'OWNER' },
    });
    expect(badRole.statusCode).toBe(400);

    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/invitations`,
      payload: { email: 'x@example.com', role: 'VIEWER' },
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('成员满额时接受返回 409', async () => {
    const owner = await registerUser(`owner5-${Date.now()}@example.com`);
    const guestA = await registerUser(`guest5a-${Date.now()}@example.com`);
    const guestB = await registerUser(`guest5b-${Date.now()}@example.com`);
    // 容量 2：owner 占 1 席，只剩 1 席。
    const workspace = await createWorkspace(owner.user.id, 2);

    const invite = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/invitations`,
        headers: authHeaders(owner.token),
        payload: { email, role: 'VIEWER' },
      });
      return res.json().data.token as string;
    };
    const tokenA = await invite(guestA.user.email);
    const tokenB = await invite(guestB.user.email);

    const acceptA = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${tokenA}/accept`,
      headers: authHeaders(guestA.token),
    });
    expect(acceptA.statusCode).toBe(200);

    const acceptB = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${tokenB}/accept`,
      headers: authHeaders(guestB.token),
    });
    expect(acceptB.statusCode).toBe(409);
    expect(acceptB.json().error.code).toBe('WORKSPACE_MEMBER_LIMIT_REACHED');
  });
});
