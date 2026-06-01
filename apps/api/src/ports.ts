import type {
  AuditEventRecord,
  ChangeControlRecord,
  OverrideRecord,
  PullRequestInput
} from "@agentforge/core";
import type { GithubWebhookEnvelope } from "@agentforge/github";

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

export interface WebhookDeliveryStore {
  recordReceived(envelope: GithubWebhookEnvelope): Promise<WebhookDeliveryReceipt>;
  markQueued(deliveryId: string, queueJobId: string): Promise<void>;
  markCompleted(deliveryId: string): Promise<void>;
  markEnqueueFailed(deliveryId: string, error: unknown): Promise<void>;
  markReplayed(deliveryId: string, actor: string): Promise<void>;
  findReplayable(
    target: WebhookReplayTarget,
    organizationId?: string
  ): Promise<ReplayableDelivery | undefined>;
  listRecentFailures(organizationId?: string): Promise<Array<Record<string, unknown>>>;
}

export interface ExportJobStore {
  save(job: ExportJob, actor: ExportJobActor): Promise<void>;
  get(id: string): Promise<ExportJob | undefined>;
}

export interface OverrideStore {
  save(override: OverrideRecord): Promise<void>;
}

export interface PersistencePort {
  records: ChangeControlRecordStore;
  auditEvents: AuditEventStore;
  webhookDeliveries: WebhookDeliveryStore;
  exportJobs: ExportJobStore;
  overrides: OverrideStore;
}

export type WebhookDeliveryStatus =
  | "received"
  | "queued"
  | "processing"
  | "completed"
  | "enqueue_failed"
  | "failed";

export type WebhookDeliveryReceipt = {
  duplicate: boolean;
  status: WebhookDeliveryStatus;
};

export type StoredWebhookDelivery = {
  deliveryId: string;
  event: string;
  action: string | null;
  repositoryFullName: string | null;
  organizationId?: string | null | undefined;
  repositoryId?: string | null | undefined;
  pullRequestNumber: number | null;
  headSha: string | null;
  enqueued: boolean;
  deliveryStatus?: WebhookDeliveryStatus | string | undefined;
  queueJobId?: string | null | undefined;
  queuedAt?: Date | string | null | undefined;
  processingStartedAt?: Date | string | null | undefined;
  completedAt?: Date | string | null | undefined;
  lastEnqueueFailureClass?: string | null | undefined;
  lastEnqueueFailureMessage?: string | null | undefined;
  lastEnqueueFailedAt?: Date | string | null | undefined;
  payloadJson: unknown;
  evaluationAttemptsMade?: number | undefined;
  evaluationTerminalFailure?: boolean | undefined;
  lastFailureClass?: string | null | undefined;
  lastFailureMessage?: string | null | undefined;
  lastFailureCorrelationId?: string | null | undefined;
  lastFailedAt?: Date | string | null | undefined;
  replayCount?: number | undefined;
  lastReplayedAt?: Date | string | null | undefined;
  lastReplayedBy?: string | null | undefined;
  createdAt?: Date | string | undefined;
};

export type ReplayableDelivery = {
  delivery: StoredWebhookDelivery;
  envelope: GithubWebhookEnvelope;
};

export type WebhookReplayTarget = {
  deliveryId?: string | undefined;
  repositoryFullName?: string | undefined;
  pullRequestNumber?: number | undefined;
};

export function hasCompleteWebhookReplayTarget(target: WebhookReplayTarget): boolean {
  return Boolean(
    target.deliveryId || (target.repositoryFullName && target.pullRequestNumber !== undefined)
  );
}

export type ExportJob = {
  id: string;
  organizationId: string;
  status: "completed";
  format: "json" | "csv";
  recordCount: number;
  totalMatchingRecords: number;
  truncated: boolean;
  content: string;
  createdAt: string;
};

export type ExportJobActor = {
  actor: string;
  actorRole: string;
};

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
  exports: ExportJob[];
  overrides: OverrideRecord[];
  deliveries: Set<string>;
  queuedEvaluations: Array<{
    deliveryId: string;
    envelope: GithubWebhookEnvelope;
    queuedAt: string;
  }>;
};

// The C2 test double: a single in-memory adapter behind the port so domain
// behavior can be exercised without Postgres, and so the in-memory and Prisma
// adapters can be held to one shared contract during migration.
export function createInMemoryPersistencePort(state?: InMemoryPersistenceState): PersistencePort {
  const records = new Map<string, ChangeControlRecord>();
  const auditEvents: AuditEventRecord[] = [];
  const exports = new Map<string, ExportJob>();
  const overrides = new Map<string, OverrideRecord>();
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
    },
    exportJobs: {
      async save(job, _actor) {
        if (state) {
          state.exports = [job, ...(state.exports ?? []).filter((item) => item.id !== job.id)];
        } else {
          exports.set(job.id, job);
        }
      },
      async get(id) {
        return state ? (state.exports ?? []).find((job) => job.id === id) : exports.get(id);
      }
    },
    overrides: {
      async save(override) {
        if (state) {
          state.overrides = [
            override,
            ...state.overrides.filter((item) => item.id !== override.id)
          ];
        } else {
          overrides.set(override.id, override);
        }
      }
    },
    webhookDeliveries: {
      async recordReceived(envelope) {
        if (!state) {
          return { duplicate: false, status: "received" };
        }
        const duplicate = state.deliveries.has(envelope.deliveryId);
        state.deliveries.add(envelope.deliveryId);
        return { duplicate, status: duplicate ? "queued" : "received" };
      },
      async markQueued(deliveryId) {
        state?.deliveries.add(deliveryId);
      },
      async markCompleted(deliveryId) {
        state?.deliveries.add(deliveryId);
      },
      async markEnqueueFailed(deliveryId) {
        state?.deliveries.add(deliveryId);
      },
      async markReplayed() {
        return;
      },
      async findReplayable(target, organizationId) {
        if (!state) {
          return undefined;
        }
        if (!hasCompleteWebhookReplayTarget(target)) {
          return undefined;
        }
        const candidates = [...state.queuedEvaluations].reverse();
        const queued = target.deliveryId
          ? candidates.find((item) => item.deliveryId === target.deliveryId)
          : candidates.find(
              (item) =>
                item.envelope.repository?.fullName === target.repositoryFullName &&
                item.envelope.pullRequest?.number === target.pullRequestNumber
            );
        if (!queued) {
          return undefined;
        }
        const matchingRecord = state.records.find(
          (record) => record.repositoryFullName === queued.envelope.repository?.fullName
        );
        const deliveryOrganizationId = matchingRecord?.organizationId ?? "org_local";
        if (organizationId && deliveryOrganizationId !== organizationId) {
          return undefined;
        }
        return {
          envelope: queued.envelope,
          delivery: {
            deliveryId: queued.deliveryId,
            event: queued.envelope.event,
            action: queued.envelope.action ?? null,
            organizationId: deliveryOrganizationId,
            repositoryId: matchingRecord?.repositoryId ?? null,
            repositoryFullName: queued.envelope.repository?.fullName ?? null,
            pullRequestNumber: queued.envelope.pullRequest?.number ?? null,
            headSha:
              queued.envelope.pullRequest?.headSha ?? queued.envelope.checkRun?.headSha ?? null,
            enqueued: true,
            deliveryStatus: "queued",
            payloadJson: {},
            createdAt: queued.queuedAt
          }
        };
      },
      async listRecentFailures() {
        return [];
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
