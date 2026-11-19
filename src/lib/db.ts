// OrgOS database client — ONE API, TWO RUNTIMES, ONE SCHEMA.
//
//   Node  (`bun run dev`)  → plain PrismaClient, binary engine, SQLite file at DATABASE_URL
//   Workers (cf:deploy)    → PrismaD1 driver adapter, WASM engine, env.DATABASE binding
//
// All ~50 API routes import this `db` and never care which runtime they're on.
// The schema (prisma/schema.prisma) is the single source of truth; D1 SQL is a
// generated artifact (`bun run db:sql` → cloudflare/migrations/0001_init.sql).
//
// Three rules encoded below, each from a real production bug — do not "simplify" away:
//   1. Import the DEFAULT @prisma/client (NOT /edge — it rejects the `adapter` option).
//   2. On Workers the D1 binding exists only inside a request context, never at
//      build time (next build imports route modules to collect page data) → build
//      the client lazily on first property access, and never cache a failed build.
//   3. Keep this module synchronous — a top-level await breaks OpenNext's esbuild
//      polyfill hoisting (`__name is not defined` crash on the Worker).
import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'

// Models with `deletedAt` get automatic soft-delete filtering on every read.
const SOFT_DELETE_MODELS = ['task', 'invoice', 'expense', 'payrollRun', 'payslip', 'membership', 'document', 'lead'] as const

const ON_CF = process.env.CF_WORKER === '1'

function buildBase(): PrismaClient | null {
  if (!ON_CF) return new PrismaClient({ log: ['query'] })
  // OpenNext publishes the request env on this AsyncLocalStorage-backed global.
  const env = (globalThis as Record<symbol, { env?: { DATABASE?: unknown } } | undefined>)[
    Symbol.for('__cloudflare-context__')
  ]?.env
  if (!env?.DATABASE || typeof (env.DATABASE as { prepare?: unknown }).prepare !== 'function') return null
  const adapter = new PrismaD1(env.DATABASE as Parameters<typeof PrismaD1>[0])
  // Cast needed: the generated client's constructor types don't include `adapter`
  // unless the schema declares the driverAdapters preview feature — the runtime
  // accepts it regardless and switches to the WASM engine.
  return new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0])
}

function withSoftDelete(client: PrismaClient) {
  // Copy-on-write filter: only inject deletedAt: null when the caller hasn't
  // specified it (routes doing restore flows pass deletedAt explicitly).
  const filter = (args: { where?: Record<string, unknown> }) => ({
    ...args,
    where: { deletedAt: null, ...args.where },
  })
  const softReads = Object.fromEntries(
    ['findMany', 'findFirst', 'count', 'aggregate', 'groupBy'].map((op) => [
      op,
      ({ args, query }: { args: any; query: (a?: any) => Promise<unknown> }) => query(filter(args)),
    ]),
  )
  // findUnique is used for id lookups in restore flows — passthrough when the
  // caller references deletedAt, filter otherwise.
  const softFindUnique = ({ args, query }: { args: any; query: (a?: any) => Promise<unknown> }) =>
    args.where && 'deletedAt' in args.where ? query(args) : query(filter(args))

  return client.$extends({
    query: Object.fromEntries(
      SOFT_DELETE_MODELS.map((model) => [model, { ...softReads, findUnique: softFindUnique }]),
    ),
  })
}

type ExtendedClient = ReturnType<typeof withSoftDelete>

const cache = globalThis as unknown as { prisma?: ExtendedClient }

// Lazy Proxy: every property access constructs (or reuses) the real client.
// Property access only happens inside request handlers, so the D1 binding is
// guaranteed to be available by then. A failed build (null) is never cached.
export const db = new Proxy({} as ExtendedClient, {
  get(_target, prop) {
    if (
      typeof prop !== 'string' ||
      prop === 'then' ||
      prop === 'catch' ||
      prop === 'finally' ||
      prop === 'toJSON' ||
      prop === 'constructor'
    ) {
      return undefined
    }
    const client = (cache.prisma ??= (() => {
      const base = buildBase()
      if (!base) {
        throw new Error(
          '[db] CF_WORKER=1 but no DATABASE D1 binding in the request context. ' +
            'Check wrangler.toml [[d1_databases]] binding = "DATABASE".',
        )
      }
      return withSoftDelete(base)
    })())
    return (client as unknown as Record<string, unknown>)[prop]
  },
}) as ExtendedClient
