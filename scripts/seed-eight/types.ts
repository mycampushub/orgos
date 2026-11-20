// OrgOS eight-startup seed — shared types & conventions.
// Money: human-readable taka in the profiles; engine converts to cents (C()).
// Dates: offsets in days relative to "today" in Asia/Dhaka (negative = past).
// All identities are fictional synthetic demo data.

export const TZ = 'Asia/Dhaka'

export const C = (taka: number | null | undefined): number | null =>
  taka === null || taka === undefined ? null : Math.round(taka * 100)

// ---------- people ----------
export interface PersonDef {
  key: string // unique within org; referenced by managerKey / assigneeKey etc.
  name: string // globally unique across all 8 orgs (email derives from it)
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'HR' | 'FINANCE' | 'EMPLOYEE' | 'CONTRACTOR' | 'INTERN'
  title: string
  dept: string // must match a department name in the org profile
  manager?: string // person key
  type: 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'FREELANCE' | 'INTERN'
  salary?: number // monthly gross taka; omit → baseSalary null (no payslip)
  headline: string
  skills: string
  joinedDaysAgo: number
}

// ---------- clients ----------
export interface ClientDef {
  key: string
  name: string
  industry: string
  address: string
  website: string
  status: 'PROSPECT' | 'ACTIVE' | 'INACTIVE' | 'CHURNED'
  contactEmail: string
  healthNote?: string
  sinceDaysAgo: number
  contacts: Array<{ name: string; position: string; email: string; phone: string }>
}

// ---------- projects ----------
export interface TaskSeed {
  title: string
  who: string // person key
  status: 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE'
  pri: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
  start: number // daysAgo
  due: number // daysAgo (past) or negative for future
  est?: number // estimated hours
  act?: number // actual hours
  tags?: string
  sub?: string[] // subtask titles (assignee = same person)
  comment?: { who: string; body: string; daysAgo: number }
}

export interface ProjectDef {
  code: string // e.g. EVN-P01
  name: string
  clientKey?: string
  managerKey: string
  status: 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED'
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
  budget: number // taka
  startDaysAgo: number
  endDaysAgo?: number // past endDate (completed/on-hold)
  endInDays?: number // future endDate (active/planning)
  progress: number
  color: string
  description: string
  milestones: Array<{ title: string; status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'DELAYED'; dueDaysAgo: number; completedDaysAgo?: number }>
  tasks: TaskSeed[]
  staff?: Array<{ who: string; role: string }> // project members besides the manager
}

// ---------- CRM ----------
export interface LeadDef {
  name: string
  company: string
  email: string
  phone: string
  source: 'WEBSITE' | 'REFERRAL' | 'SOCIAL' | 'AD' | 'OUTREACH' | 'EVENT' | 'IMPORT' | 'MANUAL'
  status: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'UNQUALIFIED' | 'CONVERTED'
  value: number // taka
  owner: string
  notes: string
  convertedCompanyKey?: string // Company key → convertedCompanyId
}

export interface DealDef {
  name: string
  companyKey: string
  stage: 'New' | 'Qualified' | 'Meeting' | 'Proposal' | 'Negotiation'
  value: number
  status: 'OPEN' | 'WON' | 'LOST'
  owner: string
  prob: number
  closeInDays?: number // expected close (future for OPEN)
  wonDaysAgo?: number // for WON
  notes?: string
  clientKey?: string // WON → wonClient
  projectCode?: string // WON → linked project
}

// ---------- finance ----------
export interface InvoiceDef {
  number: string // e.g. EVN-INV-2027-001
  clientKey: string
  status: 'DRAFT' | 'SENT' | 'VIEWED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED'
  subtotal: number // taka
  taxRate?: number // default 5
  issueDaysAgo: number
  dueDaysAgo: number // negative → due in future
  paidDaysAgo?: number // PAID only
  projectCode?: string
  items: Array<[string, number, number]> // [description, qty, rate-taka]
}

