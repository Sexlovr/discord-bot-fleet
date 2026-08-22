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

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
