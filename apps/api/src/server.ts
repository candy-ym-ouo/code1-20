import { PrismaClient } from '@prisma/client';
import { buildApp } from './app.js';

const prisma = new PrismaClient();
const port = Number(process.env.PORT || 4000);

const app = await buildApp({ prisma });

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

async function shutdown() {
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
