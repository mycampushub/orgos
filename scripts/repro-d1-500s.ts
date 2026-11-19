/**
 * Reproduces the production 500s locally: runs the EXACT query flows of the
 * failing routes (/api/hr/employees, /api/tasks?assignee=me, /api/dashboard)
 * against a REAL D1 binding (wrangler getPlatformProxy) through the REAL
 * src/lib/db.ts Workers path (CF_WORKER=1 + lazy proxy + soft-delete $extends),
 * seeded with the same demo data deployed to remote (cloudflare/seed/seed-demo.sql).
 *
 * Run: bun run db:repro:d1
 */
import { getPlatformProxy } from 'wrangler'
import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'
import { readFileSync } from 'node:fs'

/** Quote-aware statement splitter: semicolons inside single-quoted strings are
 *  data, not terminators; '' is an escaped quote inside a string; leading --
 *  comment lines are stripped per statement. */
function collectStatements(sqlText: string): string[] {
  const out: string[] = []
  let stmt = ''
  let inString = false
  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i]
    if (ch === "'") {
      if (inString && sqlText[i + 1] === "'") { stmt += "''"; i++; continue }
      inString = !inString
    }
    if (ch === ';' && !inString) {
      const clean = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()
      if (clean.length) out.push(clean)
      stmt = ''
      continue
    }
    stmt += ch
  }
  const tail = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()
  if (tail.length) out.push(tail)
  return out
}

