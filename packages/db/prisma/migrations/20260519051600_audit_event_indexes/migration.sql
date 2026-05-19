CREATE INDEX "AuditEvent_targetType_targetId_createdAt_idx"
  ON "AuditEvent"("targetType", "targetId", "createdAt");

CREATE INDEX "AuditEvent_correlationId_idx"
  ON "AuditEvent"("correlationId");
