/**
 * OrgOS eight-startup seed generator.
 *
 * Wipes all user tables, then builds eight independent, internally consistent
 * startups (people, org structures, clients, projects, tasks, CRM, finance,
 * HR, recruitment, internal ops) from scripts/seed-eight/{types,orgs-a,orgs-b}.ts.
 *
 * Ids are deterministic and readable (e.g. tsk-0012) so reruns are stable.
 * Money is stored in cents; dates use Asia/Dhaka. Run: bun scripts/seed-eight/index.ts
 */
import { PrismaClient } from '@prisma/client'
import { randomUUID, scryptSync } from 'crypto'
import { ORGS_A } from './orgs-a'
import { ORGS_B } from './orgs-b'
import type { OrgProfile, PersonDef, ProjectDef } from './types'
import { ANCHOR_KEY, HISTORY_FLOOR_KEY, SPAN_DAYS, mapPast } from './anchor'

const db = new PrismaClient()
const PASSWORD = scryptSync('password123', 'orgos-seed-eight', 64).toString('hex')
const SALT = 'orgos-seed-eight'
const passwordHash = `scrypt:${SALT}:${PASSWORD}`
const DAY = 86400000

// ---------- Dhaka-time helpers ----------
// Fixed demo anchor (see ./anchor.ts): the whole story runs 2027-01-01 → 2027-06-30.
// No wall-clock reads — reruns are deterministic and nothing can look overdue.
const todayKey = ANCHOR_KEY // demo "today" (YYYY-MM-DD, Asia/Dhaka)
const [TY, TM, TD] = ANCHOR_KEY.split('-').map(Number)
const FLOOR_MS = Date.parse(`${HISTORY_FLOOR_KEY}T00:00:00Z`)
// Deepest "days ago" across the profiles — past() compresses anything older
// than 90 days (monotonically) so the earliest record lands on 2027-01-01.
const MAX_PAST_DAYS = Math.max(400, ...[...ORGS_A, ...ORGS_B].flatMap((o) => o.people.map((p) => p.joinedDaysAgo)))
const past = (daysAgo: number) => mapPast(daysAgo, MAX_PAST_DAYS)
const pad = (n: number) => String(n).padStart(2, '0')

