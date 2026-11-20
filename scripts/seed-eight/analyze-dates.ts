/**
 * Date-offset analyzer for the eight-startup seed.
 * Replicates the exact date math of index.ts (fixed anchor + mapPast
 * compression + sign conventions) and reports:
 *   - the earliest / latest date produced in each category
 *   - violations against the history floor (2027-01-01)
 *   - violations against the "nothing delayed" rules
 *
 * Run: bun scripts/seed-eight/analyze-dates.ts [anchor-YYYY-MM-DD]
 */
import { ORGS_A } from './orgs-a'
import { ORGS_B } from './orgs-b'
import { ANCHOR_KEY, SPAN_DAYS, mapPast } from './anchor'
import type { OrgProfile } from './types'

const anchorArg = process.argv[2] // e.g. 2027-06-30
const FLOOR = '2027-01-01'

const [FY, FM, FD] = FLOOR.split('-').map(Number)
const [AY, AM, AD] = (anchorArg ?? ANCHOR_KEY).split('-').map(Number)
const anchorUtc = Date.UTC(AY, AM - 1, AD)
const floorUtc = Date.UTC(FY, FM - 1, FD)

const MAX_PAST_DAYS = Math.max(400, ...[...ORGS_A, ...ORGS_B].flatMap((o) => o.people.map((p) => p.joinedDaysAgo)))
const past = (d: number) => mapPast(d, MAX_PAST_DAYS)

const keyOf = (t: number) => new Date(t).toISOString().slice(0, 10)
const off = (t: number) => Math.round((t - anchorUtc) / 86400000) // days relative to anchor (negative = past)

interface Hit { org: string; what: string; t: number }
const earliest: Hit[] = []
const latest: Hit[] = []
const issues: string[] = []

function rec(org: string, what: string, t: number) {
  earliest.push({ org, what, t })
  latest.push({ org, what, t })
  if (t < floorUtc) issues.push(`BEFORE-FLOOR  ${org} — ${what} → ${keyOf(t)} (${off(t)}d vs anchor)`)
}

