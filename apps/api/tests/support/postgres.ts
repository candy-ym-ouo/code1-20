import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import { PrismaClient } from '@prisma/client';

const execFileAsync = promisify(execFile);

export const TEST_DB_PORT = 54399;
export const TEST_DB_USER = 'history';
export const TEST_DB_PASSWORD = 'history';
export const TEST_DB_NAME = 'history';
export const TEST_DATABASE_URL =
  `postgresql://${TEST_DB_USER}:${TEST_DB_PASSWORD}@127.0.0.1:${TEST_DB_PORT}/${TEST_DB_NAME}?schema=public`;

let pg: EmbeddedPostgres | null = null;
let prisma: PrismaClient | null = null;

/** 启动一次性的嵌入式 PostgreSQL 并执行全部 Prisma 迁移。 */
export async function startTestDatabase(): Promise<PrismaClient> {
  if (prisma) return prisma;

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'epg-invitation-'));
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: TEST_DB_USER,
    password: TEST_DB_PASSWORD,
    port: TEST_DB_PORT,
    persistent: false,
    initdbFlags: [],
    postgresFlags: [],
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(TEST_DB_NAME);

  process.env.DATABASE_URL = TEST_DATABASE_URL;

  const prismaBin = path.resolve('node_modules/prisma/build/index.js');
  await execFileAsync(
    process.execPath,
    [prismaBin, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      cwd: process.cwd(),
    },
  );

  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  return prisma;
}

/** 清空全部业务表（保留迁移历史），让测试之间互不影响。 */
export async function resetDatabase(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe(`
    TRUNCATE TABLE
      "CollaborationEvent",
      "ChapterBlock",
      "Chapter",
      "Clip",
      "Person",
      "Recording",
      "WorkspaceInvitation",
      "WorkspaceMember",
      "Workspace",
      "User"
    RESTART IDENTITY CASCADE
  `);
}

export async function stopTestDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  if (pg) {
    await pg.stop();
    pg = null;
  }
}
