import Link from "next/link";
import { CheckCircle2, FileWarning, Filter, XCircle } from "lucide-react";
import { MetricCard, ProgressBar, StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../../data-source-notice";
import {
  evidenceByKind,
  getDashboardSummary,
  humanize,
  loadDashboardData,
  missingEvidence
} from "../../data";
import { approveEvidence, rejectEvidence } from "../../records/actions";

type EvidenceCompletionPageProps = {
  searchParams?: Promise<{
    updated?: string;
    error?: string;
  }>;
};

export default async function EvidenceCompletionPage({
  searchParams
}: EvidenceCompletionPageProps) {
  const query = await searchParams;
  const data = await loadDashboardData();
  const summary = getDashboardSummary(data.records);
  const evidenceGroups = evidenceByKind(data.records);
  const evidenceItems = data.records.flatMap((item) => item.record.requiredEvidence);
  const approved = evidenceItems.filter((item) => item.status === "approved").length;
  const provided = evidenceItems.filter((item) => item.status === "provided").length;
  const rejected = evidenceItems.filter((item) => item.status === "rejected").length;

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Evidence Completion</h1>
          <p>Required evidence missing, provided, and approved across governed pull requests.</p>
        </div>
        <button className="button" type="button">
          <Filter size={16} aria-hidden="true" /> Kind, repository, policy
        </button>
      </header>

      <section className="page">
        {query?.updated ? (
          <section className="notice">
            <CheckCircle2 size={18} aria-hidden="true" />
            <div>
              <h2>{evidenceQueueNotice(query.updated)}</h2>
              <p>Evidence queues and Change Control Record summaries have been revalidated.</p>
            </div>
          </section>
        ) : null}
        {query?.error ? (
          <section className="notice notice--unavailable">
            <XCircle size={18} aria-hidden="true" />
            <div>
              <h2>Evidence action failed</h2>
              <p>{query.error}</p>
            </div>
          </section>
        ) : null}
        <DataSourceNotice {...data} />

        <div className="metrics-grid">
          <MetricCard
            label="Completion"
            value={`${summary.evidenceCompletion}%`}
            detail="Approved evidence requirements."
            tone="pass"
          />
          <MetricCard
            label="Missing"
            value={String(summary.missingEvidence)}
            detail="Explicit required evidence missing."
            tone="block"
          />
          <MetricCard
            label="Provided"
            value={String(provided)}
            detail="Evidence found but not yet approved."
            tone="warn"
          />
          <MetricCard
            label="Approved"
            value={String(approved)}
            detail="Evidence accepted by reviewer or authorized actor."
            tone="neutral"
          />
          <MetricCard
            label="Rejected"
            value={String(rejected)}
            detail="Evidence that needs corrected submission before approval."
            tone={rejected > 0 ? "block" : "neutral"}
          />
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Evidence by requirement</h2>
                <p>Missing evidence is surfaced before broad status summaries.</p>
              </div>
              <CheckCircle2 size={18} aria-hidden="true" />
            </div>
            <div className="panel-body bar-list">
              {evidenceGroups.length === 0 ? (
                <p className="muted">No evidence requirements are stored yet.</p>
              ) : null}
              {evidenceGroups.map((group) => {
                const complete =
                  group.total === 0 ? 100 : Math.round((group.approved / group.total) * 100);
                return (
                  <div className="bar-row" key={group.kind}>
                    <header>
                      <span>{humanize(group.kind)}</span>
                      <strong>
                        {group.approved}/{group.total}
                      </strong>
                    </header>
                    <ProgressBar value={complete} label={`${humanize(group.kind)} completion`} />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Missing evidence queue</h2>
                <p>Each item is tied to a policy finding and Change Control Record.</p>
              </div>
              <FileWarning size={18} aria-hidden="true" />
            </div>
            <ul className="compact-list">
              {data.records.filter((item) => missingEvidence(item.record).length > 0).length ===
              0 ? (
                <li>No required evidence is missing in the current data set.</li>
              ) : null}
              {data.records
                .filter((item) => missingEvidence(item.record).length > 0)
                .map((item) => (
                  <li key={item.record.id}>
                    <div className="list-row">
                      <Link href={`/records/${item.record.id}`}>
                        {item.record.repositoryFullName} #{item.record.pullRequestNumber}
                      </Link>
                      <StatusBadge status={item.record.checkStatus} />
                    </div>
                    <p>
                      {missingEvidence(item.record)
                        .map((evidence) => humanize(evidence.kind))
                        .join(", ")}
                    </p>
                  </li>
                ))}
            </ul>
          </section>
        </div>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Evidence detail</h2>
              <p>Source, actor, timestamp, and approval state remain exportable in records.</p>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>PR</th>
                <th>Evidence</th>
                <th>Status</th>
                <th>Source</th>
                <th>Summary</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {evidenceItems.length === 0 ? (
                <tr>
                  <td className="empty-row" colSpan={7}>
                    No evidence requirements are stored yet.
                  </td>
                </tr>
              ) : null}
              {data.records.flatMap((item) =>
                item.record.requiredEvidence.map((evidence) => (
                  <tr key={`${item.record.id}:${evidence.id}`}>
                    <td>{item.record.repositoryFullName}</td>
                    <td>
                      <Link href={`/records/${item.record.id}`}>
                        #{item.record.pullRequestNumber}
                      </Link>
                    </td>
                    <td>{humanize(evidence.kind)}</td>
                    <td>
                      <StatusBadge status={evidence.status} />
                    </td>
                    <td>{evidence.source ? humanize(evidence.source) : "not provided"}</td>
                    <td>{evidence.contentSummary ?? "Required evidence missing."}</td>
                    <td>
                      {evidence.status === "provided" ? (
                        <div className="evidence-actions">
                          <form action={approveEvidence}>
                            <input
                              name="returnTo"
                              type="hidden"
                              value="/dashboard/evidence-completion"
                            />
                            <input name="recordId" type="hidden" value={item.record.id} />
                            <input name="evidenceId" type="hidden" value={evidence.id} />
                            <button className="button" type="submit">
                              <CheckCircle2 size={16} aria-hidden="true" /> Approve
                            </button>
                          </form>
                          <form action={rejectEvidence} className="evidence-reject-form">
                            <input
                              name="returnTo"
                              type="hidden"
                              value="/dashboard/evidence-completion"
                            />
                            <input name="recordId" type="hidden" value={item.record.id} />
                            <input name="evidenceId" type="hidden" value={evidence.id} />
                            <label htmlFor={`queue-reject-${evidence.id}`}>Reject reason</label>
                            <input
                              className="input"
                              id={`queue-reject-${evidence.id}`}
                              maxLength={1000}
                              minLength={10}
                              name="reason"
                              required
                              type="text"
                            />
                            <button className="button button--danger" type="submit">
                              <XCircle size={16} aria-hidden="true" /> Reject
                            </button>
                          </form>
                        </div>
                      ) : evidence.status === "approved" ? (
                        <StatusBadge status="approved" label="complete" />
                      ) : (
                        <Link className="button" href={`/records/${item.record.id}`}>
                          Submit evidence
                        </Link>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </section>
    </>
  );
}

function evidenceQueueNotice(updated: string): string {
  if (updated === "evidence-approved") {
    return "Evidence approved";
  }
  if (updated === "evidence-rejected") {
    return "Evidence rejected";
  }
  return "Evidence queue updated";
}
