// CRITICAL: import BOTH PrismaClient variants.
//
// The default `@prisma/client` resolves to `./default.js` which uses the
// BINARY query engine (`libquery_engine-*.so.node`). That native binary
// can't load on Cloudflare Workers (no filesystem, no native addons).
//
// `@prisma/client/edge` uses `@prisma/client/runtime/edge.js` which loads
// the WASM query engine (`query_engine_bg.wasm`). Wasm works on Workers
// but the edge client can't open local SQLite files (`file:` URLs) — it
// requires a driver adapter or a `prisma://` URL.
//
// Solution: import both. On Node, construct `PrismaClientNode` (binary
// engine, opens the local SQLite file at DATABASE_URL). On Workers,
// construct `PrismaClientEdge` (Wasm engine + PrismaD1 adapter). The unused
// import is tree-shaken; importing is safe — the engine only loads on
// `new PrismaClient()`, never at import time.
import { PrismaClient as PrismaClientNode } from '@prisma/client'
import { PrismaClient as PrismaClientEdge } from '@prisma/client/edge'
// Static import — @prisma/adapter-d1 is pure JS (conditional exports: the
// `node` entry just imports @prisma/driver-adapter-utils, no Workers-only
// globals at module top level). We only instantiate it on the Workers
// runtime, but importing it on Node is harmless and keeps this module
// FULLY SYNCHRONOUS — top-level await would break the OpenNext edge-runtime
// polyfill's `__name` helper hoisting (Cloudflare Worker runtime error:
// "Uncaught ReferenceError: __name is not defined").
import { PrismaD1 } from '@prisma/adapter-d1'

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
 * (`cf:dev`) publish the request context on this global via AsyncLocalStorage
 * — see .open-next/cloudflare/init.js. The getter returns the ALS store, which
 * is populated ONLY inside `runWithCloudflareRequestContext(request, env, ctx, handler)`.
 *
 * CRITICAL: at build time (next build's "Collecting page data" phase), route
 * modules are imported to collect metadata — but there's no request, so the
 * ALS store is undefined and this returns null. We must NOT cache a broken
 * (plain PrismaClient) at module-load time; we construct lazily on first use.
 */
const CF_CONTEXT_SYMBOL = Symbol.for('__cloudflare-context__')

interface D1DatabaseLike {
  prepare(query: string): unknown
}

interface CloudflareEnv {
  DATABASE?: D1DatabaseLike
  [key: string]: unknown
}

/**
 * Synchronously read the Cloudflare env from the OpenNext context global.
 * Returns null when not on Workers OR when called outside a request context
 * (e.g. during `next build`'s page-data collection phase, or in a Node dev
 * server). The caller must handle null by falling back to the local path.
 */
function getCloudflareEnvSync(): CloudflareEnv | null {
  const globalCtx = (globalThis as Record<symbol, unknown>)[CF_CONTEXT_SYMBOL] as
    | { env?: CloudflareEnv }
    | undefined
  return globalCtx?.env ?? null
}

/**
 * Build the base PrismaClient for the current runtime — SYNCHRONOUSLY.
 *
 * - Node (local dev / `bun run dev`): plain `new PrismaClient()` against the
 *   SQLite file at db/custom.db (DATABASE_URL in .env).
 * - Cloudflare Workers (production / `cf:dev`): `new PrismaClient({ adapter })`
 *   with the PrismaD1 driver adapter bound to the DATABASE D1 binding.
 *
 * CRITICAL: this function must stay synchronous. A top-level `await` here
 * breaks OpenNext's esbuild bundling — the edge-runtime polyfill that
 * defines `__name` (used to preserve function names for stack traces)
 * stops being hoisted into the module's scope, and every server module
 * that uses named functions throws `ReferenceError: __name is not defined`
 * at runtime on the Worker.
 *
 * Returns null when on Workers but no D1 binding is available (build-time
 * page-data collection, or a misconfigured wrangler.toml). The caller must
 * NOT cache a null result — it would poison all subsequent requests.
 */
function createBaseClient(): PrismaClientNode | PrismaClientEdge | null {
  if (ON_CF) {
    const env = getCloudflareEnvSync()
    const d1 = env?.DATABASE
    if (d1 && typeof d1.prepare === 'function') {
      const adapter = new PrismaD1(d1 as Parameters<typeof PrismaD1>[0])
      // Workers: use the EDGE client (Wasm engine + D1 adapter). The default
      // client's binary engine can't load on Workers (no filesystem).
      return new PrismaClientEdge({ adapter } as ConstructorParameters<typeof PrismaClientEdge>[0])
    }
    // No D1 binding available right now — return null so the caller knows
    // not to cache. This happens during `next build` page-data collection
    // (where route modules are imported without a request context) and would
    // poison the global cache if we constructed a plain PrismaClient here.
    return null
  }
  // Node path: use the DEFAULT client (binary engine, opens SQLite file at
  // DATABASE_URL). The edge client can't open `file:` URLs.
  return new PrismaClientNode({ log: ['query'] })
}

// The type of whichever client is built — both PrismaClientNode and
// PrismaClientEdge have the same API surface ($extends, findMany, etc.)
type AnyPrismaClient = PrismaClientNode | PrismaClientEdge

// The soft-delete extension is applied to whichever client we build (Node or
// D1-backed) — it's a pure query-interception layer, runtime-agnostic.
function withSoftDelete(client: AnyPrismaClient) {
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

// ---------- client singleton (lazy + cache-safe) ----------
// PrismaClient must be reused across hot-reloads (dev) and across requests
// (Workers isolate) — otherwise every request opens a new connection pool and
// exhausts D1's connection limit.
//
// BUT: on Workers, the D1 binding is only available inside a request context
// (set by OpenNext's runWithCloudflareRequestContext). At module-load time
// during `next build`'s page-data collection phase, there's no request, so
// getCloudflareEnvSync() returns null and createBaseClient() returns null.
// If we cached that null (or a plain PrismaClient fallback) on globalThis,
// every subsequent real request would reuse the broken cached client.
//
// Solution: the `db` export is a Proxy that lazily constructs the client on
// first property access — which only happens inside a request handler, where
// the D1 binding IS available. The constructed client is then cached on
// globalThis for reuse across requests in the same isolate.
type ExtendedClient = ReturnType<typeof withSoftDelete>

const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedClient | undefined
}

function buildAndCacheClient(): ExtendedClient {
  const base = createBaseClient()
  if (base === null) {
    // Should never happen at request time on a correctly-configured Worker.
    // If it does, throw a clear error instead of silently falling back to a
    // broken plain PrismaClient (which would 500 on every DB query anyway).
    throw new Error(
      '[db] CF_WORKER=1 but no DATABASE D1 binding available. ' +
        'Ensure wrangler.toml [[d1_databases]] binding = "DATABASE" is set and the database_id is real.'
    )
  }
  const extended = withSoftDelete(base)
  // Cache on globalThis so the client survives HMR (Node dev) and isolate
  // reuse (Workers prod). Skip caching in Node production (fresh per process).
  if (process.env.NODE_ENV !== 'production' || ON_CF) {
    globalForPrisma.prisma = extended
  }
  return extended
}

/**
 * The OrgOS database client.
 *
 * - On Node (`bun run dev`): a plain PrismaClient against the local SQLite
 *   file, wrapped in the soft-delete extension.
 * - On Cloudflare Workers: a PrismaClient backed by the PrismaD1 driver
 *   adapter bound to the DATABASE D1 binding, wrapped in the same soft-delete
 *   extension.
 *
 * LAZY: the underlying client is constructed on first property access, not at
 * module load. This is critical on Workers — at `next build` time, route
 * modules are imported to collect page data, but there's no request context
 * so the D1 binding isn't available yet. Constructing eagerly would cache a
 * broken plain PrismaClient on globalThis and poison every subsequent
 * request. By deferring to first property access (which only happens inside
 * a request handler), we guarantee the D1 binding is available.
 *
 * Type-safe: typed as the extended PrismaClient, so all model delegates
 * (`db.lead`, `db.user`, …), `$transaction`, `$queryRaw`, etc. are fully
 * type-checked at compile time.
 *
 * Usage is unchanged: `await db.lead.findMany(...)`, `await db.$transaction(async (tx) => ...)`, etc.
 */
export const db = (new Proxy(
  // The target is an empty object — every property access forwards to the
  // real (lazily-constructed) client. `get` is the only trap we need because
  // PrismaClient's API is entirely method/property reads.
  {},
  {
    get(_target, prop) {
      // Skip well-known non-string / Promise-coercion symbols. These would
      // otherwise trigger client construction unnecessarily (e.g. `await db`
      // would call get(_, 'then'), which we don't want).
      if (
        typeof prop !== 'string' ||
        prop === 'then' ||
        prop === 'catch' ||
        prop === 'finally' ||
        prop === 'toJSON' ||
        prop === Symbol.toPrimitive ||
        prop === 'constructor'
      ) {
        return undefined
      }
      // Use the cached client if available; otherwise build + cache.
      const client = globalForPrisma.prisma ?? buildAndCacheClient()
      return (client as unknown as Record<string, unknown>)[prop]
    },
  }
) as unknown) as ExtendedClient
