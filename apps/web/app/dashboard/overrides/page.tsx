import { ShieldCheck } from "lucide-react";
import { MetricCard } from "@agentforge/ui";
import { demoRecords } from "../../data";

export default function OverridesPage() {
  const overrides = demoRecords.filter((record) => record.lifecycle === "overridden");

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Overrides</h1>
          <p>
            Accountable override activity, actors, reasons, and policies most frequently overridden.
          </p>
        </div>
        <button className="button" type="button">
          <ShieldCheck size={16} aria-hidden="true" /> Review policy
        </button>
      </header>
      <section className="page">
        <div className="metrics-grid">
          <MetricCard
            label="Override count"
            value={String(overrides.length)}
            detail="Authorized overrides recorded."
          />
          <MetricCard
            label="Override rate"
            value="0%"
            detail="No overrides in the current demo window."
            tone="pass"
          />
          <MetricCard
            label="Top reason"
            value="N/A"
            detail="Reason capture is required when policy permits override."
          />
          <MetricCard
            label="Visible in PR"
            value="On"
            detail="Configured override notes are PR-visible."
            tone="neutral"
          />
        </div>
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Override trend</h2>
              <p>
                Overrides must include actor, role, reason, scope, policy version, and timestamp.
              </p>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>PR</th>
                <th>Actor</th>
                <th>Reason</th>
                <th>Policy</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={5}>No overrides recorded in the current window.</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>
    </>
  );
}
