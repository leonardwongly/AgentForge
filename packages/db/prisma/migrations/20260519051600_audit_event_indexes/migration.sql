CREATE INDEX CONCURRENTLY "AuditEvent_targetType_targetId_createdAt_idx"
  ON "AuditEvent"("targetType", "targetId", "createdAt");

CREATE INDEX CONCURRENTLY "AuditEvent_correlationId_idx"
  ON "AuditEvent"("correlationId");
