import Link from "next/link";
import { ShieldCheck, SlidersHorizontal } from "lucide-react";
import { MetricCard, ProgressBar, StatusBadge } from "@agentforge/ui";
import { dashboardRecords, formatDate, getDashboardSummary } from "../../data";

export default function OverridesPage() {
  const summary = getDashboardSummary();
  const overrides = dashboardRecords.filter((item) => item.record.lifecycle === "overridden");
  const topReason = overrides[0]?.override?.reason ?? "No override reason recorded in this window.";

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Overrides</h1>
          <p>
            Authorized override activity with actors, roles, reasons, scopes, and policy versions.
          </p>
        </div>
        <Link className="button" href="/repositories/repo_local/policy">
          <SlidersHorizontal size={16} aria-hidden="true" /> Review policy
        </Link>
      </header>

      <section className="page">
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
            value={overrides.length > 0 ? "Emergency window" : "N/A"}
            detail={topReason}
            tone="warn"
          />
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Override trend</h2>
                <p>Override rate should stay visible as teams move rules toward enforce mode.</p>
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
                  <strong>100%</strong>
                </header>
                <ProgressBar value={100} label="Override reason capture" />
              </div>
              <div className="bar-row">
                <header>
                  <span>PR-visible override notes</span>
                  <strong>{overrides.length === 0 ? 0 : 100}%</strong>
                </header>
                <ProgressBar
                  value={overrides.length === 0 ? 0 : 100}
                  label="PR visible override notes"
                />
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
              <li>
                <div className="list-row">
                  <span>healthcare-regulated@1.1.0</span>
                  <StatusBadge status="overridden" label="1 override" />
                </div>
                <p>Auth path change required security approval before merge.</p>
              </li>
              <li>
                <div className="list-row">
                  <span>fintech@1.4.0</span>
                  <StatusBadge status="approved" label="0 overrides" />
                </div>
                <p>Billing and migration findings are still waiting on evidence or owners.</p>
              </li>
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
