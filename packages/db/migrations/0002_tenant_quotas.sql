ALTER TABLE "tenants" ADD COLUMN "max_active_runs" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "max_workflows" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "max_versions_per_workflow" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "max_active_workers" integer DEFAULT 100 NOT NULL;