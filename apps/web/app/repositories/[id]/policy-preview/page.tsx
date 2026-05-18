import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { MetricCard, StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../../../data-source-notice";
import {
  hasAgentSignal,
  loadDashboardData,
  missingEvidence,
  pendingRequiredReviewers,
  summarizeEvidenceRequirements,
  summarizeFindings,
  summarizeReviewerRequirements
} from "../../../data";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function PolicyPreviewPage({ params }: PageProps) {
  const { id } = await params;
  const data = await loadDashboardData();
  const wouldBlock = data.records.filter(
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
          <p>
            Preview recent PRs before moving policy rules from observe to warn, enforce, or
            optimize.
          </p>
        </div>
      </header>

      <section className="page">
        <DataSourceNotice {...data} />

        <div className="metrics-grid">
          <MetricCard
            label="Would block"
            value={String(wouldBlock.length)}
            detail="PRs that would block only in enforce or optimize mode."
            tone="block"
          />
          <MetricCard
            label="Would warn"
            value={String(data.records.filter((item) => item.record.checkStatus === "warn").length)}
            detail="Non-blocking warnings in the selected policy mode."
            tone="warn"
          />
          <MetricCard
            label="Would pass"
            value={String(data.records.filter((item) => item.record.checkStatus === "pass").length)}
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
              {data.records.length === 0 ? (
                <tr>
                  <td className="empty-row" colSpan={6}>
                    No recent PR records are available for preview. Run a policy preview or send a
                    GitHub webhook first.
                  </td>
                </tr>
              ) : null}
              {data.records.map((item) => {
                const record = item.record;
                const blockers =
                  missingEvidence(record).length + pendingRequiredReviewers(record).length;
                const previewStatus = blockers > 0 ? "block" : record.checkStatus;
                const previewLabel =
                  blockers > 0 ? "would block in enforce" : `would ${previewStatus}`;
                return (
                  <tr key={record.id}>
                    <td>
                      <Link href={`/records/${record.id}`}>
                        {record.repositoryFullName} #{record.pullRequestNumber}
                      </Link>
                      <p className="muted">{item.title}</p>
                    </td>
                    <td>
                      <StatusBadge status={previewStatus} label={previewLabel} />
                    </td>
                    <td>{summarizeFindings(record.verifiedFindings)}</td>
                    <td>{summarizeEvidenceRequirements(record.requiredEvidence)}</td>
                    <td>{summarizeReviewerRequirements(record.requiredReviewers)}</td>
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
          <section className="mode-card">
            <h3>optimize</h3>
            <p>Preview preserves enforce behavior and highlights improvement opportunities.</p>
          </section>
        </div>
      </section>
    </>
  );
}
