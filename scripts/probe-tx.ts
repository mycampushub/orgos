/** Verifies whether $transaction interactive/array forms work through PrismaD1. */
import { getPlatformProxy } from 'wrangler'
import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'
import { readFileSync } from 'node:fs'

const proxy = await getPlatformProxy({ persist: false })
const d1 = proxy.env.DATABASE as D1Database
const prisma = new PrismaClient({ adapter: new PrismaD1(d1) } as ConstructorParameters<typeof PrismaClient>[0])
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
}
for (const s of stmts) await prisma.$executeRawUnsafe(s)
await prisma.user.create({ data: { email: 'tx@test', passwordHash: 'x', name: 'T' } })
const u = await prisma.user.findUniqueOrThrow({ where: { email: 'tx@test' } })
const org = await prisma.organization.create({ data: { name: 'T Org', slug: 't-org', plan: 'FREE', ownerId: u.id } })

try {
  await prisma.$transaction(async (tx) => {
    await tx.membership.create({ data: { orgId: org.id, userId: u.id, role: 'OWNER' } })
  })
  console.log('interactive $transaction: OK')
} catch (e) {
  console.log('interactive $transaction: FAIL →', e instanceof Error ? e.message.split('\n')[0] : e)
}
try {
  await prisma.$transaction([prisma.notification.create({ data: { orgId: org.id, userId: u.id, type: 'SYSTEM', title: 'x' } })])
  console.log('array $transaction: OK')
} catch (e) {
  console.log('array $transaction: FAIL →', e instanceof Error ? e.message.split('\n')[0] : e)
}
await proxy.dispose()
process.exit(0)