function seedOrg(profile: OrgProfile) {
  const o = profile.name
  // organization createdAt (staggered clamp keeps it on/after the floor)
  rec(o, 'organization.createdAt', Date.UTC(AY, AM - 1, AD - Math.min(past(profile.people[0].joinedDaysAgo) + 10, SPAN_DAYS - (profile.seq - 1))))
  // people
  for (const p of profile.people) {
    rec(o, `user/join ${p.name}`, Date.UTC(AY, AM - 1, AD - past(p.joinedDaysAgo)))
  }
  // clients
  for (const c of profile.clients) rec(o, `client.since ${c.name}`, Date.UTC(AY, AM - 1, AD - past(c.sinceDaysAgo)))
  // projects
  for (const pr of profile.projects) {
    rec(o, `project.start ${pr.code}`, Date.UTC(AY, AM - 1, AD - past(pr.startDaysAgo)))
    const endOff = pr.endDaysAgo !== undefined ? -past(pr.endDaysAgo) : (pr.endInDays ?? 30)
    const endT = Date.UTC(AY, AM - 1, AD + endOff)
    rec(o, `project.end ${pr.code} (${pr.status})`, endT)
    if (['ACTIVE', 'PLANNING'].includes(pr.status) && endT < anchorUtc)
      issues.push(`STALE-PROJECT-END  ${o} — ${pr.code} (${pr.status}) ends ${keyOf(endT)}`)
    for (const m of pr.milestones) {
      rec(o, `milestone.due ${pr.code}/${m.title} (${m.status})`, Date.UTC(AY, AM - 1, AD - past(m.dueDaysAgo)))
      if (m.completedDaysAgo !== undefined) rec(o, `milestone.done ${pr.code}/${m.title}`, Date.UTC(AY, AM - 1, AD - past(m.completedDaysAgo)))
      if (m.status === 'DELAYED') issues.push(`DELAYED-MILESTONE  ${o} — ${pr.code} "${m.title}"`)
      if (m.status === 'IN_PROGRESS' && -past(m.dueDaysAgo) < 0) issues.push(`MILESTONE-IP-PASTDUE  ${o} — ${pr.code} "${m.title}" in progress but due ${keyOf(Date.UTC(AY, AM - 1, AD - past(m.dueDaysAgo)))}`)
      if (m.status === 'COMPLETED' && m.completedDaysAgo !== undefined && -past(m.completedDaysAgo) > -past(m.dueDaysAgo))
        issues.push(`MILESTONE-LATE  ${o} — ${pr.code} "${m.title}" completed after due date`)
    }
    for (const t of pr.tasks) {
      const mDue = past(t.due)
      const dueT = Date.UTC(AY, AM - 1, AD - mDue, 17)
      rec(o, `task.due ${pr.code}/${t.title.slice(0, 32)} (${t.status})`, dueT)
      rec(o, `task.start ${pr.code}/${t.title.slice(0, 32)}`, Date.UTC(AY, AM - 1, AD - past(t.start)))
      if (t.status !== 'DONE' && t.status !== 'BACKLOG' && dueT < anchorUtc)
        issues.push(`OPEN-TASK-PASTDUE  ${o} — ${pr.code} "${t.title}" (${t.status}) due ${keyOf(dueT)}`)
      if (t.status === 'DONE' && mDue >= 0) rec(o, `task.done ${pr.code}/${t.title.slice(0, 32)}`, Date.UTC(AY, AM - 1, AD - (mDue + 1), 16))
      if (t.comment) rec(o, `task.comment ${pr.code}`, Date.UTC(AY, AM - 1, AD - past(t.comment.daysAgo)))
    }
    // generated pool tasks (mirrors index.ts): light projects get topped up
    const explicitCount = pr.tasks.reduce((s, t) => s + 1 + (t.sub?.length ?? 0), 0)
    if (explicitCount < 6) {
      const need = 8 - explicitCount
      const dist = ['DONE', 'DONE', 'DONE', 'IN_PROGRESS', 'IN_PROGRESS', 'TODO', 'REVIEW', 'BACKLOG']
      const msA = past(pr.startDaysAgo)
      for (let i = 0; i < need; i++) {
        const status = dist[(explicitCount + i) % dist.length]
        const startOff = Math.min(-3, -msA + Math.floor((i * (msA + 5)) / need))
        const dueOff = status === 'DONE' ? Math.max(startOff + 2, Math.min(-1, startOff + 6 + i)) : 3 + i * 4
        const dueT = Date.UTC(AY, AM - 1, AD + dueOff, 17)
        rec(o, `pool-task.due ${pr.code} #${i} (${status})`, dueT)
        rec(o, `pool-task.start ${pr.code} #${i}`, Date.UTC(AY, AM - 1, AD + startOff))
        if (status !== 'DONE' && status !== 'BACKLOG' && dueT < anchorUtc)
          issues.push(`POOL-TASK-PASTDUE  ${o} — ${pr.code} pool #${i} (${status}) due ${keyOf(dueT)}`)
        if (status === 'DONE' && dueT >= anchorUtc)
          issues.push(`POOL-TASK-DONE-FUTUREDUE  ${o} — ${pr.code} pool #${i} DONE but due ${keyOf(dueT)}`)
      }
    }
  }
  // leads
  for (const l of profile.leads) rec(o, `lead.created ${l.name}`, Date.UTC(AY, AM - 1, AD - (20 + (l.email.length % 40))))
  // deals
  profile.deals.forEach((d, i) => {
    rec(o, `deal.created ${d.name}`, Date.UTC(AY, AM - 1, AD - (30 + i * 7)))
    if (d.closeInDays !== undefined) {
      const t = Date.UTC(AY, AM - 1, AD + d.closeInDays) // positive = future
      rec(o, `deal.close ${d.name} (${d.status})`, t)
      if (d.status === 'OPEN' && t < anchorUtc) issues.push(`STALE-DEAL-CLOSE  ${o} — "${d.name}" OPEN but expected close ${keyOf(t)}`)
    }
    if (d.wonDaysAgo !== undefined && d.status === 'WON') rec(o, `deal.won ${d.name}`, Date.UTC(AY, AM - 1, AD - past(d.wonDaysAgo)))
  })
  // crm
  for (const a of profile.crmActivities) {
    if (a.dueIn !== undefined) {
      const t = Date.UTC(AY, AM - 1, AD + a.dueIn) // positive = due in N days
      rec(o, `crm.due ${a.subject.slice(0, 32)} (done=${a.done})`, t)
      if (!a.done && t < anchorUtc) issues.push(`CRM-OVERDUE  ${o} — "${a.subject}" not done, due ${keyOf(t)}`)
    }
  }
  // invoices
  for (const inv of profile.invoices) {
    rec(o, `invoice.issue ${inv.number} (${inv.status})`, Date.UTC(AY, AM - 1, AD - past(inv.issueDaysAgo)))
    const dueT = Date.UTC(AY, AM - 1, AD - past(inv.dueDaysAgo), 17)
    rec(o, `invoice.due ${inv.number}`, dueT)
    if (inv.paidDaysAgo !== undefined) rec(o, `invoice.paid ${inv.number}`, Date.UTC(AY, AM - 1, AD - past(inv.paidDaysAgo), 12))
    if (inv.status === 'OVERDUE') issues.push(`OVERDUE-INVOICE  ${o} — ${inv.number}`)
    if (!['PAID', 'CANCELLED', 'DRAFT'].includes(inv.status) && dueT < anchorUtc)
      issues.push(`INVOICE-PASTDUE-UNPAID  ${o} — ${inv.number} (${inv.status}) due ${keyOf(dueT)}`)
    if (inv.status === 'PAID' && inv.paidDaysAgo !== undefined && -past(inv.paidDaysAgo) > -past(inv.dueDaysAgo))
      issues.push(`INVOICE-PAID-LATE  ${o} — ${inv.number} paid after due date`)
  }
  // expenses
  for (const e of profile.expenses) rec(o, `expense ${e.title.slice(0, 32)}`, Date.UTC(AY, AM - 1, AD - past(e.daysAgo)))
  // leaves
  for (const l of profile.leaveRequests) {
    rec(o, `leave.start ${l.who} (${l.status})`, Date.UTC(AY, AM - 1, AD - past(l.startDaysAgo), 9))
    rec(o, `leave.end ${l.who} (${l.status})`, Date.UTC(AY, AM - 1, AD - past(l.endDaysAgo), 18))
    if (l.status === 'PENDING' && Date.UTC(AY, AM - 1, AD - past(l.endDaysAgo)) < anchorUtc)
      issues.push(`STALE-PENDING-LEAVE  ${o} — ${l.who} pending leave ended ${keyOf(Date.UTC(AY, AM - 1, AD - past(l.endDaysAgo)))}`)
  }
  // holidays
  for (const h of profile.holidays) rec(o, `holiday ${h.name}`, Date.UTC(AY, AM - 1, AD - past(h.daysAgo)))
  // jobs (deadlineInDays positive = deadline in N days)
  for (const j of profile.jobs) {
    const dl = Date.UTC(AY, AM - 1, AD + j.deadlineInDays, 17)
    rec(o, `job.deadline ${j.title} (${j.status})`, dl)
    rec(o, `job.created ${j.title}`, Date.UTC(AY, AM - 1, AD - (j.deadlineInDays + 10)))
    if (j.status === 'OPEN' && dl < anchorUtc) issues.push(`STALE-JOB-DEADLINE  ${o} — "${j.title}" OPEN but deadline ${keyOf(dl)}`)
    j.applications.forEach((a, i) => rec(o, `application ${a.name}`, Date.UTC(AY, AM - 1, AD - (3 + i * 4))))
  }
  // meetings (inDays positive = in N days, negative = past)
  for (const m of profile.meetings) rec(o, `meeting ${m.title.slice(0, 32)} (${m.inDays}d)`, Date.UTC(AY, AM - 1, AD + m.inDays, m.hour))
  // announcements / docs / notifications
  for (const a of profile.announcements) rec(o, `announcement ${a.title.slice(0, 32)}`, Date.UTC(AY, AM - 1, AD - past(a.daysAgo), 11))
  for (const d of profile.docs) rec(o, `doc ${d.name.slice(0, 40)}`, Date.UTC(AY, AM - 1, AD - past(d.daysAgo), 14))
  for (const n of profile.notifications) rec(o, `notification ${n.title.slice(0, 32)}`, Date.UTC(AY, AM - 1, AD - Math.max(0.3, past(n.daysAgo)), 9))
  // subscription / payroll (fixed offsets)
  rec(o, 'subscription.started', Date.UTC(AY, AM - 1, AD - 90))
  rec(o, 'subscription.periodEnd', Date.UTC(AY, AM - 1, AD + 20))
  rec(o, 'payroll.paid', Date.UTC(AY, AM - 1, AD - 19, 11))
  // attendance window: 1st of prev month → anchor
  rec(o, 'attendance.windowStart', Date.UTC(AY, AM - 2, 1))
  rec(o, 'attendance.windowEnd', anchorUtc)
  // activities: anchor 18:00 Dhaka minus hoursAgo
  for (const a of profile.activities) rec(o, `activity ${a.message.slice(0, 40)}`, Date.UTC(AY, AM - 1, AD, 12) - a.hoursAgo * 3600000)
}

