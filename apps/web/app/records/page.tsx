import Link from "next/link";
import { Download, FileCheck } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../data-source-notice";
import { formatDate, loadDashboardData, summarizeFindings } from "../data";
import { createRecordExport } from "./actions";

const ALLOWED_STATUSES = ["pass", "warn", "block"] as const;
type RecordStatusFilter = (typeof ALLOWED_STATUSES)[number];

type RecordsPageProps = {
  searchParams?: Promise<{
    updated?: string;
    exportId?: string;
    recordCount?: string;
    error?: string;
    limit?: string;
    offset?: string;
    status?: string;
  }>;
};

export default async function RecordsPage({ searchParams }: RecordsPageProps) {
  const params = await searchParams;
  const limit = boundedNumber(params?.limit, 50, 1, 100);
  const offset = boundedNumber(params?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const status = statusFilter(params?.status);
  const data = await loadDashboardData({
    limit,
    offset,
    status,
    sort: "updated_desc"
  });
  const pageStart = data.pageInfo?.total === 0 ? 0 : (data.pageInfo?.offset ?? 0) + 1;
  const pageEnd = data.pageInfo
    ? Math.min(data.pageInfo.offset + data.records.length, data.pageInfo.total)
    : data.records.length;

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Change Control Records</h1>
          <p>Audit-ready records for evaluated pull requests, policy versions, and decisions.</p>
        </div>
        <form action={createRecordExport}>
          <input name="returnTo" type="hidden" value="/records" />
          <input name="format" type="hidden" value="json" />
          <button className="button button--primary" type="submit">
            <Download size={16} aria-hidden="true" /> Export records
          </button>
        </form>
      </header>

      <section className="page">
        {params?.updated === "records-export" ? (
          <section className="notice">
            <Download size={18} aria-hidden="true" />
            <div>
              <h2>Export created</h2>
              <p>
                Job {params.exportId ?? "created"} contains {params.recordCount ?? "0"} Change
                Control Records.
              </p>
            </div>
          </section>
        ) : null}
        {params?.error ? (
          <section className="notice notice--unavailable">
            <Download size={18} aria-hidden="true" />
            <div>
              <h2>Export was not created</h2>
              <p>{params.error}</p>
            </div>
          </section>
        ) : null}
        <DataSourceNotice {...data} />

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Record index</h2>
              <p>Open a record to inspect findings, required evidence, reviewers, and lifecycle.</p>
            </div>
            <FileCheck size={18} aria-hidden="true" />
          </div>
          <div className="control-row" aria-label="Record filters">
            <Link className="button" href="/records">
              All
            </Link>
            <Link className="button" href="/records?status=block">
              Blocked
            </Link>
            <Link className="button" href="/records?status=warn">
              Warnings
            </Link>
            <Link className="button" href="/records?status=pass">
              Passing
            </Link>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>PR</th>
                <th>Status</th>
                <th>Policy</th>
                <th>Findings</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.records.length === 0 ? (
                <tr>
                  <td className="empty-row" colSpan={6}>
                    No Change Control Records are stored yet.
                  </td>
                </tr>
              ) : null}
              {data.records.map((item) => (
                <tr key={item.record.id}>
                  <td>{item.record.repositoryFullName}</td>
                  <td>
                    <Link href={`/records/${item.record.id}`}>
                      #{item.record.pullRequestNumber}
                    </Link>
                    <p className="muted">{item.title}</p>
                  </td>
                  <td>
                    <StatusBadge status={item.record.checkStatus} />
                  </td>
                  <td>{item.record.policyVersion}</td>
                  <td>{summarizeFindings(item.record.verifiedFindings)}</td>
                  <td>{formatDate(item.record.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.pageInfo ? (
            <div className="control-row" aria-label="Record pagination">
              <span className="muted">
                Showing {pageStart}-{pageEnd} of {data.pageInfo.total}
              </span>
              {data.pageInfo.offset > 0 ? (
                <Link
                  className="button"
                  href={recordsPageHref({
                    status,
                    limit,
                    offset: Math.max(0, data.pageInfo.offset - data.pageInfo.limit)
                  })}
                >
                  Previous
                </Link>
              ) : null}
              {data.pageInfo.hasMore && data.pageInfo.nextOffset !== undefined ? (
                <Link
                  className="button"
                  href={recordsPageHref({
                    status,
                    limit,
                    offset: data.pageInfo.nextOffset
                  })}
                >
                  Next
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
      </section>
    </>
  );
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function statusFilter(value: string | undefined): RecordStatusFilter | undefined {
  return ALLOWED_STATUSES.includes(value as RecordStatusFilter)
    ? (value as RecordStatusFilter)
    : undefined;
}

function recordsPageHref(input: {
  status?: RecordStatusFilter | undefined;
  limit: number;
  offset: number;
}): string {
  const params = new URLSearchParams({
    limit: String(input.limit),
    offset: String(input.offset)
  });
  if (input.status) {
    params.set("status", input.status);
  }
  return `/records?${params.toString()}`;
}
