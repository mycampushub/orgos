// THE "EVERYTHING SQL" LAYER — reference implementation, zero dependencies.
//
//   Node  (`bun run dev`):  node:sqlite (built into Node 24, which is what actually
//                           runs `next dev`) over the SQLite file at DATABASE_URL
//   Workers (`cf:deploy`):  env.DATABASE D1 binding — native SQL, no engine, no adapter
//
// One tiny API, same shape as D1's own:
//   const rows = await sql.all('SELECT * FROM "User" WHERE status = ?', 'ACTIVE')
//   const row  = await sql.first('SELECT COUNT(*) AS n FROM "User"')     // → { n: 5 }
//   await sql.run('UPDATE "User" SET status = ? WHERE id = ?', 'SUSPENDED', id)
//
// What you GAIN vs Prisma: no generated client, no query engine (binary or WASM),
// no prisma generate step, ~25 MB lighter node_modules, smaller Worker bundle.
// What you LOSE: result types (rows are `Record<string, unknown>`), automatic
// soft-delete filtering, relation includes, and interactive $transaction — D1 has
// no read-decide-write atomicity in raw SQL (only static batch()).
//
// SOFT-DELETE NOTE: 8 models (Task, Invoice, Expense, Lead, Membership, Document,
// PayrollRun, Payslip) carry a "deletedAt" column. With Prisma that filter lived in
// ONE place (src/lib/db.ts). With raw SQL every read must add AND "deletedAt" IS NULL
// by hand — the schema-drift class of bug, reintroduced per query.

interface D1Statement {
  bind(...params: unknown[]): D1Statement
  all(): Promise<{ results?: Record<string, unknown>[] }>
  first(): Promise<Record<string, unknown> | null>
  run(): Promise<unknown>
}

interface D1Like {
  prepare(query: string): D1Statement
}

interface NodeSqliteDatabase {
  prepare(query: string): {
    all(...params: unknown[]): Record<string, unknown>[]
    get(...params: unknown[]): Record<string, unknown> | undefined
    run(...params: unknown[]): unknown
  }
}

const ON_CF = process.env.CF_WORKER === '1'

// OpenNext publishes the request env on this AsyncLocalStorage-backed global
// (same mechanism src/lib/db.ts uses — see that file for why it's lazy/global).
function cfD1(): D1Like | null {
  const env = (
    globalThis as Record<symbol, { env?: { DATABASE?: D1Like } } | undefined>
  )[Symbol.for('__cloudflare-context__')]?.env
  return env?.DATABASE ?? null
}

// The local dev server (`next dev`) runs under Node 24 — node:sqlite is the
// built-in engine (no dependency). Loaded lazily via a dynamic import so the
// module is never evaluated on the Workers runtime, where node:sqlite is absent.
let nodeDb: NodeSqliteDatabase | null = null
async function localSqlite(): Promise<NodeSqliteDatabase> {
  if (!nodeDb) {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => NodeSqliteDatabase
    }
    const url = (process.env.DATABASE_URL ?? 'file:./db/custom.db').replace(/^file:/, '')
    nodeDb = new mod.DatabaseSync(url)
  }
  return nodeDb
}

async function driver(): Promise<{ kind: 'd1' | 'sqlite'; d1: D1Like | null; db: NodeSqliteDatabase | null }> {
  if (ON_CF) {
    const d1 = cfD1()
    if (!d1) throw new Error('[sql] CF_WORKER=1 but no DATABASE D1 binding in the request context')
    return { kind: 'd1', d1, db: null }
  }
  return { kind: 'sqlite', d1: null, db: await localSqlite() }
}

export const sql = {
  runtime(): 'workers-d1' | 'node-sqlite' {
    return ON_CF ? 'workers-d1' : 'node-sqlite'
  },

  async all<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> {
    const { kind, d1, db } = await driver()
    if (kind === 'd1' && d1) {
      const res = await d1.prepare(query).bind(...params).all()
      return (res.results ?? []) as T[]
    }
    if (db) return db.prepare(query).all(...params) as T[]
    throw new Error('[sql] no driver')
  },

  async first<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T | null> {
    const { kind, d1, db } = await driver()
    if (kind === 'd1' && d1) {
      const row = await d1.prepare(query).bind(...params).first()
      return (row ?? null) as T | null
    }
    if (db) return (db.prepare(query).get(...params) ?? null) as T | null
    throw new Error('[sql] no driver')
  },

  async run(query: string, ...params: unknown[]): Promise<void> {
    const { kind, d1, db } = await driver()
    if (kind === 'd1' && d1) {
      await d1.prepare(query).bind(...params).run()
      return
    }
    if (db) {
      db.prepare(query).run(...params)
      return
    }
    throw new Error('[sql] no driver')
  },

  // D1's only transactional primitive: a static list of statements, executed
  // atomically but decided BEFORE execution — no reading mid-transaction.
  async batch(statements: [string, ...unknown[]][]): Promise<void> {
    const { kind, d1 } = await driver()
    if (kind !== 'd1' || !d1) throw new Error('[sql] batch() is only meaningful on D1; use sequential run() locally')
    const d1WithBatch = d1 as unknown as {
      batch(stmts: unknown[]): Promise<unknown>
      prepare(query: string): D1Statement
    }
    const stmts = statements.map(([q, ...p]) => d1WithBatch.prepare(q).bind(...p))
    await d1WithBatch.batch(stmts)
  },
}
