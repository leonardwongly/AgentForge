import Link from "next/link";
import { ShieldCheck, SlidersHorizontal } from "lucide-react";
import { MetricCard, ProgressBar, StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../../data-source-notice";
import { formatDate, getDashboardSummary, loadDashboardData } from "../../data";

export default async function OverridesPage() {
  const [allData, overrideData] = await Promise.all([
    loadDashboardData({ limit: 50 }),
    loadDashboardData({ lifecycle: "overridden", limit: 50 })
  ]);
  const summary = getDashboardSummary(allData.records);
  const overrides = overrideData.records.filter((item) => item.record.lifecycle === "overridden");
  const topReason = overrides[0]?.override?.reason ?? "No override reason recorded in this window.";
  const reviewPolicyHref = allData.records[0]
    ? `/repositories/${allData.records[0].record.repositoryId}/policy`
    : "/settings";
  const reasonCaptureRate =
    overrides.length === 0
      ? 0
      : Math.round(
          (overrides.filter((item) => Boolean(item.override?.reason)).length / overrides.length) *
            100
        );
  const prVisibleRate =
    overrides.length === 0
      ? 0
      : Math.round(
          (overrides.filter((item) => item.override?.visibleInPr).length / overrides.length) * 100
        );
  const overriddenPolicies = [
    ...overrides
      .reduce((policies, item) => {
        const existing = policies.get(item.record.policyVersion) ?? {
          policyVersion: item.record.policyVersion,
          count: 0,
          examples: [] as string[]
        };
        existing.count += 1;
        if (existing.examples.length < 2) {
          existing.examples.push(
            `${item.record.repositoryFullName} #${item.record.pullRequestNumber}`
          );
        }
        policies.set(item.record.policyVersion, existing);
        return policies;
      }, new Map<string, { policyVersion: string; count: number; examples: string[] }>())
      .values()
  ];

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Overrides</h1>
          <p>
            Authorized override activity with actors, roles, reasons, scopes, and policy versions.
          </p>
        </div>
        <Link className="button" href={reviewPolicyHref}>
          <SlidersHorizontal size={16} aria-hidden="true" /> Review policy
        </Link>
      </header>

      <section className="page">
        {allData.source === "empty" || allData.source === "unavailable" ? (
          <DataSourceNotice {...allData} />
        ) : null}
        {allData.source === "api" && overrideData.source === "unavailable" ? (
          <DataSourceNotice {...overrideData} />
        ) : null}
        {allData.source === "api" && overrideData.source === "empty" ? (
          <section className="notice notice--empty">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <h2>No authorized overrides yet</h2>
              <p>
                Change Control Records are available, but no authorized override activity is
                recorded in the current window.
              </p>
            </div>
            <div className="control-row">
              <Link className="button" href="/records">
                Review records
              </Link>
            </div>
          </section>
        ) : null}

        <div className="metrics-grid">
          <MetricCard
            label="Override count"
            value={String(overrides.length)}
            detail="Authorized overrides recorded in the current window."
            tone={overrides.length > 0 ? "warn" : "pass"}
          />
          <MetricCard
            label="Override rate"
            value={`${summary.overrideRate}%`}
            detail="Share of evaluated PRs with an authorized override recorded."
            tone="neutral"
          />
          <MetricCard
            label="PR-visible notes"
            value={String(overrides.filter((item) => item.override?.visibleInPr).length)}
            detail="Override records configured as visible in the pull request."
            tone="pass"
          />
          <MetricCard
            label="Top reason"
            value={overrides[0]?.override?.reason ? "Recorded" : "N/A"}
            detail={topReason}
            tone="warn"
          />
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Override trend</h2>
                <p>
                  Override rate should stay visible as teams move rules toward enforce and optimize
                  modes.
                </p>
              </div>
              <ShieldCheck size={18} aria-hidden="true" />
            </div>
            <div className="panel-body bar-list">
              <div className="bar-row">
                <header>
                  <span>Current window</span>
                  <strong>{summary.overrideRate}%</strong>
                </header>
                <ProgressBar value={summary.overrideRate} label="Current override rate" />
              </div>
              <div className="bar-row">
                <header>
                  <span>Reason captured</span>
                  <strong>{reasonCaptureRate}%</strong>
                </header>
                <ProgressBar value={reasonCaptureRate} label="Override reason capture" />
              </div>
              <div className="bar-row">
                <header>
                  <span>PR-visible override notes</span>
                  <strong>{prVisibleRate}%</strong>
                </header>
                <ProgressBar value={prVisibleRate} label="PR visible override notes" />
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Most frequently overridden policies</h2>
                <p>Use this to tune evidence requirements and reviewer routing.</p>
              </div>
            </div>
            <ul className="compact-list">
              {overriddenPolicies.length === 0 ? (
                <li>No policy versions have overrides in the current data set.</li>
              ) : null}
              {overriddenPolicies.map((policy) => (
                <li key={policy.policyVersion}>
                  <div className="list-row">
                    <span>{policy.policyVersion}</span>
                    <StatusBadge
                      status="overridden"
                      label={`${policy.count} override${policy.count === 1 ? "" : "s"}`}
                    />
                  </div>
                  <p>{policy.examples.join(", ")}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Override records</h2>
              <p>Every override is stored in the Change Control Record.</p>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>PR</th>
                <th>Actor</th>
                <th>Role</th>
                <th>Reason</th>
                <th>Policy</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {overrides.length === 0 ? (
                <tr>
                  <td className="empty-row" colSpan={7}>
                    No authorized overrides are recorded in the current data set.
                  </td>
                </tr>
              ) : null}
              {overrides.map((item) => (
                <tr key={item.record.id}>
                  <td>{item.record.repositoryFullName}</td>
                  <td>
                    <Link href={`/records/${item.record.id}`}>
                      #{item.record.pullRequestNumber}
                    </Link>
                  </td>
                  <td>{item.override?.actor}</td>
                  <td>{item.override?.actorRole}</td>
                  <td>{item.override?.reason}</td>
                  <td>{item.record.policyVersion}</td>
                  <td>{item.override ? formatDate(item.override.createdAt) : "Not recorded"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>
    </>
  );
}
