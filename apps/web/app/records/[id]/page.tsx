import Link from "next/link";
import { Download, GitBranch } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { demoRecords } from "../../data";

export default function RecordDetailPage() {
  const record = demoRecords[0]!;

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Change Control Record</h1>
          <p>
            {record.repositoryFullName} #{record.pullRequestNumber} at {record.headSha}
          </p>
        </div>
        <div className="control-row">
          <Link className="button" href="https://github.com">
            <GitBranch size={16} aria-hidden="true" /> GitHub PR
          </Link>
          <button className="button button--primary" type="button">
            <Download size={16} aria-hidden="true" /> Export
          </button>
        </div>
      </header>
      <section className="page">
        <div className="metrics-grid">
          <section className="metric-card metric-card--block">
            <span>Check status</span>
            <strong>{record.checkStatus}</strong>
            <p>Merge Guard result for the latest evaluation.</p>
          </section>
          <section className="metric-card metric-card--neutral">
            <span>Policy version</span>
            <strong>{record.policyVersion}</strong>
            <p>Preserved for audit reconstruction.</p>
          </section>
          <section className="metric-card metric-card--warn">
            <span>Lifecycle</span>
            <strong>{record.lifecycle}</strong>
            <p>Updated across evaluation, override, merge, and close events.</p>
          </section>
          <section className="metric-card metric-card--pass">
            <span>Mode</span>
            <strong>{record.mode}</strong>
            <p>Observe and warn do not block; enforce can block.</p>
          </section>
        </div>

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
                </tr>
              </thead>
              <tbody>
                {record.verifiedFindings.map((finding) => (
                  <tr key={finding.id}>
                    <td>{finding.type}</td>
                    <td>{finding.evidence}</td>
                    <td>{finding.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Lifecycle timeline</h2>
                <p>Recorded decision state and timestamps.</p>
              </div>
            </div>
            <ol className="timeline">
              <li>Opened: {record.createdAt}</li>
              <li>Evaluated: {record.updatedAt}</li>
              <li>Decision: {record.decision?.status}</li>
            </ol>
          </section>
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <h2>Required evidence</h2>
            </div>
            <ul className="checklist">
              {record.requiredEvidence.map((item) => (
                <li key={item.id}>
                  {item.kind.replace(/_/g, " ")} <StatusBadge status={item.status} />
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>Required reviewers</h2>
            </div>
            <ul className="checklist">
              {record.requiredReviewers.map((item) => (
                <li key={item.id}>
                  {item.reviewer}: {item.approved ? "approved" : "pending"}{" "}
                  <span className="muted">({item.reason})</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </section>
    </>
  );
}
