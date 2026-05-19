import Link from "next/link";
import { Lightbulb, ShieldCheck } from "lucide-react";
import { MetricCard, StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../../data-source-notice";
import { formatDate, humanize, loadPolicyTuningInsights } from "../../data";

export default async function PolicyInsightsPage() {
  const data = await loadPolicyTuningInsights();

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Policy Insights</h1>
          <p>Advisory, record-backed tuning opportunities for policy owners.</p>
        </div>
        <Link className="button" href="/settings">
          <ShieldCheck size={16} aria-hidden="true" /> Review policy settings
        </Link>
      </header>

      <section className="page">
        {data.source === "api" ? null : <DataSourceNotice {...data} records={[]} />}

        <div className="metrics-grid">
          <MetricCard
            label="Records analyzed"
            value={String(data.recordCount)}
            detail={`Generated ${formatDate(data.generatedAt)} from the current bounded insight window.`}
            tone="neutral"
          />
          <MetricCard
            label="Override rate"
            value={`${data.metrics.overrideRate}%`}
            detail="Authorized overrides indicate possible false positives or policy scope mismatch."
            tone={data.metrics.overrideRate >= 20 ? "warn" : "pass"}
          />
          <MetricCard
            label="Open evidence"
            value={`${data.metrics.openEvidenceRate}%`}
            detail="Open or rejected evidence can point to unclear evidence instructions."
            tone={data.metrics.openEvidenceRate >= 30 ? "warn" : "pass"}
          />
          <MetricCard
            label="Pending reviewers"
            value={`${data.metrics.pendingReviewerRate}%`}
            detail="Pending required reviewers indicate routing or ownership bottlenecks."
            tone={data.metrics.pendingReviewerRate >= 30 ? "warn" : "pass"}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Advisory recommendations</h2>
              <p>Insights cite records but cannot change checks, decisions, or policy YAML.</p>
            </div>
            <Lightbulb size={18} aria-hidden="true" />
          </div>
          <ul className="compact-list">
            {data.insights.length === 0 ? (
              <li>No policy tuning recommendations are available for this record window.</li>
            ) : null}
            {data.insights.map((insight) => (
              <li key={insight.id}>
                <div className="list-row">
                  <div>
                    <strong>{insight.title}</strong>
                    <p>{humanize(insight.category)}</p>
                  </div>
                  <StatusBadge status={insight.severity} />
                </div>
                <p>{insight.rationale}</p>
                <p>{insight.recommendation}</p>
                <div className="summary-strip">
                  <span>
                    {insight.metric.label}
                    <strong>{insight.metric.value}</strong>
                  </span>
                  <span>
                    Guardrail
                    <strong>advisory only</strong>
                  </span>
                </div>
                <p className="muted">{insight.guardrail}</p>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Record</th>
                      <th>Policy</th>
                      <th>Findings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insight.citations.map((citation) => (
                      <tr key={citation.recordId}>
                        <td>
                          <Link href={`/records/${citation.recordId}`}>
                            {citation.repositoryFullName} #{citation.pullRequestNumber}
                          </Link>
                        </td>
                        <td>{citation.policyVersion}</td>
                        <td>{citation.findingTypes.map(humanize).join(", ") || "No findings"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </li>
            ))}
          </ul>
        </section>
      </section>
    </>
  );
}
