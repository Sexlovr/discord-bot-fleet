import { PrismaClient } from '@prisma/client'
import { DATABASE_URL } from './env'

// Make sure process.env.DATABASE_URL is set BEFORE PrismaClient initializes.
// Prisma reads process.env.DATABASE_URL at construction time, so we set it
// here from our centralized env.ts (which prefers the persistent
// /tmp/my-project/db path on z.ai, falling back to local dev).
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
