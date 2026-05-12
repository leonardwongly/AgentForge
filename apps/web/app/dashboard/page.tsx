import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download, Filter, GitPullRequestArrow } from "lucide-react";
import { MetricCard, StatusBadge } from "@agentforge/ui";
import { demoRecords } from "../data";

export default function DashboardPage() {
  const evidence = demoRecords.flatMap((record) => record.requiredEvidence);
  const completedEvidence = evidence.filter((item) => item.status !== "missing").length;
  const blocked = demoRecords.filter((record) => record.checkStatus === "block");

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Merge Guard Dashboard</h1>
          <p>Action-required pull requests, policy evidence, reviewers, and override trends.</p>
        </div>
        <div className="control-row">
          <button className="button" type="button">
            <Filter size={16} aria-hidden="true" /> Filters
          </button>
          <button className="button button--primary" type="button">
            <Download size={16} aria-hidden="true" /> Export records
          </button>
        </div>
      </header>
      <section className="page">
        <div className="metrics-grid">
          <MetricCard
            label="Blocked PRs"
            value={String(blocked.length)}
            detail="Required evidence or reviewer approvals are incomplete."
            tone="block"
          />
          <MetricCard
            label="Warnings"
            value={String(demoRecords.filter((record) => record.checkStatus === "warn").length)}
            detail="Would block in enforce mode, but current mode is warning."
            tone="warn"
          />
          <MetricCard
            label="Evidence completion"
            value={`${Math.round((completedEvidence / evidence.length) * 100)}%`}
            detail="Provided or approved evidence across governed PRs."
            tone="pass"
          />
          <MetricCard
            label="Agent signals"
            value="1"
            detail="Signals recorded. Governance still applies to high-risk human PRs."
            tone="neutral"
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Action-required pull requests</h2>
              <p>Blocked and warning PRs appear before low-risk changes.</p>
            </div>
            <Link className="button" href="/dashboard/blocked-prs">
              <GitPullRequestArrow size={16} aria-hidden="true" /> View all
            </Link>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>PR</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Missing evidence</th>
                <th>Pending reviewers</th>
              </tr>
            </thead>
            <tbody>
              {demoRecords.map((record) => (
                <tr key={record.id}>
                  <td>{record.repositoryFullName}</td>
                  <td>
                    <Link href={`/records/${record.id}`}>#{record.pullRequestNumber}</Link>
                  </td>
                  <td>{record.mode}</td>
                  <td>
                    <StatusBadge status={record.checkStatus} />
                  </td>
                  <td>
                    {record.requiredEvidence.filter((item) => item.status === "missing").length}
                  </td>
                  <td>
                    {
                      record.requiredReviewers.filter(
                        (item) => item.tier === "required" && !item.approved
                      ).length
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Policy violations</h2>
                <p>Grouped deterministic findings, not AI authorship claims.</p>
              </div>
              <AlertTriangle size={18} aria-hidden="true" />
            </div>
            <ul className="checklist">
              <li>Sensitive path changed: 1</li>
              <li>CI or deployment workflow changed: 1</li>
              <li>Agent-assistance signal recorded: 1</li>
            </ul>
          </section>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Evidence completion</h2>
                <p>Missing evidence is shown before broad summaries.</p>
              </div>
              <CheckCircle2 size={18} aria-hidden="true" />
            </div>
            <ul className="checklist">
              {evidence.map((item) => (
                <li key={item.id}>
                  {item.kind.replace(/_/g, " ")} <StatusBadge status={item.status} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </section>
    </>
  );
}
