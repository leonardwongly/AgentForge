import type { AuditEventRecord, ChangeControlRecord } from "@agentforge/core";

// Persistence port (assessment C1/C2). Request/domain logic should depend on
// this seam instead of branching on in-memory vs Prisma throughout app.ts. The
// existing in-memory and Prisma code paths are the two adapters to migrate
// behind it; the pure.ts extraction was the first strangler slice toward this.

export interface ChangeControlRecordStore {
  get(recordId: string): Promise<ChangeControlRecord | undefined>;
  save(record: ChangeControlRecord): Promise<void>;
  list(filter?: { organizationId?: string }): Promise<ChangeControlRecord[]>;
}

export interface AuditEventStore {
  append(event: AuditEventRecord): Promise<void>;
  list(filter?: { organizationId?: string }): Promise<AuditEventRecord[]>;
}

export interface PersistencePort {
  records: ChangeControlRecordStore;
  auditEvents: AuditEventStore;
}

// The C2 test double: a single in-memory adapter behind the port so domain
// behavior can be exercised without Postgres, and so the in-memory and Prisma
// adapters can be held to one shared contract during migration.
export function createInMemoryPersistencePort(): PersistencePort {
  const records = new Map<string, ChangeControlRecord>();
  const auditEvents: AuditEventRecord[] = [];
  const byOrg = <T extends { organizationId: string }>(items: T[], organizationId?: string): T[] =>
    organizationId ? items.filter((item) => item.organizationId === organizationId) : items;

  return {
    records: {
      async get(recordId) {
        return records.get(recordId);
      },
      async save(record) {
        records.set(record.id, record);
      },
      async list(filter) {
        return byOrg([...records.values()], filter?.organizationId);
      }
    },
    auditEvents: {
      async append(event) {
        auditEvents.push(event);
      },
      async list(filter) {
        return byOrg(auditEvents, filter?.organizationId);
      }
    }
  };
}
