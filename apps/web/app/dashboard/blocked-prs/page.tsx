import Link from "next/link";
import { ExternalLink, Filter, GitBranch, UserCheck } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../../data-source-notice";
import {
  actionRequiredRecords,
  blockingModeBadge,
  hasAgentSignal,
  humanize,
  loadDashboardData,
  missingEvidence,
  pendingRequiredReviewers
} from "../../data";

export default async function BlockedPrsPage() {
  const data = await loadDashboardData();
  const actionRequired = actionRequiredRecords(data.records);

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Blocked PRs</h1>
          <p>PRs where required policy evidence or required reviewer approval is still open.</p>
        </div>
        <button className="button" type="button">
          <Filter size={16} aria-hidden="true" /> Repository, mode, severity
        </button>
      </header>

      <section className="page">
        <DataSourceNotice {...data} />

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Action-required pull requests</h2>
              <p>Blocked PRs appear first, followed by missing evidence and reviewer queues.</p>
            </div>
            <StatusBadge status="block" label={`${actionRequired.length} action required`} />
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>PR</th>
                <th>Policy finding</th>
                <th>Missing evidence</th>
                <th>Required reviewers</th>
                <th>Mode</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {actionRequired.length === 0 ? (
                <tr>
                  <td className="empty-row" colSpan={7}>
                    No blocked or action-required PRs are stored yet.
                  </td>
                </tr>
              ) : null}
              {actionRequired.map((item) => {
                const record = item.record;
                const missing = missingEvidence(record);
                const pendingReviewers = pendingRequiredReviewers(record);
                return (
                  <tr key={record.id}>
                    <td>
                      <strong>{record.repositoryFullName}</strong>
                      <p className="muted">{item.team}</p>
                    </td>
                    <td>
                      <Link href={`/records/${record.id}`}>#{record.pullRequestNumber}</Link>
                      <p className="muted">{item.title}</p>
                    </td>
                    <td>
                      {record.verifiedFindings
                        .filter((finding) => finding.type !== "agent_signal_detected")
                        .slice(0, 2)
                        .map((finding) => humanize(finding.type))
                        .join(", ") || "No blocking policy finding"}
                      {hasAgentSignal(record) ? (
                        <p className="muted">Agent signal recorded</p>
                      ) : null}
                    </td>
                    <td>
                      {missing.length > 0 ? (
                        missing.map((item) => (
                          <div key={item.id}>
                            <StatusBadge status="missing" label={humanize(item.kind)} />
                          </div>
                        ))
                      ) : (
                        <StatusBadge status="approved" label="complete" />
                      )}
                    </td>
                    <td>
                      {pendingReviewers.length > 0 ? (
                        pendingReviewers.map((reviewer) => (
                          <div key={reviewer.id} className="inline-list">
                            <UserCheck size={14} aria-hidden="true" />
                            <span>{reviewer.reviewer}</span>
                          </div>
                        ))
                      ) : (
                        <span>None pending</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={blockingModeBadge(record.mode)} />
                    </td>
                    <td>
                      <div className="control-row">
                        <Link className="button" href={`/records/${record.id}`}>
                          <ExternalLink size={15} aria-hidden="true" /> Record
                        </Link>
                        <Link className="button" href={item.githubUrl}>
                          <GitBranch size={15} aria-hidden="true" /> GitHub
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </section>
    </>
  );
}