for (const p of [...ORGS_A, ...ORGS_B]) seedOrg(p)

earliest.sort((a, b) => a.t - b.t)
latest.sort((a, b) => b.t - a.t)

console.log(`Anchor (demo today): ${keyOf(anchorUtc)}   Floor: ${FLOOR}   MAX_PAST_DAYS: ${MAX_PAST_DAYS}`)
console.log(`\nEarliest 12 dates:`)
for (const h of earliest.slice(0, 12)) console.log(`  ${keyOf(h.t)}  (${off(h.t)}d)  ${h.org} — ${h.what}`)
console.log(`\nLatest 12 dates:`)
for (const h of latest.slice(0, 12)) console.log(`  ${keyOf(h.t)}  (+${off(h.t)}d)  ${h.org} — ${h.what}`)

console.log(`\n${issues.length} issue(s):`)
const byType = new Map<string, string[]>()
for (const i of issues) {
  const k = i.split('  ')[0]
  if (!byType.has(k)) byType.set(k, [])
  byType.get(k)!.push(i)
}
for (const [k, list] of byType) {
  console.log(`\n--- ${k} (${list.length}) ---`)
  for (const l of list.slice(0, 40)) console.log('  ' + l)
  if (list.length > 40) console.log(`  … +${list.length - 40} more`)
}
