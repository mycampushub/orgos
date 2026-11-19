/**
 * Proves the Cloudflare Workers/D1 database path locally — no deploy needed.
 *
 * What it does:
 *   1. Boots wrangler's own runtime (getPlatformProxy — the same binding layer
 *      `cf:dev` uses) and grabs the REAL local D1 binding for `orgos`.
 *   2. Applies the GENERATED migration SQL (cloudflare/migrations/0001_init.sql) —
 *      exactly what `cf:d1:migrate:remote` sends to real D1.
 *   3. Wraps the binding with the PrismaD1 driver adapter and runs real queries
 *      through PrismaClient — the same code path as src/lib/db.ts on Workers.
 *
 * Run: bun run db:verify:d1
 * Exits 0 when every check passes; throws otherwise.
 */
import { getPlatformProxy } from 'wrangler'
import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'

const proxy = await getPlatformProxy({
  persist: false, // ephemeral in-memory state — every run starts from a clean D1
})
const d1 = proxy.env.DATABASE as D1Database
if (!d1) throw new Error('No DATABASE D1 binding — check wrangler.toml [[d1_databases]]')
console.log('[1] Real D1 binding acquired from wrangler (getPlatformProxy)')

// The exact adapter wiring src/lib/db.ts uses on the Workers runtime.
const prisma = new PrismaClient({ adapter: new PrismaD1(d1) } as ConstructorParameters<typeof PrismaClient>[0])

// Fresh isolated state → apply the generated schema via Prisma itself ($executeRawUnsafe
// splits statements; D1/SQLite is happy with DDL through the adapter).
const SCHEMA_SQL = (await import('node:fs')).readFileSync('cloudflare/migrations/0001_init.sql', 'utf8')
let applied = 0
for (const chunk of SCHEMA_SQL.split(/;\s*\n/)) {
  // strip comment lines, then skip empties — a leading comment must not cause the
  // statement after it to be skipped
  const stmt = chunk.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()
  if (stmt.length === 0) continue
  await prisma.$executeRawUnsafe(stmt)
  applied++
}
console.log(`[2] Applied migration SQL: ${applied} statements → local D1`)

const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
)
console.log(`[3] Tables in D1: ${tables.length}`)

await prisma.user.create({
  data: { email: 'verify@d1.local', passwordHash: 'x', name: 'D1 Verify', platformAdmin: true },
})
const user = await prisma.user.findUnique({ where: { email: 'verify@d1.local' } })
console.log(`[4] Adapter write + read: user.id=${user?.id.slice(0, 8)}… platformAdmin=${user?.platformAdmin}`)

const org = await prisma.organization.create({
  data: { name: 'Verify Org', slug: 'verify-org', plan: 'GROWTH', ownerId: user!.id },
})
await prisma.membership.create({ data: { orgId: org.id, userId: user!.id, role: 'OWNER' } })
const membership = await prisma.membership.findFirst({
  where: { orgId: org.id },
  include: { user: true },
})
console.log(`[5] Relation query (include): ${membership?.user?.email} is ${membership?.role} of org ${org.slug}`)

// Soft-delete column (the one the old hand-maintained SQL was missing).
const active = await prisma.membership.count({ where: { deletedAt: null } })
console.log(`[6] deletedAt column works: ${active} active membership(s)`)

await proxy.dispose()
console.log('\n✓ Workers/D1 path verified: schema SQL → D1 → PrismaD1 adapter → Prisma API.')
process.exit(0)
