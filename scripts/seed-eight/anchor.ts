/**
 * Fixed demo-timeline anchor for the eight-startup seed.
 *
 * The seed's "today" is a FIXED date, never wall-clock time, so reruns are
 * deterministic and the entire story runs on a future timeline:
 *
 *   HISTORY_FLOOR_KEY (2027-01-01)  = earliest record in the whole seed
 *   ANCHOR_KEY       (2027-06-30)  = demo "today" (Asia/Dhaka)
 *
 * Everything between is ~6 months of operating history. Because every date
 * is in the future relative to real time, dashboards show no overdue tasks,
 * no delayed milestones and no overdue invoices ("nothing delayed").
 *
 * Offsets in the profile data are "days ago" numbers. Those ≤ SOFT_DAYS keep
 * their exact spacing (recent history stays untouched); anything older is
 * compressed monotonically so the deepest history lands exactly on the floor.
 */
export const ANCHOR_KEY = '2027-06-30' // demo today (Asia/Dhaka)
export const HISTORY_FLOOR_KEY = '2027-01-01' // earliest allowed date

const DAY = 86400000
export const FLOOR_MS = Date.parse(`${HISTORY_FLOOR_KEY}T00:00:00Z`)
export const ANCHOR_MS = Date.parse(`${ANCHOR_KEY}T00:00:00Z`)
export const SPAN_DAYS = Math.round((ANCHOR_MS - FLOOR_MS) / DAY) // 180

const SOFT_DAYS = 90 // offsets up to this many days ago are kept verbatim

/**
 * Compress a "days ago" offset into [floor, anchor].
 *   ≤ SOFT_DAYS          → unchanged (recent history exact)
 *   (SOFT_DAYS, maxDays] → scaled monotonically into (SOFT_DAYS, SPAN_DAYS]
 *   negative (future)    → unchanged
 * Monotonic (floor-based), so ordering of related dates is preserved.
 */
export function mapPast(daysAgo: number, maxDays = 1300): number {
  if (daysAgo <= SOFT_DAYS) return daysAgo
  const span = Math.max(SPAN_DAYS, SOFT_DAYS + 1)
  const compressed = SOFT_DAYS + Math.floor(((daysAgo - SOFT_DAYS) * (span - SOFT_DAYS)) / Math.max(maxDays - SOFT_DAYS, 1))
  return Math.min(compressed, span)
}

/** Floor as a Date (2027-01-01T00:00:00Z) — used by the QA validator. */
export function historyFloor(): Date {
  return new Date(FLOOR_MS)
}

/** End of the demo day (anchor 18:00 Dhaka = 12:00 UTC) — "demo now". */
export function demoNow(): Date {
  return new Date(Date.parse(`${ANCHOR_KEY}T12:00:00Z`))
}
