import { PrismaClient } from '@prisma/client'

// M25-db: Prisma client extension for automatic soft-delete filtering.
// Models with `deletedAt` are automatically filtered to exclude soft-deleted rows
// on all read queries (findMany, findFirst, findUnique, count, aggregate, groupBy).
// Routes that need to see deleted rows can explicitly pass `deletedAt` in the where clause.
const SOFT_DELETE_MODELS = ['task', 'invoice', 'expense', 'payrollRun', 'payslip', 'membership', 'document', 'lead'] as const

function addDeletedAtFilter(args: { where?: Record<string, unknown> }): { where: Record<string, unknown> } {
  const where = args.where ?? {}
  // Only add the filter if the caller hasn't explicitly specified deletedAt
  if (!('deletedAt' in where)) {
    where.deletedAt = null
  }
  return { ...args, where }
}

// ---------- runtime detection ----------
// CF_WORKER=1 is set in wrangler.toml [vars] — it's present on the deployed
// Worker and under `opennextjs-cloudflare dev`, absent on plain Node (local
// `bun run dev` against the SQLite file at db/custom.db).
const ON_CF = process.env.CF_WORKER === '1'

/**
 * The OpenNext worker entry (production) and initOpenNextCloudflareForDev
 * (`cf:dev`) publish the request context on this global before any route
 * handler runs — same symbol/pattern as src/lib/server/storage.ts.
 */
const CF_CONTEXT_SYMBOL = Symbol.for('__cloudflare-context__')

interface D1DatabaseLike {
  prepare(query: string): unknown
}

/**
 * Synchronously resolve the Cloudflare env (bindings + vars + secrets) from
 * the OpenNext context global. Returns null on plain Node or when the global
 * hasn't been published yet.
 *
 * We read the global directly (no `@opennextjs/cloudflare/api` import) so the
 * call is synchronous — that lets us build the PrismaClient at module load,
 * which preserves the synchronous `export const db = …` API that every route
 * file already relies on (`await db.lead.findMany(…)` etc.).
 */
function getCloudflareEnvSync(): Record<string, unknown> | null {
  const globalCtx = (globalThis as Record<symbol, unknown>)[CF_CONTEXT_SYMBOL] as
    | { env?: Record<string, unknown> }
    | undefined
  return globalCtx?.env ?? null
}

/**
 * Resolve the PrismaD1 adapter class. On the Workers runtime we can statically
 * import `@prisma/adapter-d1` (it's a pure-JS package, no native deps) — but
 * we use a runtime-string specifier + turbopack-ignore comments so that on
 * plain Node (where the package is installed but unused) the bundler doesn't
 * try to resolve it at build time and pull Workers-only code into the Node
 * bundle. The synchronous `await import()` here is fine because module
 * imports are cached after first resolution.
 */
async function loadPrismaD1Adapter(): Promise<{
  PrismaD1: new (d1: D1DatabaseLike) => unknown
}> {
  const mod = (await import(
    /* webpackIgnore: true */
    /* turbopackIgnore: true */
    '@prisma/adapter-d1'
  )) as { PrismaD1: new (d1: D1DatabaseLike) => unknown }
  return mod
}

/**
 * Build the base PrismaClient for the current runtime.
 *
 * - Node (local dev / `bun run dev`): plain `new PrismaClient()` against the
 *   SQLite file at db/custom.db (DATABASE_URL in .env).
 * - Cloudflare Workers (production / `cf:dev`): `new PrismaClient({ adapter })`
 *   with the PrismaD1 driver adapter bound to the DATABASE D1 binding.
 *
 * Both paths use the SAME generated client from `@prisma/client` — the SQLite
 * schema is 100% D1-compatible (string IDs, no list fields, JSON as String),
 * so one client works for both runtimes. Only the construction differs.
 */
async function createBaseClient(): Promise<PrismaClient> {
  if (ON_CF) {
    const env = getCloudflareEnvSync()
    const d1 = env?.DATABASE as D1DatabaseLike | undefined
    if (d1 && typeof d1.prepare === 'function') {
      const { PrismaD1 } = await loadPrismaD1Adapter()
      const adapter = new PrismaD1(d1)
      // `adapter` is the driver-adapter option on PrismaClient constructor.
      // Cast through unknown to satisfy TS without importing the adapter type
      // at module top-level (which would break Node bundling).
      return new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0])
    }
    console.warn('[db] CF_WORKER=1 but no DATABASE D1 binding — falling back to local SQLite. Queries will likely fail.')
  }
  return new PrismaClient({ log: ['query'] })
}

// The soft-delete extension is applied to whichever client we build (Node or
// D1-backed) — it's a pure query-interception layer, runtime-agnostic.
function withSoftDelete(client: PrismaClient) {
  return client.$extends({
    query: Object.fromEntries(
      SOFT_DELETE_MODELS.map((model) => [
        model,
        {
          async findMany({ args, query }: { args: any; query: any }) {
            return query(addDeletedAtFilter(args))
          },
          async findFirst({ args, query }: { args: any; query: any }) {
            return query(addDeletedAtFilter(args))
          },
          async findUnique({ args, query }: { args: any; query: any }) {
            // findUnique uses `where` with unique fields — only filter if it's not an id-only lookup
            // that might need to find a soft-deleted row by id for restore
            if (args.where && 'deletedAt' in args.where) return query(args)
            if (!args.where || (!('deletedAt' in args.where))) {
              args.where = { ...args.where, deletedAt: null }
            }
            return query(args)
          },
          async count({ args, query }: { args: any; query: any }) {
            return query(addDeletedAtFilter(args))
          },
          async aggregate({ args, query }: { args: any; query: any }) {
            return query(addDeletedAtFilter(args))
          },
          async groupBy({ args, query }: { args: any; query: any }) {
            return query(addDeletedAtFilter(args))
          },
        },
      ])
    ),
  })
}

// ---------- client singleton ----------
// PrismaClient must be reused across hot-reloads (dev) and across requests
// (Workers isolate) — otherwise every request opens a new connection pool and
// exhausts D1's connection limit. Cache on globalThis so it survives HMR.
const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof withSoftDelete> | undefined
}

// Top-level await: Next.js App Router server modules support this, and the
// OpenNext worker entry guarantees the Cloudflare context global is published
// before any route handler runs. This preserves the synchronous `db.lead.X()`
// API every call site already uses — no Proxy, no call-site changes.
const baseClient = globalForPrisma.prisma
  ?? (await createBaseClient().then(withSoftDelete))

if (process.env.NODE_ENV !== 'production' || ON_CF) {
  globalForPrisma.prisma = baseClient
}

export const db = baseClient
