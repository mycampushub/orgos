-- OrgOS incremental migration: soft-delete columns (deletedAt)
-- For D1 databases already migrated with the pre-soft-delete 0001_init.sql.
-- Fresh databases can skip this file (0001_init.sql already includes deletedAt).
-- Apply with: bunx wrangler d1 execute orgos --remote --file cloudflare/migrations/0002_add_soft_delete.sql

ALTER TABLE "Membership" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Lead" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Invoice" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Expense" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "PayrollRun" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Payslip" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Document" ADD COLUMN "deletedAt" DATETIME;
