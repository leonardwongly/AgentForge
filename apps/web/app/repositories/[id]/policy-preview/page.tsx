import Link from "next/link";
import { Play, ShieldCheck } from "lucide-react";
import { MetricCard, StatusBadge } from "@agentforge/ui";
import {
  dashboardRecords,
  hasAgentSignal,
  humanize,
  missingEvidence,
  pendingRequiredReviewers
} from "../../../data";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function PolicyPreviewPage({ params }: PageProps) {
  const { id } = await params;
  const wouldBlock = dashboardRecords.filter(
    (item) =>
      item.record.checkStatus === "block" ||
      missingEvidence(item.record).length > 0 ||
      pendingRequiredReviewers(item.record).length > 0
  );

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Policy Preview</h1>
          <p>Preview recent PRs before moving policy rules from observe to warn or enforce.</p>
        </div>
        <button className="button button--primary" type="button">
          <Play size={16} aria-hidden="true" /> Run preview
        </button>
      </header>

      <section className="page">
        <div className="metrics-grid">
          <MetricCard
            label="Would block"
            value={String(wouldBlock.length)}
            detail="PRs with required evidence or reviewer approval still open."
            tone="block"
          />
          <MetricCard
            label="Would warn"
            value={String(
              dashboardRecords.filter((item) => item.record.checkStatus === "warn").length
            )}
            detail="Non-blocking warnings in the selected policy mode."
            tone="warn"
          />
          <MetricCard
            label="Would pass"
            value={String(
              dashboardRecords.filter((item) => item.record.checkStatus === "pass").length
            )}
            detail="Configured policy requirements are satisfied."
            tone="pass"
          />
          <MetricCard
            label="Repository"
            value={id}
            detail="Preview target for the active policy version."
            tone="neutral"
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Recent PR preview</h2>
              <p>Results show what the current policy would require before merge.</p>
            </div>
            <Link className="button" href={`/repositories/${id}/policy`}>
              <ShieldCheck size={16} aria-hidden="true" /> Edit policy
            </Link>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Recent PR</th>
                <th>Preview result</th>
                <th>Triggered findings</th>
                <th>Required evidence</th>
                <th>Required reviewers</th>
                <th>Agent signal</th>
              </tr>
            </thead>
            <tbody>
              {dashboardRecords.map((item) => {
                const record = item.record;
                const blockers =
                  missingEvidence(record).length + pendingRequiredReviewers(record).length;
                const previewStatus = blockers > 0 ? "block" : record.checkStatus;
                return (
                  <tr key={record.id}>
                    <td>
                      <Link href={`/records/${record.id}`}>
                        {record.repositoryFullName} #{record.pullRequestNumber}
                      </Link>
                      <p className="muted">{item.title}</p>
                    </td>
                    <td>
                      <StatusBadge status={previewStatus} label={`would ${previewStatus}`} />
                    </td>
                    <td>
                      {record.verifiedFindings
                        .filter((finding) => finding.type !== "agent_signal_detected")
                        .map((finding) => humanize(finding.type))
                        .join(", ") || "none"}
                    </td>
                    <td>
                      {record.requiredEvidence
                        .map((evidence) => humanize(evidence.kind))
                        .join(", ") || "none"}
                    </td>
                    <td>
                      {record.requiredReviewers.map((reviewer) => reviewer.reviewer).join(", ") ||
                        "none"}
                    </td>
                    <td>{hasAgentSignal(record) ? "recorded" : "none"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <div className="three-column">
          <section className="mode-card">
            <h3>observe</h3>
            <p>Preview passes but records policy findings and missing requirements.</p>
          </section>
          <section className="mode-card">
            <h3>warn</h3>
            <p>Preview publishes non-blocking warnings for unmet policy requirements.</p>
          </section>
          <section className="mode-card">
            <h3>enforce</h3>
            <p>Preview blocks only when deterministic policy requirements are unmet.</p>
          </section>
        </div>
      </section>
    </>
  );
}
