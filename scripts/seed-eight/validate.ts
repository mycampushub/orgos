/**
 * Eight-startup seed QA audit — implements the data-integrity checklist:
 * orphans, FK org-match, reconciliations, board columns, financial sanity.
 * Run: bun scripts/seed-eight/validate.ts  (exit 0 = all checks pass)
 */
import { PrismaClient } from '@prisma/client'
import { ANCHOR_KEY, demoNow, historyFloor } from './anchor'
import { CROSS_LINKS } from './orgs-b'

const db = new PrismaClient()
let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  const orgs = await db.organization.findMany({ orderBy: { createdAt: 'asc' } })
  console.log(`Auditing ${orgs.length} organizations…\n`)

  // ---------- global checks ----------
  const floor = historyFloor()
  const demoNowTs = demoNow()
  const users = await db.user.findMany({ select: { id: true, email: true, createdAt: true } })
  check('User emails globally unique', new Set(users.map((u) => u.email)).size === users.length)
  check('Exactly 1 platform admin', users.length === 111, `${users.length} users`)
  check('All user accounts on/after 2027-01-01', users.every((u) => u.createdAt >= floor), `${users.filter((u) => u.createdAt < floor).length} before floor`)
  check('Every org timeline starts on/after 2027-01-01', orgs.every((o) => o.createdAt >= floor), orgs.filter((o) => o.createdAt < floor).map((o) => o.name).join(', '))

  const owners = await db.membership.findMany({ where: { role: 'OWNER' }, include: { user: true } })
  check('Every org has exactly one OWNER', owners.length === orgs.length, `${owners.length} owners`)
  check('Distinct CEO user per org', new Set(owners.map((o) => o.userId)).size === orgs.length)

  const memberships = await db.membership.findMany({ include: { user: true, department: true, manager: true } })
  const badManager = memberships.filter((m) => (m.role === 'OWNER') !== (m.managerId === null))
  check('managerId null ⇔ OWNER role', badManager.length === 0, badManager.map((m) => m.user.name).join(', '))
  const crossOrgMgr = memberships.filter((m) => m.managerId && m.manager?.orgId !== m.orgId)
  check('Managers belong to same org', crossOrgMgr.length === 0)
  const noDept = memberships.filter((m) => !m.departmentId)
  check('Every membership has a department', noDept.length === 0)
  const dupEmailMembership = new Map<string, number>()
  for (const m of memberships) dupEmailMembership.set(m.user.email, (dupEmailMembership.get(m.user.email) ?? 0) + 1)
  check('No user holds two memberships (single-org people)', [...dupEmailMembership.values()].every((n) => n === 1))

  // board columns
  const columns = await db.boardColumn.findMany()
  for (const org of orgs) {
    const taskCols = columns.filter((c) => c.orgId === org.id && c.surface === 'TASK')
    const hiringCols = columns.filter((c) => c.orgId === org.id && c.surface === 'HIRING')
    check(`${org.name}: 5 TASK + 8 HIRING columns`, taskCols.length === 5 && hiringCols.length === 8)
    check(`${org.name}: exactly one done column per surface`, taskCols.filter((c) => c.isDone).length === 1 && hiringCols.filter((c) => c.isDone).length === 1)
  }
  const taskColKeys = new Map(orgs.map((o) => [o.id, columns.filter((c) => c.orgId === o.id && c.surface === 'TASK').map((c) => c.key)]))

  // tasks
  const tasks = await db.task.findMany({ include: { assignee: { include: { user: true } }, project: true } })
  const badStatus = tasks.filter((t) => !(taskColKeys.get(t.orgId) ?? []).includes(t.status))
  check('Task statuses ∈ org board columns', badStatus.length === 0, `${badStatus.length} bad`)
  const doneNoTs = tasks.filter((t) => t.status === 'DONE' && !t.completedAt)
  check('DONE tasks have completedAt', doneNoTs.length === 0)
  const undoneWithTs = tasks.filter((t) => t.status !== 'DONE' && t.completedAt)
  check('Non-DONE tasks have no completedAt', undoneWithTs.length === 0)
  const orphanAssignee = tasks.filter((t) => t.assigneeMembershipId && t.assignee?.orgId !== t.orgId)
  check('Task assignees belong to task org', orphanAssignee.length === 0)
  const wrongProjectOrg = tasks.filter((t) => t.projectId && t.project?.orgId !== t.orgId)
  check('Tasks belong to their project org', wrongProjectOrg.length === 0)
  const overdue = tasks.filter((t) => t.status !== 'DONE' && t.dueDate && t.dueDate < demoNowTs)
  check('No overdue open tasks (nothing delayed)', overdue.length === 0, `${overdue.length} overdue: ${overdue.slice(0, 3).map((t) => t.title).join(', ')}`)
  const delayedMilestones = await db.milestone.count({ where: { status: 'DELAYED' } })
  check('No DELAYED milestones (nothing delayed)', delayedMilestones === 0, `${delayedMilestones} delayed`)

  // invoices
  const invoices = await db.invoice.findMany({ include: { client: true } })
  const projectOrg = new Map((await db.project.findMany({ select: { id: true, orgId: true } })).map((p) => [p.id, p.orgId]))
  const badMath = invoices.filter((i) => i.total !== i.subtotal + i.taxAmount - i.discount)
  check('Invoice total = subtotal + tax − discount', badMath.length === 0, `${badMath.length} bad`)
  const paidNoDate = invoices.filter((i) => i.status === 'PAID' && !i.paidAt)
  check('PAID invoices have paidAt', paidNoDate.length === 0)
  const unpaidWithDate = invoices.filter((i) => i.status !== 'PAID' && i.status !== 'CANCELLED' && i.paidAt)
  check('Unpaid invoices have no paidAt', unpaidWithDate.length === 0)
  const overdueInv = invoices.filter((i) => i.status === 'OVERDUE')
  check('No OVERDUE invoices (nothing delayed)', overdueInv.length === 0, overdueInv.map((i) => i.number).join(', '))
  const pastDueUnpaid = invoices.filter((i) => !['PAID', 'CANCELLED', 'DRAFT'].includes(i.status) && i.dueDate < demoNowTs)
  check('No unpaid invoice past due (nothing delayed)', pastDueUnpaid.length === 0, pastDueUnpaid.map((i) => i.number).join(', '))
  const invOrgMismatch = invoices.filter((i) => i.client.orgId !== i.orgId || (i.projectId && projectOrg.get(i.projectId) !== i.orgId))
  check('Invoice client/project belong to invoice org', invOrgMismatch.length === 0)

  // expenses
  const expenses = await db.expense.findMany({ include: { membership: { include: { user: true } }, approvedBy: true } })
  const expMismatch = expenses.filter((e) => e.membership.orgId !== e.orgId || (e.approvedById && e.approvedBy?.orgId !== e.orgId) || (e.projectId && projectOrg.get(e.projectId) !== e.orgId))
  check('Expense submitter/approver/project in same org', expMismatch.length === 0)
  const badApprovals = expenses.filter((e) => ['MANAGER_APPROVED', 'FINANCE_APPROVED', 'PAID'].includes(e.status) && !e.approvedById)
  check('Approved/paid expenses have approver', badApprovals.length === 0)

  // payroll reconciliation
  const payslips = await db.payslip.findMany({ include: { membership: { include: { user: true } }, run: true } })
  const badNet = payslips.filter((p) => p.net !== p.gross - p.deductions - p.unpaidLeaveAmount)
  check('Payslip net = gross − deductions − unpaidLeave', badNet.length === 0, `${badNet.length} bad`)
  const badGross = payslips.filter((p) => p.gross !== p.baseSalary + p.allowances)
  check('Payslip gross = base + allowances', badGross.length === 0)
  const psMismatch = payslips.filter((p) => p.run.orgId !== p.membership.orgId)
  check('Payslips belong to run org', psMismatch.length === 0)
  const runs = await db.payrollRun.findMany()
  check('Each org has a PAID payroll run for the previous month', runs.length === orgs.length && runs.every((r) => r.status === 'PAID'), `${runs.length} runs`)

  // deals / leads
  const deals = await db.deal.findMany({ include: { stage: true, company: true, wonClient: true, linkedProject: true, owner: { include: { user: true } } } })
  const dealMismatch = deals.filter((d) => d.stage.orgId !== d.orgId || d.company.orgId !== d.orgId || (d.wonClient && d.wonClient.orgId !== d.orgId) || (d.linkedProject && d.linkedProject.orgId !== d.orgId))
  check('Deal stage/company/client/project in same org', dealMismatch.length === 0)
  const wonBroken = deals.filter((d) => (d.status === 'WON') !== (d.wonAt !== null))
  check('WON deals have wonAt; non-WON do not', wonBroken.length === 0)
  check('WON deals have a client', deals.filter((d) => d.status === 'WON' && !d.clientId).length === 0)
  const wonClientMismatch = deals.filter((d) => d.status === 'WON' && d.wonClient?.orgId !== d.orgId)
  check('Won clients in same org', wonClientMismatch.length === 0)

  // attendance
  const attendance = await db.attendance.findMany({ include: { membership: true } })
  const validStatus = attendance.every((a) => ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'HOLIDAY'].includes(a.status))
  check('Attendance statuses valid', validStatus)
  const badFormat = attendance.filter((a) => !/^\d{4}-\d{2}-\d{2}$/.test(a.date))
  check('Attendance date format YYYY-MM-DD', badFormat.length === 0)
  const todayCount = attendance.filter((a) => a.date === todayKey).length
  check('Today has attendance rows (dashboard todayPresent)', todayCount > 0, `${todayCount} rows`)

  // per-org summary + dashboard realism
  // cross-startup reconciliation: buyer expense (incl VAT) == seller invoice total
  const allOrgs = new Map(orgs.map((o) => [o.slug, o]))
  for (const link of CROSS_LINKS) {
    const sellerInvoice = invoices.find((i) => i.number === link.invoiceNumber && i.orgId === allOrgs.get(link.seller)!.id)
    const buyerExpense = expenses.find((e) => e.title === link.expenseTitle && e.orgId === allOrgs.get(link.buyer)!.id)
    const ok = !!sellerInvoice && !!buyerExpense && sellerInvoice.total === buyerExpense.amount
    check(`Cross-startup: ${link.seller} → ${link.buyer} reconciles (৳${link.amount.toLocaleString()})`, ok,
      `invoice=${sellerInvoice?.total} expense=${buyerExpense?.amount}`)
  }

  console.log('\nPer-organization summary:')
  for (const org of orgs) {
    const mems = memberships.filter((m) => m.orgId === org.id)
    const paidRevenue = invoices.filter((i) => i.orgId === org.id && ['PAID', 'PARTIALLY_PAID'].includes(i.status)).reduce((s, i) => s + i.total, 0)
    const outstanding = invoices.filter((i) => i.orgId === org.id && ['SENT', 'VIEWED', 'OVERDUE', 'PARTIALLY_PAID'].includes(i.status)).reduce((s, i) => s + i.total, 0)
    const overdueAmt = invoices.filter((i) => i.orgId === org.id && i.status === 'OVERDUE').reduce((s, i) => s + i.total, 0)
    const expTotal = expenses.filter((e) => e.orgId === org.id && e.status !== 'REJECTED').reduce((s, e) => s + e.amount, 0)
    const payrollNet = payslips.filter((p) => p.membership.orgId === org.id).reduce((s, p) => s + p.net, 0)
    const projCount = await db.project.count({ where: { orgId: org.id } })
    const taskCount = tasks.filter((t) => t.orgId === org.id).length
    const clientCount = await db.client.count({ where: { orgId: org.id } })
    const pendingLeaves = await db.leaveRequest.count({ where: { orgId: org.id, status: 'PENDING' } })
    const pendingExp = expenses.filter((e) => e.orgId === org.id && ['SUBMITTED', 'MANAGER_APPROVED'].includes(e.status)).length
    const openDeals = deals.filter((d) => d.orgId === org.id && d.status === 'OPEN')
    const openValue = openDeals.reduce((s, d) => s + d.value, 0)
    const todayPresent = attendance.filter((a) => a.membership.orgId === org.id && a.date === todayKey && ['PRESENT', 'LATE'].includes(a.status)).length
    console.log(`  ${org.name.padEnd(14)} CEO=${owners.find((o) => o.orgId === org.id)?.user.name.padEnd(16)} people=${String(mems.length).padStart(2)} proj=${projCount} tasks=${String(taskCount).padStart(3)} clients=${clientCount}`)
    console.log(`    revenue(৳k)=${Math.round(paidRevenue / 100000)} outstanding(৳k)=${Math.round(outstanding / 100000)} overdue(৳k)=${Math.round(overdueAmt / 100000)} expenses(৳k)=${Math.round(expTotal / 100000)} payroll-net(৳k)=${Math.round(payrollNet / 100000)}`)
    console.log(`    openDeals=${openDeals.length} pipeline(৳k)=${Math.round(openValue / 100000)} pendingLeaves=${pendingLeaves} pendingExpenses=${pendingExp} todayPresent=${todayPresent}/${mems.length}`)
    check(`${org.name}: dashboard has pending approvals`, pendingLeaves > 0 && pendingExp > 0)
    check(`${org.name}: has open pipeline`, openDeals.length > 0)
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

const todayKey = ANCHOR_KEY // demo "today" — the seed runs on a fixed future timeline

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