/** Date N days from the demo anchor at a local hour. N negative = past. */
function dhakaDate(offsetDays: number, hour = 10, min = 0): Date {
  return new Date(Date.UTC(TY, TM - 1, TD + offsetDays, hour - 6, min, 0))
}
function dhakaKey(offsetDays: number): string {
  const d = new Date(Date.UTC(TY, TM - 1, TD + offsetDays))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
function hourOn(offsetDays: number, hour: number, min: number): Date {
  return dhakaDate(offsetDays, hour, min)
}

// ---------- deterministic id factory ----------
const counters = new Map<string, number>()
function mk(type: string): string {
  const n = (counters.get(type) ?? 0) + 1
  counters.set(type, n)
  return `${type}-${String(n).padStart(4, '0')}`
}
const emailOf = (name: string, slug: string) =>
  `${name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}@${slug}.orgos.dev`
const phoneOf = (n: number) => `+88017${String(10000000 + n * 137).slice(0, 8)}`

interface Ctx {
  orgId: string
  p: Map<string, { membershipId: string; userId: string; person: PersonDef }>
  dept: Map<string, string>
  company: Map<string, string>
  client: Map<string, string>
  stage: Map<string, string>
  leaveType: Map<string, string>
  project: Map<string, string>
}

async function wipe() {
  // children first (same order as prisma/seed.ts + ContactMessage)
  await db.sessionTaskEntry.deleteMany()
  await db.attendanceSession.deleteMany()
  await db.payslip.deleteMany()
  await db.payrollRun.deleteMany()
  await db.salaryComponent.deleteMany()
  await db.boardColumn.deleteMany()
  await db.orgPolicy.deleteMany()
  await db.holiday.deleteMany()
  await db.moduleAccess.deleteMany()
  await db.taskDependency.deleteMany()
  await db.timeEntry.deleteMany()
  await db.comment.deleteMany()
  await db.crmActivity.deleteMany()
  await db.application.deleteMany()
  await db.invoice.deleteMany()
  await db.expense.deleteMany()
  await db.leaveRequest.deleteMany()
  await db.attendance.deleteMany()
  await db.document.deleteMany()
  await db.announcement.deleteMany()
  await db.notification.deleteMany()
  await db.activityLog.deleteMany()
  await db.auditLog.deleteMany()
  await db.meetingParticipant.deleteMany()
  await db.meeting.deleteMany()
  await db.deal.deleteMany()
  await db.lead.deleteMany()
  await db.pipelineStage.deleteMany()
  await db.client.deleteMany()
  await db.contact.deleteMany()
  await db.company.deleteMany()
  await db.leaveType.deleteMany()
  await db.job.deleteMany()
  await db.task.deleteMany()
  await db.milestone.deleteMany()
  await db.projectMember.deleteMany()
  await db.project.deleteMany()
  await db.teamMember.deleteMany()
  await db.team.deleteMany()
  await db.membership.deleteMany()
  await db.department.deleteMany()
  await db.billingRequest.deleteMany()
  await db.subscription.deleteMany()
  await db.organization.deleteMany()
  await db.plan.deleteMany()
  await db.session.deleteMany()
  await db.contactMessage.deleteMany()
  await db.user.deleteMany()
}

const TASK_COLUMNS: Array<[string, string, number, boolean, boolean, string]> = [
  ['BACKLOG', 'Backlog', 0, false, false, '#94a3b8'],
  ['TODO', 'To do', 1, false, false, '#64748b'],
  ['IN_PROGRESS', 'In progress', 2, false, false, '#14b8a6'],
  ['REVIEW', 'Review', 3, false, false, '#f59e0b'],
  ['DONE', 'Done', 4, true, false, '#10b981'],
]
const HIRING_COLUMNS: Array<[string, string, number, boolean, boolean, string]> = [
  ['APPLIED', 'Applied', 0, false, false, '#64748b'],
  ['SCREENING', 'Screening', 1, false, false, '#14b8a6'],
  ['SHORTLISTED', 'Shortlisted', 2, false, false, '#0d9488'],
  ['INTERVIEW', 'Interview', 3, false, false, '#f59e0b'],
  ['ASSESSMENT', 'Assessment', 4, false, false, '#fbbf24'],
  ['OFFER', 'Offer', 5, false, false, '#34d399'],
  ['HIRED', 'Hired', 6, true, false, '#059669'],
  ['REJECTED', 'Rejected', 7, false, true, '#f43f5e'],
]
const STAGE_DEFS: Array<[string, number]> = [['New', 0], ['Qualified', 1], ['Meeting', 2], ['Proposal', 3], ['Negotiation', 4]]

function salaryComponents(person: PersonDef, membershipId: string, orgId: string) {
  const rows: Array<{ orgId: string; membershipId: string; label: string; kind: 'ALLOWANCE' | 'DEDUCTION'; amount: number; id: string }> = []
  const s = person.salary
  if (!s) return rows
  if (s >= 40000) rows.push({ orgId, membershipId, label: 'Transport allowance', kind: 'ALLOWANCE', amount: 5000 * 100, id: mk('cmp') })
  if (s >= 50000) rows.push({ orgId, membershipId, label: 'Provident fund', kind: 'DEDUCTION', amount: Math.round(s * 0.05) * 100, id: mk('cmp') })
  if (s >= 120000) rows.push({ orgId, membershipId, label: 'Tax withholding', kind: 'DEDUCTION', amount: Math.round(s * 0.1) * 100, id: mk('cmp') })
  return rows
}

async function seedOrg(profile: OrgProfile, planIds: Map<string, string>, userCounter: { n: number }) {
  const { seq } = profile
  console.log(`  · ${profile.name} (org ${seq}/8)`)

  // ---------- organization ----------
  const ceoPerson = profile.people.find((p) => p.role === 'OWNER')!
  const ceoUserRow = { id: mk('usr'), email: emailOf(ceoPerson.name, profile.slug), name: ceoPerson.name }
  await db.user.create({
    data: {
      id: ceoUserRow.id, email: ceoUserRow.email, passwordHash, name: ceoPerson.name,
      headline: ceoPerson.headline, bio: `CEO of ${profile.name} (demo profile).`, location: 'Dhaka, Bangladesh',
      skills: ceoPerson.skills, emailVerified: hourOn(-30, 12), createdAt: dhakaDate(-past(ceoPerson.joinedDaysAgo)),
    },
  })
  const org = await db.organization.create({
    data: {
      id: mk('org'), name: profile.name, slug: profile.slug, description: profile.description,
      industry: profile.industry, orgType: profile.orgType, website: profile.website,
      country: 'Bangladesh', timezone: 'Asia/Dhaka', currency: 'BDT', plan: profile.planCode,
      status: 'ACTIVE', foundedYear: profile.foundedYear, ownerId: ceoUserRow.id,
      createdAt: dhakaDate(-Math.min(past(profile.people[0].joinedDaysAgo) + 10, SPAN_DAYS - (seq - 1))),
    },
  })
  const ctx: Ctx = { orgId: org.id, p: new Map(), dept: new Map(), company: new Map(), client: new Map(), stage: new Map(), leaveType: new Map(), project: new Map() }

  // ---------- departments & teams ----------
  for (const d of profile.departments) {
    const row = { id: mk('dep'), orgId: org.id, name: d.name, color: d.color, description: `${d.name} of ${profile.name}.` }
    await db.department.create({ data: row })
    ctx.dept.set(d.name, row.id)
  }
  const teamRows = profile.teams.map((t) => ({ id: mk('tem'), orgId: org.id, departmentId: ctx.dept.get(t.dept)!, name: t.name, description: `${t.name} — ${t.dept}.` }))
  await db.team.createMany({ data: teamRows })

  // ---------- users + memberships ----------
  const staffUsers: Array<{ id: string; email: string; name: string; headline: string; skills: string; joined: number }> = []
  for (const person of profile.people) {
    if (person.role === 'OWNER') continue
    staffUsers.push({ id: mk('usr'), email: emailOf(person.name, profile.slug), name: person.name, headline: person.headline, skills: person.skills, joined: person.joinedDaysAgo })
    userCounter.n++
  }
  await db.user.createMany({
    data: staffUsers.map((u) => ({
      id: u.id, email: u.email, passwordHash, name: u.name, headline: u.headline,
      bio: `${u.name.split(' ')[0]} works at ${profile.name} (demo profile).`, location: 'Dhaka, Bangladesh',
      skills: u.skills, emailVerified: hourOn(-30, 12), createdAt: dhakaDate(-past(u.joined)),
    })),
  })
  const membershipRows = profile.people.map((person) => {
    const u = person.role === 'OWNER' ? { id: ceoUserRow.id } : staffUsers.find((s) => s.name === person.name)!
    return {
      id: mk('mem'), userId: u.id, orgId: org.id, role: person.role, title: person.title,
      departmentId: ctx.dept.get(person.dept)!, employmentType: person.type, status: 'ACTIVE',
      employeeCode: `${profile.codePrefix}-${String(profile.people.indexOf(person) + 1).padStart(3, '0')}`,
      joinedAt: dhakaDate(-past(person.joinedDaysAgo)), phone: phoneOf(userCounter.n),
      baseSalary: person.salary ? person.salary * 100 : null,
      createdAt: dhakaDate(-past(person.joinedDaysAgo)),
    }
  })
  await db.membership.createMany({ data: membershipRows })
  for (let i = 0; i < profile.people.length; i++) {
    const person = profile.people[i]
    ctx.p.set(person.key, { membershipId: membershipRows[i].id, userId: person.role === 'OWNER' ? ceoUserRow.id : staffUsers.find((s) => s.name === person.name)!.id, person })
  }
  // manager links (second pass)
  for (const person of profile.people) {
    if (person.manager) {
      await db.membership.update({ where: { id: ctx.p.get(person.key)!.membershipId }, data: { managerId: ctx.p.get(person.manager)!.membershipId } })
    }
  }
  // team members: put each team's dept head + first staff of that dept deterministically
  const teamMemberRows: Array<{ id: string; teamId: string; membershipId: string; role?: string }> = []
  teamRows.forEach((t, ti) => {
    const deptName = profile.teams[ti].dept
    const members = profile.people.filter((p) => p.dept === deptName).slice(0, 3)
    members.forEach((p, pi) => {
      teamMemberRows.push({ id: mk('tmb'), teamId: t.id, membershipId: ctx.p.get(p.key)!.membershipId, role: pi === 0 ? 'Lead' : undefined })
    })
  })
  await db.teamMember.createMany({ data: teamMemberRows })

  // ---------- board columns / pipeline / leave types / holidays / policy ----------
  await db.boardColumn.createMany({
    data: [
      ...TASK_COLUMNS.map(([key, label, order, isDone, isRejected, color]) => ({ id: mk('bcl'), orgId: org.id, surface: 'TASK', key, label, order, isDone, isRejected, color })),
      ...HIRING_COLUMNS.map(([key, label, order, isDone, isRejected, color]) => ({ id: mk('bcl'), orgId: org.id, surface: 'HIRING', key, label, order, isDone, isRejected, color })),
    ],
  })
  for (const [name, order] of STAGE_DEFS) {
    const row = { id: mk('stg'), orgId: org.id, name, order }
    await db.pipelineStage.create({ data: row })
    ctx.stage.set(name, row.id)
  }
  const leaveTypeRows = [
    { id: mk('ltp'), orgId: org.id, name: 'Casual Leave', daysPerYear: 10, color: '#10b981', paid: true },
    { id: mk('ltp'), orgId: org.id, name: 'Sick Leave', daysPerYear: 14, color: '#f43f5e', paid: true },
    { id: mk('ltp'), orgId: org.id, name: 'Annual Leave', daysPerYear: 20, color: '#14b8a6', paid: true },
    { id: mk('ltp'), orgId: org.id, name: 'Unpaid leave', daysPerYear: 5, color: '#64748b', paid: false },
  ]
  await db.leaveType.createMany({ data: leaveTypeRows })
  leaveTypeRows.forEach((r) => ctx.leaveType.set(r.name, r.id))
  await db.holiday.createMany({
    data: profile.holidays.map((h) => ({
      id: mk('hol'), orgId: org.id, name: h.name, type: h.type,
      startDate: dhakaDate(-past(h.daysAgo)), endDate: dhakaDate(-past(h.daysAgo)), description: h.description,
    })),
  })
  const holidayKeys = new Set(profile.holidays.filter((h) => -h.daysAgo <= 0).map((h) => dhakaKey(-past(h.daysAgo))))
  await db.orgPolicy.create({ data: { id: mk('pol'), orgId: org.id, checkInTime: '09:00', checkOutTime: '17:30', payrollDay: 28 } })

  // ---------- companies / contacts / clients ----------
  for (const c of profile.clients) {
    const comp = { id: mk('com'), orgId: org.id, name: c.name, industry: c.industry, website: c.website, address: c.address }
    await db.company.create({ data: comp })
    ctx.company.set(c.key, comp.id)
    await db.contact.createMany({
      data: c.contacts.map((ct, i) => ({ id: mk('cnt'), orgId: org.id, companyId: comp.id, name: ct.name, position: ct.position, email: ct.email, phone: ct.phone, notes: i === 0 ? 'Primary contact.' : undefined })),
    })
    const cl = { id: mk('cli'), orgId: org.id, companyId: comp.id, name: c.name, contactEmail: c.contactEmail, status: c.status, healthNote: c.healthNote, since: dhakaDate(-past(c.sinceDaysAgo)) }
    await db.client.create({ data: cl })
    ctx.client.set(c.key, cl.id)
  }

  // ---------- projects / members / milestones / tasks ----------
  const projectDefs: ProjectDef[] = profile.projects
  for (const proj of projectDefs) {
    const startOffset = -past(proj.startDaysAgo)
    // endInDays = "ends in N days" (positive = future); endDaysAgo = past endDate.
    const endDate = proj.endDaysAgo !== undefined ? dhakaDate(-past(proj.endDaysAgo)) : dhakaDate(proj.endInDays ?? 30)
    const pr = {
      id: mk('prj'), orgId: org.id, name: proj.name, code: proj.code,
      clientId: proj.clientKey ? ctx.client.get(proj.clientKey)! : null,
      managerMembershipId: ctx.p.get(proj.managerKey)!.membershipId,
      status: proj.status, priority: proj.priority, budget: proj.budget * 100,
      startDate: dhakaDate(startOffset), endDate, progress: proj.progress, color: proj.color,
      description: proj.description, createdAt: dhakaDate(startOffset),
    }
    await db.project.create({ data: pr })
    ctx.project.set(proj.code, pr.id)
    const memberRows = [{ id: mk('pmb'), projectId: pr.id, membershipId: ctx.p.get(proj.managerKey)!.membershipId, role: 'Project Manager' }]
    for (const s of proj.staff ?? []) memberRows.push({ id: mk('pmb'), projectId: pr.id, membershipId: ctx.p.get(s.who)!.membershipId, role: s.role })
    // add remaining dept-flavored staff so every project has 3+ people
    const already = new Set(memberRows.map((m) => m.membershipId))
    for (const person of profile.people) {
      if (memberRows.length >= 4) break
      const m = ctx.p.get(person.key)!
      if (already.has(m.membershipId) || person.role === 'OWNER') continue
      memberRows.push({ id: mk('pmb'), projectId: pr.id, membershipId: m.membershipId, role: 'Contributor' })
      already.add(m.membershipId)
    }
    await db.projectMember.createMany({ data: memberRows })
    await db.milestone.createMany({
      data: proj.milestones.map((m) => ({
        id: mk('msl'), projectId: pr.id, title: m.title, status: m.status, dueDate: dhakaDate(-past(m.dueDaysAgo)),
        completedAt: m.completedDaysAgo !== undefined ? dhakaDate(-past(m.completedDaysAgo)) : null,
        description: `${m.title} — ${proj.name}.`,
      })),
    })

    // tasks: explicit seeds
    const createdTasks: Array<{ id: string; status: string }> = []
    const parentTasks = proj.tasks.filter((t) => !t.sub?.length)
    const parentsWithSubs = proj.tasks.filter((t) => t.sub?.length)
    const mkTask = (t: (typeof proj.tasks)[number], parentId?: string, orderIdx?: number) => {
      const mStart = past(t.start)
      const mDue = past(t.due)
      const start = dhakaDate(-mStart)
      const due = dhakaDate(-mDue, 17)
      const isDone = t.status === 'DONE'
      const completedAt = isDone ? (mDue >= 0 ? dhakaDate(-mDue - 1, 16) : dhakaDate(Math.min(0, Math.floor((-mDue) / 2)), 16)) : null
      return {
        id: mk('tsk'), orgId: org.id, projectId: pr.id, title: t.title,
        description: `${t.title}. Part of ${proj.name} for ${proj.clientKey ? profile.clients.find((c) => c.key === proj.clientKey)?.name : 'internal operations'}.`,
        assigneeMembershipId: ctx.p.get(t.who)!.membershipId,
        creatorMembershipId: ctx.p.get(proj.managerKey)!.membershipId,
        priority: t.pri, status: t.status, startDate: start, dueDate: due,
        estimatedHours: t.est ?? 8, actualHours: isDone ? (t.act ?? t.est ?? 8) : t.act ?? null,
        tags: t.tags ?? null, order: orderIdx ?? createdTasks.length,
        completedAt, parentTaskId: parentId ?? null,
        createdAt: dhakaDate(-mStart - 1),
      }
    }
    const allParentRows = [...parentTasks, ...parentsWithSubs].map((t, i) => mkTask(t, undefined, i))
    await db.task.createMany({ data: allParentRows })
    const subRows: Array<Record<string, unknown>> = []
    allParentRows.forEach((row, i) => {
      const seed = [...parentTasks, ...parentsWithSubs][i]
      createdTasks.push({ id: row.id, status: seed.status })
      for (const [si, subTitle] of (seed.sub ?? []).entries()) {
        subRows.push(mkTask({ ...seed, title: subTitle, status: seed.status === 'DONE' ? 'DONE' : si === 0 ? 'IN_PROGRESS' : 'TODO' }, row.id, 100 + si))
      }
    })
    if (subRows.length) {
      await db.task.createMany({ data: subRows as never })
      for (const row of subRows) createdTasks.push({ id: (row as { id: string }).id, status: (row as { status: string }).status })
    }
    // dependencies: chain the first 3 parent tasks (FS)
    const depRows: Array<{ id: string; taskId: string; dependsOnTaskId: string; type: string }> = []
    for (let i = 1; i < Math.min(4, createdTasks.length); i++) {
      depRows.push({ id: mk('tdp'), taskId: createdTasks[i].id, dependsOnTaskId: createdTasks[i - 1].id, type: 'FS' })
    }
    if (depRows.length) await db.taskDependency.createMany({ data: depRows })
    // comments on ~1/3 of parent tasks
    const commentRows = proj.tasks
      .filter((t) => t.comment)
      .map((t, i) => {
        const parentRow = allParentRows[[...parentTasks, ...parentsWithSubs].indexOf(t)]
        return {
          id: mk('cmt'), orgId: org.id, entityType: 'TASK', entityId: parentRow.id, taskId: parentRow.id,
          authorMembershipId: ctx.p.get(t.comment!.who)!.membershipId,
          body: t.comment!.body, createdAt: dhakaDate(-past(t.comment!.daysAgo)),
        }
      })
    if (commentRows.length) await db.comment.createMany({ data: commentRows })
    // time entries for non-backlog tasks
    const teRows: Array<{ id: string; taskId: string; membershipId: string; minutes: number; note: string; billable: boolean; createdAt: Date }> = []
    for (const seed of proj.tasks) {
      if (seed.status === 'BACKLOG' || seed.status === 'TODO') continue
      if ((seed.start * 7 + seed.due) % 3 === 0) continue // deterministic skip
      const parentRow = allParentRows[[...parentTasks, ...parentsWithSubs].indexOf(seed)]
      const minutes = Math.round(((seed.act ?? seed.est ?? 8) * 60) / 2)
      teRows.push({ id: mk('tie'), taskId: parentRow.id, membershipId: ctx.p.get(seed.who)!.membershipId, minutes, note: `Work session — ${seed.title.slice(0, 40)}`, billable: true, createdAt: dhakaDate(-Math.max(1, past(seed.due) - 2), 14) })
    }
    if (teRows.length) await db.timeEntry.createMany({ data: teRows })
  }

  // ---------- generated ops tasks (taskPool) for lighter projects ----------
  // (flagship projects have explicit tasks; ensure every project has ≥6 tasks by
  // topping up from the org-flavored pool with deterministic variety)
  for (const proj of projectDefs) {
    const existing = await db.task.count({ where: { projectId: ctx.project.get(proj.code)! } })
    if (existing >= 6) continue
    const clientName = proj.clientKey ? profile.clients.find((c) => c.key === proj.clientKey)?.name ?? '' : 'internal ops'
    const candidates = profile.people.filter((p) => !['OWNER'].includes(p.role) && p.type !== 'FREELANCE')
    const need = 8 - existing
    const rows: Array<Record<string, unknown>> = []
    const dist: Array<string> = ['DONE', 'DONE', 'DONE', 'IN_PROGRESS', 'IN_PROGRESS', 'TODO', 'REVIEW', 'BACKLOG']
    for (let i = 0; i < need; i++) {
      const title = profile.taskPool[(existing + i) % profile.taskPool.length].replace('{client}', clientName).replace('{n}', String(i + 1))
      const who = candidates[(existing + i * 3) % candidates.length]
      const status = dist[(existing + i) % dist.length]
      const msA = past(proj.startDaysAgo)
      const start = Math.min(-3, -msA + Math.floor((i * (msA + 5)) / need))
      // due is a raw offset here: negative = past (DONE), positive = future (open work).
      const due = status === 'DONE' ? Math.max(start + 2, Math.min(-1, start + 6 + i)) : 3 + i * 4
      const isDone = status === 'DONE'
      rows.push({
        id: mk('tsk'), orgId: ctx.orgId, projectId: ctx.project.get(proj.code), title,
        description: `${title}. Operational task under ${proj.name}.`,
        assigneeMembershipId: ctx.p.get(who.key)!.membershipId,
        creatorMembershipId: ctx.p.get(proj.managerKey)!.membershipId,
        priority: i % 4 === 0 ? 'HIGH' : 'MEDIUM', status,
        startDate: dhakaDate(start), dueDate: dhakaDate(due, 17),
        estimatedHours: 4 + (i % 4) * 2, actualHours: isDone ? 4 + (i % 4) * 2 : null,
        order: 50 + i, completedAt: isDone ? dhakaDate(due - 1, 16) : null,
        createdAt: dhakaDate(start - 1),
      })
    }
    if (rows.length) await db.task.createMany({ data: rows as never })
  }

  // ---------- leads / deals / CRM activities ----------
  const leadRows = profile.leads.map((l) => ({
    id: mk('led'), orgId: org.id, name: l.name, company: l.company, email: l.email, phone: l.phone,
    source: l.source, status: l.status, value: l.value * 100, industry: profile.industry,
    notes: l.notes, ownerMembershipId: ctx.p.get(l.owner)!.membershipId,
    convertedCompanyId: l.convertedCompanyKey ? ctx.company.get(l.convertedCompanyKey)! : null,
    createdAt: dhakaDate(-(20 + (l.email.length % 40))),
  }))
  await db.lead.createMany({ data: leadRows })
  const dealRows = profile.deals.map((d, i) => ({
    id: mk('dil'), orgId: org.id, name: d.name, value: d.value * 100,
    companyId: ctx.company.get(d.companyKey)!, contactId: null as string | null,
    stageId: ctx.stage.get(d.stage)!, probability: d.prob,
    expectedCloseDate: d.closeInDays !== undefined ? dhakaDate(d.closeInDays) : null,
    status: d.status, ownerMembershipId: ctx.p.get(d.owner)!.membershipId,
    clientId: d.clientKey ? ctx.client.get(d.clientKey)! : null,
    projectId: d.projectCode ? ctx.project.get(d.projectCode)! : null,
    notes: d.notes ?? null, wonAt: d.status === 'WON' && d.wonDaysAgo ? dhakaDate(-past(d.wonDaysAgo)) : null,
    createdAt: dhakaDate(-(30 + i * 7)),
  }))
  await db.deal.createMany({ data: dealRows })
  const crmRows = profile.crmActivities.map((a) => {
    const id = a.entity === 'LEAD' ? leadRows[a.ref]?.id : dealRows[a.ref]?.id
    return {
      id: mk('cma'), orgId: org.id, entityType: a.entity, entityId: id!, type: a.type,
      subject: a.subject, notes: a.notes, dueDate: a.dueIn !== undefined ? dhakaDate(a.dueIn) : null,
      done: a.done, createdById: ctx.p.get(a.who)!.membershipId, createdAt: dhakaDate(-(3 + (a.subject.length % 20))),
    }
  })
  await db.crmActivity.createMany({ data: crmRows })

  // ---------- invoices ----------
  const invoiceRows = profile.invoices.map((inv, i) => {
    const taxRate = inv.taxRate ?? 5
    const taxAmountTaka = Math.round((inv.subtotal * taxRate) / 100)
    return {
      id: mk('inv'), orgId: org.id, clientId: ctx.client.get(inv.clientKey)!,
      number: inv.number, status: inv.status,
      items: JSON.stringify(inv.items.map(([description, qty, rate]) => ({ description, qty, rate: rate * 100 }))),
      subtotal: inv.subtotal * 100, taxRate, taxAmount: taxAmountTaka * 100, discount: 0,
      total: (inv.subtotal + taxAmountTaka) * 100,
      issueDate: dhakaDate(-past(inv.issueDaysAgo)), dueDate: dhakaDate(-past(inv.dueDaysAgo), 17),
      paidAt: inv.status === 'PAID' && inv.paidDaysAgo ? dhakaDate(-past(inv.paidDaysAgo), 12) : null,
      projectId: inv.projectCode ? ctx.project.get(inv.projectCode)! : null,
      notes: 'Synthetic demo invoice — not a real financial document.',
      createdAt: dhakaDate(-past(inv.issueDaysAgo)),
    }
  })
  await db.invoice.createMany({ data: invoiceRows })

  // ---------- expenses ----------
  const expenseRows = profile.expenses.map((e, i) => ({
    id: mk('exp'), orgId: org.id, membershipId: ctx.p.get(e.who)!.membershipId,
    projectId: e.projectCode ? ctx.project.get(e.projectCode)! : null,
    title: e.title, category: e.category, amount: e.amount * 100,
    date: dhakaDate(-past(e.daysAgo)), status: e.status,
    notes: e.notes ?? null, receiptUrl: null,
    approvedById: e.approver ? ctx.p.get(e.approver)!.membershipId : null,
    createdAt: dhakaDate(-past(e.daysAgo)),
  }))
  await db.expense.createMany({ data: expenseRows })

  // ---------- attendance (from 1st of previous month → today, weekdays) ----------
  const activePeople = profile.people.filter((p) => p.status !== 'RESIGNED')
  const approvedLeaves = profile.leaveRequests.filter((l) => l.status === 'APPROVED')
  const unpaidApproved = approvedLeaves.filter((l) => l.type === 'Unpaid leave')
  const firstOfPrevMonth = new Date(Date.UTC(TY, TM - 2, 1))
  const attendanceRows: Array<{ id: string; orgId: string; membershipId: string; date: string; checkIn: Date | null; checkOut: Date | null; status: string; workedMinutes: number | null; note: string | null }> = []
  const attendanceMeta: Array<{ membershipId: string; date: string; status: string }> = []
  const dayCursor = new Date(firstOfPrevMonth)
  const todayUtc = new Date(Date.UTC(TY, TM - 1, TD))
  while (dayCursor <= todayUtc) {
    const dow = dayCursor.getUTCDay()
    const key = `${dayCursor.getUTCFullYear()}-${pad(dayCursor.getUTCMonth() + 1)}-${pad(dayCursor.getUTCDate())}`
    const offsetFromToday = Math.round((dayCursor.getTime() - todayUtc.getTime()) / DAY)
    const isToday = offsetFromToday === 0
    if (dow !== 0 && dow !== 6 && !holidayKeys.has(key)) {
      activePeople.forEach((person, idx) => {
        if (isToday && idx % 3 === 1) return // hasn't checked in yet today
        const mem = ctx.p.get(person.key)!
        const onLeave = approvedLeaves.some((l) => {
          const s = dhakaKey(-past(l.startDaysAgo)), e = dhakaKey(-past(l.endDaysAgo))
          return ctx.p.get(l.who)!.membershipId === mem.membershipId && key >= s && key <= e
        })
        const roll = (idx * 7 + dayCursor.getUTCDate() * 3) % 10
        let status = 'PRESENT'
        if (onLeave) status = 'LEAVE'
        else if (roll === 3) status = 'LATE'
        else if (roll === 7) status = 'LEAVE'
        else if (roll === 9 && !isToday) status = 'ABSENT'
        let checkIn: Date | null = null
        let checkOut: Date | null = null
        if (status === 'PRESENT') checkIn = hourOn(offsetFromToday, 9, (idx * 17 + dayCursor.getUTCDate() * 7) % 40)
        if (status === 'LATE') checkIn = hourOn(offsetFromToday, 10, 15 + (idx % 30))
        if (status !== 'LEAVE' && status !== 'ABSENT' && !isToday) checkOut = hourOn(offsetFromToday, 18, (idx * 13) % 35)
        const workedMinutes = checkIn && checkOut ? Math.round((checkOut.getTime() - checkIn.getTime()) / 60000) : null
        attendanceRows.push({
          id: mk('att'), orgId: org.id, membershipId: mem.membershipId, date: key,
          checkIn, checkOut, status, workedMinutes,
          note: status === 'LATE' ? 'Traffic delay' : null,
        })
        attendanceMeta.push({ membershipId: mem.membershipId, date: key, status })
      })
    }
    dayCursor.setUTCDate(dayCursor.getUTCDate() + 1)
  }
  for (let i = 0; i < attendanceRows.length; i += 500) {
    await db.attendance.createMany({ data: attendanceRows.slice(i, i + 500) })
  }

  // attendance sessions for the last 5 weekdays (rows with both check-in & out)
  const sessionSource = attendanceRows.filter((a) => a.checkIn && a.checkOut).slice(-Math.min(attendanceRows.length, activePeople.length * 5))
  await db.attendanceSession.createMany({
    data: sessionSource.map((a) => ({
      id: mk('ats'), orgId: org.id, membershipId: a.membershipId, attendanceId: a.id,
      checkIn: a.checkIn!, checkOut: a.checkOut!, minutes: a.workedMinutes,
    })),
  })

  // ---------- leave requests ----------
  await db.leaveRequest.createMany({
    data: profile.leaveRequests.map((l) => ({
      id: mk('lea'), orgId: org.id, membershipId: ctx.p.get(l.who)!.membershipId,
      leaveTypeId: ctx.leaveType.get(l.type)!,
      startDate: dhakaDate(-past(l.startDaysAgo), 9), endDate: dhakaDate(-past(l.endDaysAgo), 18),
      days: l.days, reason: l.reason, status: l.status,
      approverMembershipId: l.approver ? ctx.p.get(l.approver)!.membershipId : null,
      decidedAt: l.status === 'APPROVED' || l.status === 'REJECTED' ? dhakaDate(-Math.max(1, past(l.startDaysAgo) - 2), 11) : null,
      createdAt: dhakaDate(-past(l.startDaysAgo) - 3),
    })),
  })

  // ---------- recruitment ----------
  for (const job of profile.jobs) {
    const jRow = {
      id: mk('job'), orgId: org.id, title: job.title, departmentId: ctx.dept.get(job.dept)!,
      description: job.description, responsibilities: job.responsibilities, requirements: job.requirements,
      skills: job.skills, experienceLevel: job.level, employmentType: job.type, workMode: job.mode,
      location: 'Dhaka, Bangladesh', salaryMin: job.min ? job.min * 100 : null, salaryMax: job.max ? job.max * 100 : null,
      currency: 'BDT', deadline: dhakaDate(job.deadlineInDays, 17), openings: job.openings,
      visibility: 'PUBLIC', status: job.status, hiringManagerMembershipId: ctx.p.get(job.manager)!.membershipId,
      createdAt: dhakaDate(-job.deadlineInDays - 10),
    }
    await db.job.create({ data: jRow })
    if (job.applications.length) {
      await db.application.createMany({
        data: job.applications.map((a, i) => ({
          id: mk('app'), jobId: jRow.id, candidateName: a.name, email: a.email,
          phone: `+88018${String(21000000 + i * 313 + profile.seq * 7).slice(0, 8)}`,
          coverLetter: `${a.name} — application for ${job.title} at ${profile.name} (synthetic demo application).`,
          skills: job.skills.split(',').slice(0, 2).join(', '), experienceYears: a.years ?? null,
          stage: a.stage, rating: a.rating ?? null, notes: a.notes ?? null,
          source: a.source ?? 'PLATFORM', processedByMembershipId: a.processor ? ctx.p.get(a.processor)!.membershipId : null,
          decidedAt: ['HIRED', 'REJECTED'].includes(a.stage) ? dhakaDate(-5, 15) : null,
          createdAt: dhakaDate(-(3 + i * 4)),
        })),
      })
    }
  }

  // ---------- payroll (previous calendar month, PAID) ----------
  const period = `${firstOfPrevMonth.getUTCFullYear()}-${pad(firstOfPrevMonth.getUTCMonth() + 1)}`
  const periodStartKey = `${firstOfPrevMonth.getUTCFullYear()}-${pad(firstOfPrevMonth.getUTCMonth() + 1)}-01`
  const periodEndKey = todayKey // attendance extends into current month; filter below
  const salaried = profile.people.filter((p) => p.salary)
  const componentRows: Array<{ id: string; orgId: string; membershipId: string; label: string; kind: string; amount: number }> = []
  for (const person of salaried) {
    componentRows.push(...salaryComponents(person, ctx.p.get(person.key)!.membershipId, org.id))
  }
  if (componentRows.length) await db.salaryComponent.createMany({ data: componentRows })
  const finPerson = profile.people.find((p) => p.role === 'FINANCE') ?? ceoPerson
  const approverPerson = profile.people.find((p) => p.role === 'ADMIN') ?? ceoPerson
  const run = await db.payrollRun.create({
    data: {
      id: mk('run'), orgId: org.id, period, status: 'PAID',
      note: 'Monthly payroll — previous cycle (demo data)',
      createdById: ctx.p.get(finPerson.key)!.membershipId,
      approvedById: ctx.p.get(approverPerson.key)!.membershipId,
      approvedAt: dhakaDate(-20, 16), paidAt: dhakaDate(-19, 11), createdAt: dhakaDate(-21, 10),
    },
  })
  const payslipRows = salaried.map((person, i) => {
    const mem = ctx.p.get(person.key)!
    const base = person.salary! * 100
    const myComponents = componentRows.filter((c) => c.membershipId === mem.membershipId)
    const allowances = myComponents.filter((c) => c.kind === 'ALLOWANCE').reduce((s, c) => s + c.amount, 0)
    const deductions = myComponents.filter((c) => c.kind === 'DEDUCTION').reduce((s, c) => s + c.amount, 0)
    const myAtt = attendanceMeta.filter((a) => a.membershipId === mem.membershipId && a.date >= periodStartKey && a.date <= periodEndKey)
    const presentDays = myAtt.filter((a) => a.status === 'PRESENT').length
    const lateDays = myAtt.filter((a) => a.status === 'LATE').length
    const absentDays = myAtt.filter((a) => a.status === 'ABSENT').length
    const unpaidDays = unpaidApproved
      .filter((l) => ctx.p.get(l.who)!.membershipId === mem.membershipId)
      .reduce((s, l) => s + l.days, 0)
    const unpaidAmount = Math.round((base / 30) * unpaidDays)
    const gross = base + allowances
    const net = gross - deductions - unpaidAmount
    const breakdown = JSON.stringify([
      { label: 'Base salary', kind: 'BASE', amount: base },
      ...myComponents.map((c) => ({ label: c.label, kind: c.kind, amount: c.amount })),
      ...(unpaidDays > 0 ? [{ label: `Unpaid leave (${unpaidDays} days)`, kind: 'DEDUCTION', amount: unpaidAmount }] : []),
    ])
    return {
      id: mk('psl'), runId: run.id, membershipId: mem.membershipId,
      baseSalary: base, allowances, deductions, unpaidLeaveDays: unpaidDays, unpaidLeaveAmount: unpaidAmount,
      gross, net, presentDays, absentDays, lateDays, breakdown,
      createdAt: dhakaDate(-21, 12),
    }
  })
  for (let i = 0; i < payslipRows.length; i += 200) {
    await db.payslip.createMany({ data: payslipRows.slice(i, i + 200) })
  }

  // ---------- meetings / announcements / documents ----------
  for (const m of profile.meetings) {
    const mtg = {
      id: mk('met'), orgId: org.id, projectId: m.projectCode ? ctx.project.get(m.projectCode)! : null,
      title: m.title, startsAt: dhakaDate(m.inDays, m.hour), durationMins: m.durationMins,
      agenda: m.agenda, notes: m.notes ?? null, createdByMembershipId: ctx.p.get(m.participants[0])!.membershipId,
    }
    await db.meeting.create({ data: mtg })
    await db.meetingParticipant.createMany({
      data: m.participants.map((who) => ({ id: mk('mtp'), meetingId: mtg.id, membershipId: ctx.p.get(who)!.membershipId })),
    })
  }
  await db.announcement.createMany({
    data: profile.announcements.map((a) => ({
      id: mk('ann'), orgId: org.id, authorMembershipId: ctx.p.get(a.who)!.membershipId,
      title: a.title, body: a.body, pinned: a.pinned, createdAt: dhakaDate(-past(a.daysAgo), 11),
    })),
  })
  const hrPerson = profile.people.find((p) => p.role === 'HR') ?? ceoPerson
  await db.document.createMany({
    data: profile.docs.map((d) => ({
      id: mk('doc'), orgId: org.id, folder: d.folder, name: d.name, mimeType: d.mime, size: d.size,
      storageKey: `r2://${profile.slug}/${d.folder}/${d.name}`,
      uploadedById: ctx.p.get(d.who ?? hrPerson.key)!.membershipId, createdAt: dhakaDate(-past(d.daysAgo), 14),
    })),
  })

  // ---------- notifications / activity log ----------
  await db.notification.createMany({
    data: profile.notifications.map((n) => ({
      id: mk('ntf'), orgId: org.id, userId: ctx.p.get(n.who)!.userId, type: n.type,
      title: n.title, body: n.body, module: n.module,
      readAt: n.read ? dhakaDate(-n.daysAgo + 0.2 > 0 ? 0 : -0.2, 9) : null,
      createdAt: dhakaDate(-Math.max(0.3, past(n.daysAgo)), 9),
    })),
  })
  await db.activityLog.createMany({
    data: profile.activities.map((a) => ({
      id: mk('act'), orgId: org.id, actorMembershipId: ctx.p.get(a.who)!.membershipId,
      action: a.action, entityType: a.entity, entityId: null, message: a.message,
      createdAt: new Date(dhakaDate(0, 18).getTime() - a.hoursAgo * 3600000),
    })),
  })

  // ---------- subscription ----------
  const planId = planIds.get(profile.planCode)!
  const seats = profile.people.length
  await db.subscription.create({
    data: {
      id: mk('sub'), orgId: org.id, planId, billingCycle: 'MONTHLY', status: 'ACTIVE',
      seats, amountMonthly: planSeats.get(profile.planCode)!.price * 100,
      startedAt: dhakaDate(-90), currentPeriodStart: dhakaDate(-10),
      currentPeriodEnd: dhakaDate(20), createdAt: dhakaDate(-90),
    },
  })
  void expenseRows; void invoiceRows; void leadRows; void dealRows; void crmRows
}

/**
 * Lift any wall-clock-defaulted createdAt/updatedAt up to the history floor.
 * Rows whose createdAt the seed does not set explicitly get Prisma's
 * @default(now()) — real time (before 2027). This bumps them to 2027-01-01
 * so the ENTIRE dataset sits on the demo timeline.
 */
async function bumpBelowFloor() {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%'")
  for (const { name } of tables) {
    const cols = await db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info('${name}')`)
    const has = (c: string) => cols.some((col) => col.name === c)
    if (!has('createdAt') && !has('updatedAt')) continue
    const sets: string[] = []
    if (has('createdAt')) sets.push(`"createdAt" = MAX("createdAt", ${FLOOR_MS})`)
    if (has('updatedAt')) sets.push(`"updatedAt" = MAX(COALESCE("updatedAt", "createdAt"), ${FLOOR_MS})`)
    await db.$executeRawUnsafe(`UPDATE "${name}" SET ${sets.join(', ')}`)
  }
}

// plan price lookup shared with subscription creation
const planSeats = new Map<string, { price: number }>()

async function main() {
  console.log('Wiping existing data…')
  await wipe()

  console.log('Creating platform accounts & plans…')
  await db.user.create({
    data: {
      id: mk('usr'), email: 'saas@orgos.dev', name: 'Farhan Chowdhury', headline: 'SaaS Platform Owner',
      bio: 'Runs the OrgOS platform — organizations, moderation and billing.',
      passwordHash, emailVerified: hourOn(-30, 12), location: 'Dhaka, Bangladesh', platformAdmin: true,
      createdAt: dhakaDate(-SPAN_DAYS),
    },
  })
  await db.user.create({
    data: {
      id: mk('usr'), email: 'suspended@orgos.dev', name: 'Sabbir Ahmed', headline: 'Spam account (suspended)',
      bio: 'Suspended by platform moderation for abusive job posts.',
      passwordHash, emailVerified: hourOn(-30, 12), location: 'Dhaka, Bangladesh', status: 'SUSPENDED',
      createdAt: dhakaDate(-SPAN_DAYS),
    },
  })
  const planDefs = [
    ['FREE', 'Free', 'For small teams getting started', 0, 0, 5, 3, 1, 0, ['Up to 5 members', '3 projects', 'Tasks & Kanban board', '1 GB document storage']],
    ['STARTER', 'Starter', 'For growing teams that need structure', 1500, 15300, 15, 10, 10, 1, ['Up to 15 members', '10 projects', 'CRM pipeline', 'HR & attendance', '10 GB document storage']],
    ['GROWTH', 'Growth', 'The complete operating system for scaling orgs', 4500, 45900, 50, 50, 50, 2, ['Up to 50 members', '50 projects', 'Recruitment & applicant tracking', 'Payroll & leave automation', 'Advanced reports', '50 GB document storage']],
    ['BUSINESS', 'Business', 'For orgs that need governance and scale', 9500, 96900, 200, 200, 200, 3, ['Up to 200 members', '200 projects', 'Audit log & access governance', 'Custom roles & module access', 'Priority support', '200 GB document storage']],
    ['ENTERPRISE', 'Enterprise', 'Dedicated infrastructure and white-glove onboarding', 25000, 255000, 1000, 1000, 1000, 4, ['Unlimited members & projects', 'SSO & SCIM ready', 'Dedicated success manager', 'Custom SLA & uptime', '1 TB document storage']],
  ] as const
  const planIds = new Map<string, string>()
  for (const [code, name, description, priceMonthly, priceYearly, seatLimit, projectLimit, storageGb, sortOrder, features] of planDefs) {
    const row = { id: mk('pln'), code, name, description, priceMonthly: priceMonthly * 100, priceYearly: priceYearly * 100, seatLimit, projectLimit, storageGb, sortOrder, features: JSON.stringify(features) }
    await db.plan.create({ data: row })
    planIds.set(code, row.id)
    planSeats.set(code, { price: priceMonthly })
  }

  const userCounter = { n: 0 }
  for (const profile of [...ORGS_A, ...ORGS_B]) {
    await seedOrg(profile, planIds, userCounter)
  }

  console.log('\nBumping wall-clock timestamps up to the 2027-01-01 floor…')
  await bumpBelowFloor()

  console.log('Seed complete. Summary:')
  const [users, orgs, memberships, projects, tasks, invoices, expenses, attendance] = await Promise.all([
    db.user.count(), db.organization.count(), db.membership.count(), db.project.count(),
    db.task.count(), db.invoice.count(), db.expense.count(), db.attendance.count(),
  ])
  console.log(`  users=${users} orgs=${orgs} memberships=${memberships} projects=${projects} tasks=${tasks} invoices=${invoices} expenses=${expenses} attendance=${attendance}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
