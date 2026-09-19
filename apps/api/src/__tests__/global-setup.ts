import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(currentDir, '../..');

const port = Number(process.env.TEST_PG_PORT || 55432);
const database = 'history_test';
const user = 'history';
const password = 'history';

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  `postgresql://${user}:${password}@localhost:${port}/${database}?schema=public`;

let pg: EmbeddedPostgres | null = null;
let dataDir: string | null = null;

export default async function setup() {
  // 允许外部通过 TEST_DATABASE_URL 指定已运行的 PostgreSQL。
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await deployMigrations(process.env.TEST_DATABASE_URL);
    return teardown;
  }

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'history-pg-'));
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: false,
    initdbFlags: [],
    postgresFlags: [],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);

  process.env.DATABASE_URL = testDatabaseUrl;
  await deployMigrations(testDatabaseUrl);
  return teardown;
}

async function deployMigrations(databaseUrl: string) {
  const prismaBin = path.join(apiRoot, 'node_modules', '.bin', 'prisma');
  await execFileAsync(
    prismaBin,
    ['migrate', 'deploy', '--schema', path.join(apiRoot, 'prisma', 'schema.prisma')],
    { env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
}

// vitest globalSetup 只支持单一 teardown，显式导出以供 afterAll 清理。
export async function teardown() {
  if (pg) {
    await pg.stop();
    pg = null;
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
}
