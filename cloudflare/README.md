# OrgOS — Cloudflare Deployment

The canonical Wrangler configuration lives at the **repository root** (`wrangler.toml`) —
it is the single source of truth for the main OpenNext worker. The only other config in
this folder is `cron-wrangler.jsonc` (the companion cron worker).

## Single source of truth for the schema

`prisma/schema.prisma` is THE schema. Everything else is a derived artifact:

| Artifact | How it's produced | When to regenerate |
| -------- | ----------------- | ------------------ |
| Prisma Client (`node_modules/@prisma/client`) | `bun run db:generate` (runs on `bun install`) | on every schema change |
| Local SQLite (`db/custom.db`) | `bun run db:push` | on every schema change |
| D1 SQL (`cloudflare/migrations/0001_init.sql`) | `bun run db:sql` | on every schema change |

There is no second Prisma schema and no hand-maintained SQL — editing
`prisma/schema.prisma` and running `bun run db:sql` is the whole workflow.

## How the dual runtime works (no per-route branching)

`src/lib/db.ts` exposes one `db` object (a lazy Proxy) to all ~50 API routes:

- **Node (`bun run dev`)**: plain `PrismaClient` + binary engine against the local
  SQLite file. `CF_WORKER` is unset → this is the local path.
- **Workers (`cf:deploy`)**: `wrangler.toml` sets `CF_WORKER=1` → `db` detects the
  OpenNext request context, wraps `env.DATABASE` in the `PrismaD1` driver adapter and
  switches Prisma to its WASM engine. Same `db.lead.findMany(...)` calls, same
  soft-delete extension, zero route changes.

D1 **is** SQLite (same dialect, same file format), which is why one schema serves both.

## Resources

| Binding    | Resource                     | Purpose                                                       |
| ---------- | ---------------------------- | ------------------------------------------------------------- |
| `DATABASE` | D1 database `orgos`          | Relational data (mirrors `prisma/schema.prisma`)               |
| `BUCKET`   | R2 bucket `orgos-documents`  | Uploaded document files (`Document.storageKey`, `r2:` prefix)  |
| `SESSIONS` | KV namespace                 | Session tokens + login rate limits (reserved)                  |
| `CACHE`    | KV namespace                 | Dashboard aggregates, pipeline summaries (reserved)            |

Storage is dual-mode (`src/lib/server/storage.ts`): local disk under `db/uploads/` in
local dev, and the `BUCKET` R2 binding on Workers (`CF_WORKER=1` in `wrangler.toml` vars).

## Deploy (step-by-step)

```bash
# 1. Fresh D1 + resources
npx wrangler d1 create orgos            # paste the id into wrangler.toml (DATABASE binding)
npx wrangler r2 bucket create orgos-documents
npx wrangler kv namespace create SESSIONS
npx wrangler kv namespace create CACHE

# 2. Apply the schema (generated from prisma/schema.prisma — see `bun run db:sql`)
bun run cf:d1:migrate:remote
# optional demo data:
npx wrangler d1 execute orgos --remote --file cloudflare/seed/seed-demo.sql

# 3. Build for the Workers runtime and deploy
bun run cf:deploy                       # opennextjs-cloudflare build && wrangler deploy
# local preview against the Workers runtime:
bun run cf:dev                          # opennextjs-cloudflare dev

# 4. Secrets + the companion cron worker
npx wrangler secret put APP_SECRET      # session signing pepper
npx wrangler secret put CRON_SECRET     # shared secret for POST /api/cron/daily
npx wrangler deploy --config cloudflare/cron-wrangler.jsonc
```

### Already deployed before the soft-delete migration?

If your remote D1 was created with the pre-soft-delete `0001_init.sql` (before
`deletedAt` existed), apply the incremental migration instead of re-creating:

```bash
bun run cf:d1:migrate:remote:upgrade    # adds the 8 missing "deletedAt" columns
```

Fresh databases can skip this — `0001_init.sql` already includes `deletedAt`.

## Layout

- `wrangler.toml` (repo root) — canonical Wrangler config for the main worker
- `cloudflare/cron-wrangler.jsonc` + `cloudflare/cron-worker.ts` — daily-schedule companion worker
- `cloudflare/migrations/0001_init.sql` — full D1 schema (generated artifact, `bun run db:sql`)
- `cloudflare/migrations/0002_add_soft_delete.sql` — incremental upgrade for pre-existing D1 databases
- `cloudflare/seed/seed-demo.sql` — optional demo data
- `cloudflare/env.d.ts` — `CloudflareEnv` typings for the bindings
- `scripts/verify-d1.ts` — runs the real PrismaD1 adapter against a local (miniflare) D1 with the migration SQL, proving the Workers path without deploying: `bun run db:verify:d1`
