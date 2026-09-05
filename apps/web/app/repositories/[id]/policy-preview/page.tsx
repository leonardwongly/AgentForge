import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import type { ChangeControlRecord } from "@agentforge/core";
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
import { recordHref, repositoryHref } from "../../../security/navigation";

type PageProps = {
  params: Promise<{ id: string }>;
};

type PreviewClassification = {
  status: "pass" | "warn" | "block";
  label: string;
  bucket: "wouldPass" | "wouldWarn" | "wouldBlock";
};

export default async function PolicyPreviewPage({ params }: PageProps) {
  const { id } = await params;
  const data = await loadDashboardData({ repositoryId: id });
  const previewRows = data.records.map((item) => ({
    item,
    preview: classifyPreviewRecord(item.record)
  }));
  const repositoryLabel = data.records[0]?.record.repositoryFullName ?? id;
  const previewCounts = previewRows.reduce(
    (counts, row) => {
      counts[row.preview.bucket] += 1;
      return counts;
    },
    { wouldBlock: 0, wouldWarn: 0, wouldPass: 0 }
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
            value={String(previewCounts.wouldBlock)}
            detail="PRs that would block only in enforce or optimize mode."
            tone="block"
          />
          <MetricCard
            label="Would warn"
            value={String(previewCounts.wouldWarn)}
            detail="Non-blocking warnings in the selected policy mode."
            tone="warn"
          />
          <MetricCard
            label="Would pass"
            value={String(previewCounts.wouldPass)}
            detail="Configured policy requirements are satisfied with no open evidence or reviewer requirements."
            tone="pass"
          />
          <MetricCard
            label="Repository"
            value={repositoryLabel}
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
            <Link className="button" href={repositoryHref(id, "policy")}>
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
              {previewRows.map(({ item, preview }) => {
                const record = item.record;
                return (
                  <tr key={record.id}>
                    <td>
                      <Link href={recordHref(record.id)}>
                        {record.repositoryFullName} #{record.pullRequestNumber}
                      </Link>
                      <p className="muted">{item.title}</p>
                    </td>
                    <td>
                      <StatusBadge status={preview.status} label={preview.label} />
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

function classifyPreviewRecord(record: ChangeControlRecord): PreviewClassification {
  const hasOpenRequirements =
    missingEvidence(record).length > 0 || pendingRequiredReviewers(record).length > 0;
  if (record.checkStatus === "block" || hasOpenRequirements) {
    return {
      status: "block",
      label: "would block in enforce",
      bucket: "wouldBlock"
    };
  }
  if (record.checkStatus === "warn") {
    return {
      status: "warn",
      label: "would warn",
      bucket: "wouldWarn"
    };
  }
  return {
    status: "pass",
    label: "would pass",
    bucket: "wouldPass"
  };
}
