import { PrismaClient } from '@prisma/client'
import { DATABASE_URL } from './env'

// ALWAYS set process.env.DATABASE_URL from env.ts BEFORE PrismaClient initializes.
// z.ai injects DATABASE_URL=file:/home/z/my-project/db/custom.db (the EPHEMERAL
// path that gets wiped on every restart) into the shell env, so we MUST
// override it here to point at the persistent /tmp/my-project/db/custom.db.
// On local dev, env.ts falls back to process.env.DATABASE_URL or cwd/db.
process.env.DATABASE_URL = DATABASE_URL

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: ['query'],
  })

  // Hook ALL queries and trigger a debounced HF push after any mutation.
  // Mutations are: create, createMany, update, updateMany, delete, deleteMany,
  // upsert, executeRaw, executeRawUnsafe.
  // We listen to the 'after' phase so the write has actually hit SQLite first.
  const MUTATION_METHODS = new Set([
    'create', 'createMany', 'createManyAndReturn',
    'update', 'updateMany', 'updateManyAndReturn',
    'delete', 'deleteMany',
    'upsert',
    'executeRaw', 'executeRawUnsafe',
  ]);

  client.$on('query' as any, (e: any) => {
    // e.query for mutations starts with the method name (e.g. "create", "update")
    // For raw queries it's "executeRaw" / "executeRawUnsafe"
    const q = (e?.query || '').trim().toLowerCase();
    if (!q) return;
    // Detect mutation by looking at the first word
    const firstWord = q.split(/\s+/)[0].replace(/[^a-z]/g, '');
    // Common SQL mutations + Prisma method-name detection
    const isMutation =
      MUTATION_METHODS.has(firstWord) ||
      /^(insert|update|delete|create|upsert)/.test(q);
    if (!isMutation) return;

    // Fire-and-forget the schedulePush import (avoids circular import at module load)
    import('./hf-persist')
      .then(({ schedulePush }) => schedulePush())
      .catch(() => { /* ignore — best-effort persistence */ });
  });

  return client;
}

export const db = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