export interface ExpenseDef {
  title: string
  category: 'GENERAL' | 'TRAVEL' | 'MEALS' | 'SOFTWARE' | 'EQUIPMENT' | 'MARKETING' | 'OFFICE' | 'TRAINING'
  who: string
  projectCode?: string
  amount: number // taka
  daysAgo: number
  status: 'SUBMITTED' | 'MANAGER_APPROVED' | 'FINANCE_APPROVED' | 'PAID' | 'REJECTED'
  approver?: string
  notes?: string
}

// ---------- internal ops ----------
export interface MeetingDef {
  title: string
  projectCode?: string
  inDays: number // negative = past
  hour: number // Dhaka local hour
  durationMins: number
  agenda: string
  notes?: string
  participants: string[] // person keys
}

export interface DocDef {
  name: string
  folder: 'Contracts' | 'Policies' | 'Finance' | 'Projects' | 'HR' | 'General'
  mime: string
  size: number
  daysAgo: number
  who?: string // uploader, default HR/ops person
}

export interface JobDef {
  title: string
  dept: string
  type: 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERN'
  mode: 'REMOTE' | 'HYBRID' | 'ONSITE'
  level: 'ENTRY' | 'MID' | 'SENIOR' | 'LEAD'
  min?: number
  max?: number
  openings: number
  deadlineInDays: number
  manager: string
  status: 'OPEN' | 'PAUSED' | 'CLOSED'
  description: string
  responsibilities: string
  requirements: string
  skills: string
  applications: Array<{
    name: string
    email: string
    phone?: string
    stage: 'APPLIED' | 'SCREENING' | 'SHORTLISTED' | 'INTERVIEW' | 'ASSESSMENT' | 'OFFER' | 'HIRED' | 'REJECTED'
    rating?: number
    years?: number
    source?: string
    processor?: string
    notes?: string
  }>
}

export interface OrgProfile {
  seq: number // 1..8 — drives id prefixes and codes
  name: string
  slug: string
  codePrefix: string // EVN — used by employee codes, invoice numbers, project codes
  description: string
  industry: string
  orgType: string
  website: string
  foundedYear: number
  planCode: 'FREE' | 'STARTER' | 'GROWTH' | 'BUSINESS' | 'ENTERPRISE'
  challenge: string // simulated operational challenge (report + announcements + healthNotes)
  departments: Array<{ name: string; color: string }>
  teams: Array<{ name: string; dept: string }>
  people: PersonDef[]
  clients: ClientDef[]
  projects: ProjectDef[]
  taskPool: string[] // org-flavored task titles with optional {client} placeholder
  leads: LeadDef[]
  deals: DealDef[]
  invoices: InvoiceDef[]
  expenses: ExpenseDef[]
  meetings: MeetingDef[]
  docs: DocDef[]
  announcements: Array<{ title: string; body: string; who: string; pinned: boolean; daysAgo: number }>
  jobs: JobDef[]
  activities: Array<{ who: string; action: string; entity: string; hoursAgo: number; message: string }>
  notifications: Array<{ who: string; type: string; title: string; body: string; module: string; daysAgo: number; read?: boolean }>
  crmActivities: Array<{ entity: 'LEAD' | 'DEAL'; ref: number; type: 'CALL' | 'EMAIL' | 'MEETING' | 'NOTE' | 'FOLLOWUP' | 'TASK'; subject: string; notes: string; done: boolean; dueIn?: number; who: string }>
  leaveRequests: Array<{ who: string; type: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; startDaysAgo: number; endDaysAgo: number; days: number; reason: string; approver?: string }>
  holidays: Array<{ name: string; type: 'GOVT' | 'COMPANY' | 'CUSTOM'; daysAgo: number; description?: string }>
}

// Cross-startup commercial links — invoice (seller org) + expense (buyer org) must reconcile.
export interface CrossLinkDef {
  seller: string // org slug
  buyer: string // org slug
  invoiceNumber: string // must exist in seller.invoices
  clientKey: string // client row in seller's books (the buyer org, by name)
  amount: number // taka — invoice subtotal == expense amount
  expenseTitle: string // expense row in buyer's books
}
