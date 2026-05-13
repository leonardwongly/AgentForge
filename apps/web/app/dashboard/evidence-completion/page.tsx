import Link from "next/link";
import { CheckCircle2, FileWarning, Filter } from "lucide-react";
import { MetricCard, ProgressBar, StatusBadge } from "@agentforge/ui";
import {
  dashboardRecords,
  evidenceByKind,
  getDashboardSummary,
  humanize,
  missingEvidence
} from "../../data";

export default function EvidenceCompletionPage() {
  const summary = getDashboardSummary();
  const evidenceGroups = evidenceByKind();
  const evidenceItems = dashboardRecords.flatMap((item) => item.record.requiredEvidence);
  const approved = evidenceItems.filter((item) => item.status === "approved").length;
  const provided = evidenceItems.filter((item) => item.status === "provided").length;

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
        <div className="metrics-grid">
          <MetricCard
            label="Completion"
            value={`${summary.evidenceCompletion}%`}
            detail="Provided or approved evidence requirements."
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
              {evidenceGroups.map((group) => {
                const complete =
                  group.total === 0
                    ? 100
                    : Math.round(((group.total - group.missing) / group.total) * 100);
                return (
                  <div className="bar-row" key={group.kind}>
                    <header>
                      <span>{humanize(group.kind)}</span>
                      <strong>
                        {group.total - group.missing}/{group.total}
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
              {dashboardRecords
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
              </tr>
            </thead>
            <tbody>
              {dashboardRecords.flatMap((item) =>
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
