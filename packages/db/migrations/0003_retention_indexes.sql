CREATE INDEX "dead_letters_task_idx" ON "dead_letters" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "outbox_created_idx" ON "outbox" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "scheduling_decisions_created_idx" ON "scheduling_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_finished_idx" ON "workflow_runs" USING btree ("finished_at") WHERE "workflow_runs"."finished_at" is not null;