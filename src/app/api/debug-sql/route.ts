import { NextResponse, type NextRequest } from 'next/server'
import { sql } from '@/lib/sql'

// REFERENCE IMPLEMENTATION — raw-SQL data access (the "no Prisma" path).
// Companion to /api/debug-db: same diagnostic shape, but ZERO Prisma involvement.
//   Node  (`bun run dev`): bun:sqlite over db/custom.db
//   Workers (`cf:deploy`): env.DATABASE (D1) — native SQL
// Compare the two endpoints to see exactly what a full Prisma removal would mean:
// queries stay short, but results are untyped and soft-delete filters are manual.

const SOFT_DELETE_TABLES = ['Task', 'Invoice', 'Expense', 'Lead', 'Membership', 'Document', 'PayrollRun', 'Payslip'] as const

export async function GET(_req: NextRequest) {
  const out: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    runtime: sql.runtime(),
  }

  try {
    // Same query Prisma generates for db.user.count() — one line, hand-written.
    const row = await sql.first<{ n: number }>('SELECT COUNT(*) AS n FROM "User"')
    out.user_count = row?.n ?? 0
    out.query_ok = true

    // What "everything SQL" costs on a soft-delete model: the WHERE clause that
    // Prisma's db.ts extension adds automatically must now be written by hand.
    const activeTasks = await sql.first<{ n: number }>(
      'SELECT COUNT(*) AS n FROM "Task" WHERE "deletedAt" IS NULL',
    )
    out.active_tasks = activeTasks?.n ?? 0
    out.soft_delete_tables = SOFT_DELETE_TABLES.length
  } catch (err) {
    out.query_ok = false
    out.error_name = err instanceof Error ? err.name : String(err)
    out.error_message = err instanceof Error ? err.message : String(err)
  }

  return NextResponse.json(out)
}