async function main() {
  const proxy = await getPlatformProxy({ persist: false })
  const d1 = proxy.env.DATABASE as D1Database
  if (!d1) throw new Error('No DATABASE binding')
  console.log('[1] Real D1 binding acquired')

  // Workers-mode db.ts path: flag + request-context global BEFORE importing db
  process.env.CF_WORKER = '1'
  ;(globalThis as unknown as Record<symbol, unknown>)[Symbol.for('__cloudflare-context__')] = {
    env: { DATABASE: d1 },
  }

  // Schema + seed through a raw client (same technique as verify-d1)
  const raw = new PrismaClient({ adapter: new PrismaD1(d1) } as ConstructorParameters<typeof PrismaClient>[0])
  for (const file of ['cloudflare/migrations/0001_init.sql', 'cloudflare/seed/seed-demo.sql']) {
    const stmts = collectStatements(readFileSync(file, 'utf8'))
    for (const s of stmts) await raw.$executeRawUnsafe(s)
    console.log(`[2] Applied ${file} (${stmts.length} statements)`)
  }

  // NOW import the real db — lazy proxy builds PrismaClient over PrismaD1 + soft-delete $extends
  const { db } = await import('../src/lib/db')
  const { getTaskColumns, doneKeys, statusOrderMap } = await import('../src/lib/server/columns')
  const { fromCents, fromCents0 } = await import('../src/lib/server/money')
  const { visibleTaskWhere } = await import('../src/lib/server/projects-access')
  const round = (n: number) => Math.round(n * 100) / 100

  let failed = 0
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const out = await fn()
      const json = JSON.stringify(out) // serialization check — BigInt/throw here = 500 in prod
      console.log(`  OK   ${name}  (${json.length} bytes)`)
      return out
    } catch (err) {
      failed++
      console.log(`  FAIL ${name}`)
      console.log('       ' + (err instanceof Error ? `${err.name}: ${err.message}` : String(err)))
      if (err instanceof Error && err.stack) console.log('       ' + err.stack.split('\n').slice(1, 4).join('\n       '))
      return undefined
    }
  }

  // ---------- shared context (as withAuth would resolve) ----------
  const org = await db.organization.findFirst()
  const ownerMembership = await db.membership.findFirst({ where: { orgId: org!.id, role: 'OWNER' } })
  if (!org || !ownerMembership) throw new Error('Seed data missing org/owner')
  console.log(`[3] Context: org=${org.slug} tz=${org.timezone} owner=${ownerMembership.id}`)
  const orgId = org.id
  const now = new Date()

  // ---------- FLOW A: GET /api/hr/employees ----------
  console.log('[4] /api/hr/employees')
  await step('membership.findMany include user+department orderBy joinedAt', async () => {
    const memberships = await db.membership.findMany({
      where: { orgId },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true, phone: true } },
        department: { select: { id: true, name: true } },
      },
      orderBy: { joinedAt: 'asc' },
    })
    const managerIds = [...new Set(memberships.map((m) => m.managerId).filter((x): x is string => !!x))]
    const managers = managerIds.length
      ? await db.membership.findMany({
          where: { id: { in: managerIds }, orgId },
          select: { id: true, user: { select: { name: true } } },
        })
      : []
    return memberships.map((m) => ({ id: m.id, baseSalary: fromCents(m.baseSalary ?? 0), name: m.user.name, managers: managers.length }))
  })

  // ---------- FLOW B: GET /api/tasks?assignee=me&limit=50&offset=0 ----------
  console.log('[5] /api/tasks?assignee=me')
  const taskInclude = {
    project: { select: { id: true, name: true, color: true, status: true } },
    milestone: { select: { id: true, title: true } },
    subtasks: { select: { id: true, title: true, status: true, assigneeMembershipId: true } },
    dependencies: { select: { dependsOnTask: { select: { id: true, title: true, status: true } } } },
    dependents: { select: { task: { select: { id: true, title: true, status: true } } } },
    _count: { select: { dependencies: true, comments: true } },
  }
  await step('task.findMany include=taskInclude (assignee=me)', async () => {
    const columns = await getTaskColumns(orgId)
    const notDoneKeys = doneKeys(columns)
    const orderMap = statusOrderMap(columns)
    const where: Record<string, unknown> = { orgId } // OWNER → full visibility
    where.assigneeMembershipId = ownerMembership.id
    const tasks = await db.task.findMany({ where, include: taskInclude })
    const sorted = [...tasks].sort((a, b) => {
      const s = (orderMap[a.status] ?? 999) - (orderMap[b.status] ?? 999)
      if (s !== 0) return s
      if (a.dueDate === null && b.dueDate === null) return 0
      if (a.dueDate === null) return 1
      if (b.dueDate === null) return -1
      return a.dueDate.getTime() - b.dueDate.getTime()
    })
    const page = sorted.slice(0, 50)
    const ids = new Set<string>()
    for (const t of page) {
      if (t.assigneeMembershipId) ids.add(t.assigneeMembershipId)
      if (t.creatorMembershipId) ids.add(t.creatorMembershipId)
      for (const s of t.subtasks) if (s.assigneeMembershipId) ids.add(s.assigneeMembershipId)
    }
    const members = ids.size ? await db.membership.findMany({ where: { orgId, id: { in: [...ids] } } }) : []
    return { columns: columns.length, tasks: page.length, members: members.length, visibleWhereSample: visibleTaskWhere(orgId, ownerMembership.id, 'EMPLOYEE').OR.length }
  })

  // ---------- FLOW C: GET /api/dashboard ----------
  console.log('[6] /api/dashboard')
  await step('dashboard: KPI aggregates + counts', async () => {
    const taskColumns = await getTaskColumns(orgId)
    const notDone = { notIn: doneKeys(taskColumns) }
    return Promise.all([
      db.invoice.aggregate({ where: { orgId, status: { in: ['PAID', 'PARTIALLY_PAID'] } }, _sum: { total: true } }),
      db.expense.aggregate({ where: { orgId, status: { in: ['PAID', 'FINANCE_APPROVED'] } }, _sum: { amount: true } }),
      db.deal.aggregate({ where: { orgId, status: 'OPEN' }, _sum: { value: true }, _count: true }),
      db.project.count({ where: { orgId, status: 'ACTIVE' } }),
      db.task.count({ where: { orgId, status: notDone } }),
      db.membership.count({ where: { orgId, status: 'ACTIVE' } }),
      db.expense.count({ where: { orgId, status: { in: ['SUBMITTED', 'MANAGER_APPROVED'] } } }),
    ])
  })
  await step('dashboard: trend findManys', async () => {
    return Promise.all([
      db.invoice.findMany({ where: { orgId, status: { in: ['PAID', 'PARTIALLY_PAID'] } }, select: { issueDate: true, total: true } }),
      db.expense.findMany({ where: { orgId, status: { in: ['PAID', 'FINANCE_APPROVED'] } }, select: { date: true, amount: true } }),
    ])
  })
  await step('dashboard: pipeline + open deals', async () => {
    return Promise.all([
      db.pipelineStage.findMany({ where: { orgId }, orderBy: { order: 'asc' }, select: { id: true, name: true } }),
      db.deal.findMany({ where: { orgId, status: 'OPEN' }, select: { stageId: true, value: true } }),
    ])
  })
  await step('dashboard: task groupBy status', async () => {
    return db.task.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } })
  })
  await step('dashboard: attendance rows', async () => {
    return db.attendance.findMany({ where: { orgId }, select: { date: true, status: true } })
  })
  await step('dashboard: activity include actor.user', async () => {
    return db.activityLog.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { actor: { select: { user: { select: { name: true } } } } },
    })
  })
  await step('dashboard: myTasks + deadlines', async () => {
    const taskColumns = await getTaskColumns(orgId)
    const notDone = { notIn: doneKeys(taskColumns) }
    return Promise.all([
      db.task.findMany({
        where: { orgId, assigneeMembershipId: ownerMembership.id, status: notDone },
        select: { id: true, title: true, status: true, priority: true, dueDate: true, project: { select: { name: true } } },
        take: 60,
      }),
      db.task.findMany({ where: { orgId, status: notDone }, select: { title: true, dueDate: true, project: { select: { name: true } } }, take: 100 }),
      db.milestone.findMany({ where: { project: { orgId }, status: { not: 'COMPLETED' } }, select: { title: true, dueDate: true, project: { select: { name: true } } }, take: 100 }),
      db.invoice.findMany({
        where: { orgId, status: { in: ['SENT', 'VIEWED', 'PARTIALLY_PAID', 'OVERDUE'] } },
        select: { number: true, dueDate: true, client: { select: { name: true } } },
        take: 100,
      }),
    ])
  })
  await step('dashboard: top clients include invoices+_count', async () => {
    const rows = await db.client.findMany({
      where: { orgId },
      select: {
        name: true,
        invoices: { where: { status: { in: ['PAID', 'PARTIALLY_PAID'] } }, select: { total: true } },
        _count: { select: { projects: true } },
      },
    })
    return rows.map((c) => ({ name: c.name, revenue: round(fromCents0(c.invoices.reduce((s, i) => s + i.total, 0))), projectCount: c._count.projects }))
  })

  console.log(failed === 0 ? '\nALL STEPS PASSED' : `\n${failed} STEP(S) FAILED`)
  await proxy.dispose()
  process.exit(failed === 0 ? 0 : 1)
}

// applySql is sync in shape but uses await-less flow — keep the harness simple:
// (the stray await_handle marker above is removed by design; splitter appends to `statements`)
main().catch((e) => {
  console.error('Harness crashed:', e)
  process.exit(1)
})
