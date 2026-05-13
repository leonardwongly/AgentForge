import Link from "next/link";
import { Download, GitBranch, ShieldCheck } from "lucide-react";
import { MetricCard, StatusBadge } from "@agentforge/ui";
import {
  formatDate,
  getRecord,
  hasAgentSignal,
  humanize,
  missingEvidence,
  pendingRequiredReviewers
} from "../../data";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function RecordDetailPage({ params }: PageProps) {
  const { id } = await params;
  const item = getRecord(id);
  const record = item.record;
  const missing = missingEvidence(record);
  const pendingReviewers = pendingRequiredReviewers(record);

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Change Control Record</h1>
          <p>
            {record.repositoryFullName} #{record.pullRequestNumber} · {record.headSha} ·{" "}
            {record.baseBranch}
          </p>
        </div>
        <div className="control-row">
          <Link className="button" href={item.githubUrl}>
            <GitBranch size={16} aria-hidden="true" /> GitHub PR
          </Link>
          <button className="button button--primary" type="button">
            <Download size={16} aria-hidden="true" /> Export
          </button>
        </div>
      </header>

      <section className="page">
        <div className="metrics-grid">
          <MetricCard
            label="Check status"
            value={record.checkStatus}
            detail="Merge Guard result for the latest deterministic evaluation."
            tone={
              record.checkStatus === "block"
                ? "block"
                : record.checkStatus === "warn"
                  ? "warn"
                  : "pass"
            }
          />
          <MetricCard
            label="Policy version"
            value={record.policyVersion}
            detail="Preserved for audit reconstruction."
            tone="neutral"
          />
          <MetricCard
            label="Missing evidence"
            value={String(missing.length)}
            detail="Explicit evidence requirements still open."
            tone={missing.length > 0 ? "block" : "pass"}
          />
          <MetricCard
            label="Required reviewers"
            value={String(pendingReviewers.length)}
            detail="Required reviewer approvals still pending."
            tone={pendingReviewers.length > 0 ? "warn" : "pass"}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>{item.title}</h2>
              <p>
                Author {item.author} · Team {item.team} · Policy pack {record.policyPackId}
              </p>
            </div>
            <div className="inline-list">
              <StatusBadge status={record.mode === "enforce" ? "enforce" : record.mode} />
              <StatusBadge
                status={record.lifecycle === "overridden" ? "overridden" : record.checkStatus}
              />
              {hasAgentSignal(record) ? (
                <StatusBadge status="low" label="agent signal recorded" />
              ) : null}
            </div>
          </div>
          <div className="summary-strip">
            <div>
              <span>Created</span>
              <strong>{formatDate(record.createdAt)}</strong>
            </div>
            <div>
              <span>Updated</span>
              <strong>{formatDate(record.updatedAt)}</strong>
            </div>
            <div>
              <span>Decision</span>
              <strong>{record.decision?.status ?? "pending"}</strong>
            </div>
            <div>
              <span>Policy pack</span>
              <strong>{record.policyPackVersion ?? "custom"}</strong>
            </div>
          </div>
        </section>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Verified findings</h2>
                <p>Facts come from deterministic GitHub metadata, paths, manifests, and diffs.</p>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Evidence</th>
                  <th>Confidence</th>
                  <th>Severity</th>
                </tr>
              </thead>
              <tbody>
                {record.verifiedFindings.map((finding) => (
                  <tr key={finding.id}>
                    <td>{humanize(finding.type)}</td>
                    <td>{finding.evidence}</td>
                    <td>{finding.confidence}</td>
                    <td>
                      <StatusBadge status={finding.severity ?? "medium"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Lifecycle timeline</h2>
                <p>Evaluation, check publication, decision, and override state.</p>
              </div>
            </div>
            <ol className="timeline">
              <li>
                <strong>Opened</strong>
                <p>{formatDate(record.createdAt)}</p>
              </li>
              <li>
                <strong>Evaluated</strong>
                <p>{formatDate(record.updatedAt)}</p>
              </li>
              {item.checkHistory.map((check) => (
                <li key={`${check.status}:${check.publishedAt}`}>
                  <strong>Check published: {check.conclusion}</strong>
                  <p>{check.message}</p>
                </li>
              ))}
              <li>
                <strong>Decision: {record.decision?.status ?? "pending"}</strong>
                <p>
                  {record.decision?.decidedAt
                    ? formatDate(record.decision.decidedAt)
                    : "No final decision recorded."}
                </p>
              </li>
            </ol>
          </section>
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <h2>Required evidence</h2>
            </div>
            <ul className="checklist">
              {record.requiredEvidence.length === 0 ? (
                <li>No required evidence for this evaluation.</li>
              ) : (
                record.requiredEvidence.map((evidence) => (
                  <li key={evidence.id}>
                    <div className="list-row">
                      <strong>{humanize(evidence.kind)}</strong>
                      <StatusBadge status={evidence.status} />
                    </div>
                    <p>{evidence.contentSummary ?? "Required evidence missing."}</p>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>Reviewer requirements</h2>
            </div>
            <ul className="checklist">
              {record.requiredReviewers.length === 0 ? (
                <li>No reviewer requirement for this evaluation.</li>
              ) : (
                record.requiredReviewers.map((reviewer) => (
                  <li key={reviewer.id}>
                    <div className="list-row">
                      <strong>{reviewer.reviewer}</strong>
                      <StatusBadge
                        status={reviewer.approved ? "approved" : reviewer.tier}
                        label={reviewer.approved ? "approved" : reviewer.tier}
                      />
                    </div>
                    <p>{reviewer.reason}</p>
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>

        {item.override ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Override details</h2>
                <p>Merge was allowed after authorized override with reason.</p>
              </div>
              <ShieldCheck size={18} aria-hidden="true" />
            </div>
            <div className="summary-strip">
              <div>
                <span>Actor</span>
                <strong>{item.override.actor}</strong>
              </div>
              <div>
                <span>Role</span>
                <strong>{item.override.actorRole}</strong>
              </div>
              <div>
                <span>Scope</span>
                <strong>{item.override.scope}</strong>
              </div>
              <div>
                <span>Visible in PR</span>
                <strong>{item.override.visibleInPr ? "yes" : "no"}</strong>
              </div>
            </div>
            <div className="panel-body">
              <p>{item.override.reason}</p>
            </div>
          </section>
        ) : null}
      </section>
    </>
  );
}
