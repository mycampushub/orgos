/**
 * Determines the DateTime storage format the WASM engine (driver adapter path)
 * writes and accepts, by:
 *   1. Creating a user via Prisma (engine writes its own canonical form)
 *   2. Reading the RAW stored value via $queryRawUnsafe
 *   3. Re-testing reads after forcing epoch-ms (expect P2023) and ISO candidates
 */
import { getPlatformProxy } from 'wrangler'
import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'
import { readFileSync } from 'node:fs'

const proxy = await getPlatformProxy({ persist: false })
const d1 = proxy.env.DATABASE as D1Database
const prisma = new PrismaClient({ adapter: new PrismaD1(d1) } as ConstructorParameters<typeof PrismaClient>[0])

// minimal schema: just User table is enough (nested deps of 0001 might FK-block — apply all)
const sql = readFileSync('cloudflare/migrations/0001_init.sql', 'utf8')
const stmts: string[] = []
{
  let cur = '', inStr = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") { if (inStr && sql[i + 1] === "'") { cur += "''"; i++; continue } inStr = !inStr }
    if (ch === ';' && !inStr) { const c = cur.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim(); if (c) stmts.push(c); cur = ''; continue }
    cur += ch
  }
  const t = cur.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim(); if (t) stmts.push(t)
}
for (const s of stmts) await prisma.$executeRawUnsafe(s)
console.log('schema applied')

await prisma.user.create({ data: { email: 'fmt@test', passwordHash: 'x', name: 'F' } })
const raw1: unknown = await prisma.$queryRawUnsafe(`SELECT "createdAt" FROM "User" WHERE "email"='fmt@test'`)
console.log('CANONICAL (engine-written):', JSON.stringify(raw1))

// epoch-ms → read via Prisma (expect P2023)
await prisma.$executeRawUnsafe(`UPDATE "User" SET "createdAt" = 1790242191036 WHERE "email"='fmt@test'`)
try {
  await prisma.user.findUnique({ where: { email: 'fmt@test' } })
  console.log('epoch-ms read: OK (unexpected!)')
} catch (e) {
  console.log('epoch-ms read:', e instanceof Error ? e.message.split('\n')[0] : e)
}

// ISO candidates
for (const iso of ['2026-11-19T07:49:11.000Z', '2026-11-19 07:49:11.000', '2026-11-19 07:49:11']) {
  await prisma.$executeRawUnsafe(`UPDATE "User" SET "createdAt" = '${iso}' WHERE "email"='fmt@test'`)
  try {
    const u = await prisma.user.findUnique({ where: { email: 'fmt@test' } })
    console.log(`ISO '${iso}' read: OK → createdAt=${u?.createdAt?.toISOString?.()}`)
  } catch (e) {
    console.log(`ISO '${iso}' read:`, e instanceof Error ? e.message.split('\n')[0] : e)
  }
}
await proxy.dispose()
process.exit(0)
