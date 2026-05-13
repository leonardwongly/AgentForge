import Link from "next/link";
import { AlertTriangle, Filter, ListChecks } from "lucide-react";
import { MetricCard, ProgressBar, StatusBadge } from "@agentforge/ui";
import { dashboardRecords, findingGroups, formatDate, humanize } from "../../data";

export default function PolicyViolationsPage() {
  const groups = findingGroups();
  const deterministicFindings = dashboardRecords.flatMap((item) =>
    item.record.verifiedFindings.filter((finding) => finding.type !== "agent_signal_detected")
  );
  const agentSignals = dashboardRecords.flatMap((item) =>
    item.record.verifiedFindings.filter((finding) => finding.type === "agent_signal_detected")
  );

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Policy Violations</h1>
          <p>Grouped policy findings from deterministic PR facts and explicit policy rules.</p>
        </div>
        <button className="button" type="button">
          <Filter size={16} aria-hidden="true" /> Repository, pack, severity
        </button>
      </header>

      <section className="page">
        <div className="metrics-grid">
          <MetricCard
            label="Policy findings"
            value={String(deterministicFindings.length)}
            detail="Verified or observed findings from paths, manifests, workflows, and migrations."
            tone="block"
          />
          <MetricCard
            label="Critical or high"
            value={String(
              deterministicFindings.filter(
                (item) => item.severity === "critical" || item.severity === "high"
              ).length
            )}
            detail="Findings prioritized for evidence and reviewer routing."
            tone="warn"
          />
          <MetricCard
            label="Agent signals"
            value={String(agentSignals.length)}
            detail="Recorded as context; not used as the sole governance gate."
            tone="neutral"
          />
          <MetricCard
            label="Policy packs"
            value="4"
            detail="Fintech, Platform Engineering, Healthcare / Regulated, Open Source Maintainer."
            tone="pass"
          />
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Finding groups</h2>
                <p>Policy finding groups explain why evidence or reviewers were required.</p>
              </div>
              <ListChecks size={18} aria-hidden="true" />
            </div>
            <ul className="compact-list">
              {groups.map((group) => (
                <li key={group.type}>
                  <div className="list-row">
                    <strong>{humanize(group.type)}</strong>
                    <StatusBadge
                      status={group.severity as "critical" | "high" | "medium" | "low"}
                    />
                  </div>
                  <p>
                    {group.count} finding{group.count === 1 ? "" : "s"} recorded.
                  </p>
                  <div className="bar-row">
                    <ProgressBar
                      value={Math.min(100, group.count * 24)}
                      label={`${humanize(group.type)} trend`}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Recent finding evidence</h2>
                <p>Displayed without source blobs or full diffs.</p>
              </div>
              <AlertTriangle size={18} aria-hidden="true" />
            </div>
            <ul className="compact-list">
              {dashboardRecords.slice(0, 5).map((item) => (
                <li key={item.record.id}>
                  <div className="list-row">
                    <Link href={`/records/${item.record.id}`}>
                      {item.record.repositoryFullName} #{item.record.pullRequestNumber}
                    </Link>
                    <StatusBadge status={item.record.checkStatus} />
                  </div>
                  <p>
                    {item.record.verifiedFindings
                      .filter((finding) => finding.type !== "agent_signal_detected")
                      .map((finding) => finding.evidence)
                      .join(" · ") || "No deterministic policy violation."}
                  </p>
                  <p className="muted">Evaluated {formatDate(item.record.updatedAt)}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Policy finding detail</h2>
              <p>Only verified and observed findings are eligible to block in V1.</p>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Finding</th>
                <th>Source</th>
                <th>Confidence</th>
                <th>Severity</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {deterministicFindings.map((finding) => (
                <tr key={finding.id}>
                  <td>{humanize(finding.type)}</td>
                  <td>{humanize(finding.source)}</td>
                  <td>{finding.confidence}</td>
                  <td>
                    <StatusBadge status={finding.severity ?? "medium"} />
                  </td>
                  <td>{finding.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>
    </>
  );
}
