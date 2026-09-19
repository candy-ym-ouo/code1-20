import { PrismaClient, Role } from '@prisma/client';

let counter = 0;

export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}@example.com`;
}

export async function createUser(
  prisma: PrismaClient,
  overrides: { email?: string; displayName?: string } = {},
) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? uniqueEmail(),
      passwordHash: 'x',
      displayName: overrides.displayName ?? 'Test User',
    },
  });
}

export async function createWorkspace(
  prisma: PrismaClient,
  ownerId: string,
  overrides: { name?: string; memberLimit?: number } = {},
) {
  const workspace = await prisma.workspace.create({
    data: {
      name: overrides.name ?? '测试工作区',
      memberLimit: overrides.memberLimit ?? 50,
      ownerId,
    },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: ownerId, role: Role.OWNER },
  });
  return workspace;
}
