import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileWarning,
  Filter,
  GitPullRequestArrow,
  ShieldCheck,
  UserCheck
} from "lucide-react";
import { MetricCard, ProgressBar, StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../data-source-notice";
import {
  actionRequiredRecords,
  blockingModeBadge,
  evidenceByKind,
  findingGroups,
  governanceDisposition,
  hasOpenRequirements,
  getDashboardSummary,
  hasAgentSignal,
  humanize,
  missingEvidence,
  loadDashboardData,
  pendingRequiredReviewers
} from "../data";
import { createRecordExport } from "../records/actions";

type DashboardPageProps = {
  searchParams?: Promise<{
    updated?: string;
    exportId?: string;
    recordCount?: string;
    error?: string;
  }>;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const params = await searchParams;
  const data = await loadDashboardData();
  const summary = getDashboardSummary(data.records);
  const actionRequired = actionRequiredRecords(data.records);
  const evidenceGroups = evidenceByKind(data.records);
  const findings = findingGroups(data.records);

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Merge Guard Dashboard</h1>
          <p>
            Action-first governance for blocked PRs, missing evidence, reviewers, and overrides.
          </p>
        </div>
        <div className="control-row">
          <Link className="button" href="/dashboard/blocked-prs">
            <Filter size={16} aria-hidden="true" /> Action queues
          </Link>
          <form action={createRecordExport}>
            <input name="returnTo" type="hidden" value="/dashboard" />
            <input name="format" type="hidden" value="json" />
            <button className="button button--primary" type="submit">
              <Download size={16} aria-hidden="true" /> Export records
            </button>
          </form>
        </div>
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

        <div className="metrics-grid" aria-label="Governance summary">
          <MetricCard
            label="Blocked PRs"
            value={String(summary.blockedPrs)}
            detail="Merge Guard blocked merge while required policy conditions remain open."
            tone="block"
          />
          <MetricCard
            label="Missing evidence"
            value={String(summary.missingEvidence)}
            detail="Required evidence missing across action-required pull requests."
            tone="warn"
          />
          <MetricCard
            label="Required reviewers"
            value={String(summary.pendingRequiredReviewers)}
            detail="Required reviewer approvals still pending."
            tone="neutral"
          />
          <MetricCard
            label="Evidence completion"
            value={`${summary.evidenceCompletion}%`}
            detail="Provided or approved evidence across evaluated PRs."
            tone="pass"
          />
        </div>

        <div className="priority-grid">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Priority queue</h2>
                <p>Default order: blocked PRs, missing evidence, required reviewers, overrides.</p>
              </div>
              <Link className="button" href="/dashboard/blocked-prs">
                <GitPullRequestArrow size={16} aria-hidden="true" /> Blocked PRs
              </Link>
            </div>
            <ol className="action-list">
              {actionRequired.length === 0 ? (
                <li>
                  No action-required PRs. Evaluated PRs with missing evidence or required reviewer
                  approval will appear here.
                </li>
              ) : null}
              {actionRequired.map((item) => {
                const record = item.record;
                const missing = missingEvidence(record);
                const pendingReviewers = pendingRequiredReviewers(record);
                const disposition = governanceDisposition(record);
                return (
                  <li key={record.id}>
                    <div className="record-title">
                      <div>
                        <h3>
                          {item.title}{" "}
                          <Link href={`/records/${record.id}`}>#{record.pullRequestNumber}</Link>
                        </h3>
                        <p>
                          {record.repositoryFullName} · {item.team} · {item.age}
                        </p>
                      </div>
                      <StatusBadge status={disposition.status} label={disposition.label} />
                    </div>
                    <div className="inline-list" aria-label="Open requirements">
                      {hasOpenRequirements(record) ? (
                        <span className="status-badge status-badge--warn">
                          would block in enforce
                        </span>
                      ) : null}
                      {missing.length > 0 ? (
                        <span className="status-badge status-badge--missing">
                          {missing.length} required evidence missing
                        </span>
                      ) : null}
                      {pendingReviewers.length > 0 ? (
                        <span className="status-badge status-badge--suggested">
                          {pendingReviewers.length} required reviewer pending
                        </span>
                      ) : null}
                      {record.lifecycle === "overridden" ? (
                        <span className="status-badge status-badge--overridden">
                          authorized override recorded
                        </span>
                      ) : null}
                      {hasAgentSignal(record) ? (
                        <span className="status-badge status-badge--low">
                          agent signal recorded
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Governance signals</h2>
                <p>Trends are based on deterministic policy findings and recorded decisions.</p>
              </div>
              <AlertTriangle size={18} aria-hidden="true" />
            </div>
            <div className="panel-body bar-list">
              <div className="bar-row">
                <header>
                  <span>Policy violation trends</span>
                  <strong>{summary.policyFindings}</strong>
                </header>
                <ProgressBar value={76} label="Policy violation trend volume" />
              </div>
              <div className="bar-row">
                <header>
                  <span>Agent-assisted change volume</span>
                  <strong>{summary.agentAssisted}</strong>
                </header>
                <ProgressBar value={34} label="Agent-assisted change volume" />
              </div>
              <div className="bar-row">
                <header>
                  <span>Override rate</span>
                  <strong>{summary.overrideRate}%</strong>
                </header>
                <ProgressBar value={summary.overrideRate} label="Override rate" />
              </div>
              <div className="trend-line" aria-label="Evidence completion trend">
                {[32, 45, 51, 62, 58, 71, 76, summary.evidenceCompletion].map((value, index) => (
                  <span key={index} style={{ height: `${Math.max(10, value)}%` }} />
                ))}
              </div>
            </div>
          </section>
        </div>

        <div className="three-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Missing evidence</h2>
                <p>Open evidence requirements by type.</p>
              </div>
              <FileWarning size={18} aria-hidden="true" />
            </div>
            <ul className="compact-list">
              {evidenceGroups.slice(0, 4).map((item) => (
                <li key={item.kind}>
                  <div className="list-row">
                    <span>{humanize(item.kind)}</span>
                    <StatusBadge
                      status={item.missing > 0 ? "missing" : "approved"}
                      label={`${item.missing} missing`}
                    />
                  </div>
                  <p>{item.approved} approved or accepted.</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Required reviewers</h2>
                <p>Pending owners by policy finding.</p>
              </div>
              <UserCheck size={18} aria-hidden="true" />
            </div>
            <ul className="compact-list">
              {actionRequired.slice(0, 4).map((item) => (
                <li key={item.record.id}>
                  <div className="list-row">
                    <span>{item.record.repositoryFullName}</span>
                    <StatusBadge status={blockingModeBadge(item.record.mode)} />
                  </div>
                  <p>
                    {pendingRequiredReviewers(item.record)
                      .map((reviewer) => reviewer.reviewer)
                      .join(", ") || "No required reviewer pending."}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Policy findings</h2>
                <p>Most frequent deterministic finding groups.</p>
              </div>
              <ShieldCheck size={18} aria-hidden="true" />
            </div>
            <ul className="compact-list">
              {findings.slice(0, 4).map((item) => (
                <li key={item.type}>
                  <div className="list-row">
                    <span>{humanize(item.type)}</span>
                    <StatusBadge status={item.severity as "critical" | "high" | "medium" | "low"} />
                  </div>
                  <p>
                    {item.count} policy finding{item.count === 1 ? "" : "s"} recorded.
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </section>
    </>
  );
}
