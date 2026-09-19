import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { PrismaClient } from '@prisma/client';

export async function createTestApp(prisma: PrismaClient): Promise<FastifyInstance> {
  return buildApp({ prisma, redisUrl: null });
}

export async function login(
  app: FastifyInstance,
  email: string,
  password = 'password123',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { data: { token: string } }).data.token;
}

export async function registerUser(
  app: FastifyInstance,
  email: string,
  password = 'password123',
  displayName?: string,
): Promise<{ id: string; email: string; token: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password, displayName },
  });
  if (response.statusCode !== 201) {
    throw new Error(`register failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as {
    data: { token: string; user: { id: string; email: string } };
  };
  return { ...body.data.user, token: body.data.token };
}

export async function createWorkspaceViaApi(
  app: FastifyInstance,
  token: string,
  name = '工作区',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`workspace create failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { data: { id: string } }).data.id;
}
