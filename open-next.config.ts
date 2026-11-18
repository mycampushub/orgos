import { defineCloudflareConfig } from '@opennextjs/cloudflare'

/**
 * OpenNext Cloudflare configuration for OrgOS.
 *
 * The app is fully dynamic — a client-rendered workspace plus /api routes —
 * with no ISR/static regeneration, so no incremental cache backing is
 * required. If static generation is introduced later, enable the KV or R2
 * incremental cache overrides here (see @opennextjs/cloudflare docs).
 *
 * IMPORTANT: `buildCommand` is set to `next build` (not the default
 * `${packager} run build`) to break an infinite recursion. OpenNext's
 * buildNextjsApp() defaults to `bun run build` when buildCommand is unset —
 * but our package.json `build` script IS `opennextjs-cloudflare build`, so
 * the default would loop: build → opennextjs-cloudflare build → bun run
 * build → opennextjs-cloudflare build → … (56x until OOM/SIGKILL).
 *
 * `buildCommand` is a top-level OpenNext config property (see
 * @opennextjs/aws types/open-next.d.ts), NOT a defineCloudflareConfig()
 * option, so we spread the Cloudflare config and add it at the top level.
 */
export default {
  ...defineCloudflareConfig(),
  buildCommand: 'next build',
}
