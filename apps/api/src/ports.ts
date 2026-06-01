import type { AuditEventRecord, ChangeControlRecord, PullRequestInput } from "@agentforge/core";

// Persistence port (assessment C1/C2). Request/domain logic should depend on
// this seam instead of branching on in-memory vs Prisma throughout app.ts. The
// existing in-memory and Prisma code paths are the two adapters to migrate
// behind it; the pure.ts extraction was the first strangler slice toward this.

export interface ChangeControlRecordStore {
  get(recordId: string): Promise<ChangeControlRecord | undefined>;
  save(record: ChangeControlRecord, pr?: PullRequestInput): Promise<ChangeControlRecord>;
  list(filter?: { organizationId?: string }): Promise<ChangeControlRecord[]>;
  page(query: RecordPageQuery): Promise<RecordPage>;
}

export interface AuditEventStore {
  append(event: AuditEventRecord): Promise<void>;
  list(filter?: { organizationId?: string }): Promise<AuditEventRecord[]>;
  listForRecordExport(records: ChangeControlRecord[]): Promise<AuditEventRecord[]>;
}

export interface PersistencePort {
  records: ChangeControlRecordStore;
  auditEvents: AuditEventStore;
}

export type RecordPageQuery = {
  limit: number;
  offset: number;
  organizationId?: string | undefined;
  repositoryId?: string | undefined;
  status?: ChangeControlRecord["checkStatus"] | undefined;
  lifecycle?: ChangeControlRecord["lifecycle"] | undefined;
  mode?: ChangeControlRecord["mode"] | undefined;
  policyVersion?: string | undefined;
  queue?: "action_required" | undefined;
  sort: "updated_desc" | "updated_asc" | "created_desc" | "created_asc" | "pr_asc" | "pr_desc";
};

export type PageInfo = {
  limit: number;
  offset: number;
  total: number;
  nextOffset?: number | undefined;
  hasMore: boolean;
};

export type RecordPage = {
  records: ChangeControlRecord[];
  pageInfo: PageInfo;
};

type InMemoryPersistenceState = {
  records: ChangeControlRecord[];
  auditEvents: AuditEventRecord[];
};

// The C2 test double: a single in-memory adapter behind the port so domain
// behavior can be exercised without Postgres, and so the in-memory and Prisma
// adapters can be held to one shared contract during migration.
export function createInMemoryPersistencePort(state?: InMemoryPersistenceState): PersistencePort {
  const records = new Map<string, ChangeControlRecord>();
  const auditEvents: AuditEventRecord[] = [];
  const listRecords = () => state?.records ?? [...records.values()];
  const listAuditEvents = () => state?.auditEvents ?? auditEvents;
  const byOrg = <T extends { organizationId: string }>(items: T[], organizationId?: string): T[] =>
    organizationId ? items.filter((item) => item.organizationId === organizationId) : items;

  return {
    records: {
      async get(recordId) {
        return state
          ? state.records.find((record) => record.id === recordId)
          : records.get(recordId);
      },
      async save(record) {
        if (state) {
          state.records = [record, ...state.records.filter((item) => item.id !== record.id)];
        } else {
          records.set(record.id, record);
        }
        return record;
      },
      async list(filter) {
        return byOrg(listRecords(), filter?.organizationId);
      },
      async page(query) {
        return paginateRecords(filterAndSortRecords(listRecords(), query), query);
      }
    },
    auditEvents: {
      async append(event) {
        if (state) {
          state.auditEvents.push(event);
        } else {
          auditEvents.push(event);
        }
      },
      async list(filter) {
        return byOrg(listAuditEvents(), filter?.organizationId);
      },
      async listForRecordExport(records) {
        return auditEventsForRecordExport(listAuditEvents(), records);
      }
    }
  };
}

export function auditEventsForRecordExport(
  auditEvents: AuditEventRecord[],
  records: ChangeControlRecord[]
): AuditEventRecord[] {
  const repositoryIds = new Set(records.map((record) => record.repositoryId));
  const recordIds = new Set(records.map((record) => record.id));
  const organizationId = records[0]?.organizationId;
  if ((repositoryIds.size === 0 && recordIds.size === 0) || !organizationId) {
    return [];
  }
  return auditEvents.filter(
    (event) =>
      event.organizationId === organizationId &&
      ((event.targetType === "change_control_record" && recordIds.has(event.targetId)) ||
        (event.repositoryId ? repositoryIds.has(event.repositoryId) : false))
  );
}

export function filterAndSortRecords(
  records: ChangeControlRecord[],
  query: RecordPageQuery
): ChangeControlRecord[] {
  return [...records]
    .filter(
      (record) =>
        (!query.organizationId || record.organizationId === query.organizationId) &&
        (!query.repositoryId || record.repositoryId === query.repositoryId) &&
        (!query.status || record.checkStatus === query.status) &&
        (!query.lifecycle || record.lifecycle === query.lifecycle) &&
        (!query.mode || record.mode === query.mode) &&
        (!query.policyVersion || record.policyVersion === query.policyVersion) &&
        (!query.queue || recordRequiresAction(record))
    )
    .sort((a, b) => compareRecords(a, b, query.sort));
}

export function recordRequiresAction(record: ChangeControlRecord): boolean {
  return (
    record.checkStatus === "block" ||
    record.requiredEvidence.some((item) => item.status !== "approved") ||
    record.requiredReviewers.some((item) => item.tier === "required" && !item.approved)
  );
}

export function paginateRecords(
  records: ChangeControlRecord[],
  query: RecordPageQuery
): RecordPage {
  return {
    records: records.slice(query.offset, query.offset + query.limit),
    pageInfo: pageInfo(records.length, query)
  };
}

export function pageInfo(total: number, query: RecordPageQuery): PageInfo {
  const nextOffset = query.offset + query.limit;
  const hasMore = nextOffset < total;
  return {
    limit: query.limit,
    offset: query.offset,
    total,
    ...(hasMore ? { nextOffset } : {}),
    hasMore
  };
}

function compareRecords(
  a: ChangeControlRecord,
  b: ChangeControlRecord,
  sort: RecordPageQuery["sort"]
): number {
  if (sort === "created_asc") {
    return a.createdAt.localeCompare(b.createdAt);
  }
  if (sort === "created_desc") {
    return b.createdAt.localeCompare(a.createdAt);
  }
  if (sort === "updated_asc") {
    return a.updatedAt.localeCompare(b.updatedAt);
  }
  if (sort === "pr_asc") {
    return a.pullRequestNumber - b.pullRequestNumber;
  }
  if (sort === "pr_desc") {
    return b.pullRequestNumber - a.pullRequestNumber;
  }
  return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt);
}
