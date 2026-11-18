import { NextRequest, NextResponse } from 'next/server'

// TEMP DIAGNOSTIC ENDPOINT — DELETE AFTER DEBUGGING
// GET /api/debug-db — runs a real D1 query and returns the result or the exact error.
// This bypasses withAuth/CSRF/subscription gates so we can see the raw DB error.
export async function GET(_req: NextRequest) {
  const results: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    CF_WORKER: process.env.CF_WORKER,
    NODE_ENV: process.env.NODE_ENV,
    has_DATABASE_in_process_env: 'DATABASE' in process.env,
    DATABASE_from_process_env: process.env.DATABASE ? '(set)' : '(not set)',
  }

  // 1. Check the Cloudflare context global
  const CF_CONTEXT_SYMBOL = Symbol.for('__cloudflare-context__')
  const globalCtx = (globalThis as Record<symbol, unknown>)[CF_CONTEXT_SYMBOL] as
    | { env?: Record<string, unknown> }
    | undefined
  results.cf_context_present = !!globalCtx
  results.cf_env_keys = globalCtx?.env ? Object.keys(globalCtx.env) : []
  const d1 = globalCtx?.env?.DATABASE as { prepare?: (q: string) => unknown } | undefined
  results.DATABASE_binding_present = !!d1
  results.DATABASE_has_prepare = typeof d1?.prepare === 'function'

  // 2. Try to import db and run a query
  try {
    const { db } = await import('@/lib/db')
    results.db_imported = true
    results.db_type = typeof db
    results.db_user_type = typeof (db as { user?: unknown }).user

    // Try a simple count query
    const count = await (db as { user: { count: (args?: unknown) => Promise<number> } }).user.count()
    results.user_count = count
    results.query_ok = true
  } catch (err) {
    results.query_ok = false
    results.query_error_name = err instanceof Error ? err.name : String(err)
    results.query_error_message = err instanceof Error ? err.message : String(err)
    results.query_error_stack = err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : undefined
  }

  return NextResponse.json(results, { status: 200 })
}
