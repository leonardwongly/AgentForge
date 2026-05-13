import { Download, GitBranch, Save, ShieldCheck } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";

export default function SettingsPage() {
  return (
    <>
      <header className="topbar">
        <div>
          <h1>Settings</h1>
          <p>
            GitHub installation, repositories, retention, LLM controls, roles, and audit exports.
          </p>
        </div>
        <button className="button button--primary" type="button">
          <Save size={16} aria-hidden="true" /> Save settings
        </button>
      </header>

      <section className="page">
        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>GitHub installation</h2>
                <p>Repository governance starts from GitHub App installation scope.</p>
              </div>
              <GitBranch size={18} aria-hidden="true" />
            </div>
            <ul className="compact-list">
              <li>
                <div className="list-row">
                  <span>Installation</span>
                  <StatusBadge status="approved" label="connected" />
                </div>
                <p>acme organization · installation 4815162342</p>
              </li>
              <li>
                <div className="list-row">
                  <span>Protected repositories</span>
                  <strong>3 enabled</strong>
                </div>
                <p>acme/payments, acme/platform, acme/identity</p>
              </li>
              <li>
                <div className="list-row">
                  <span>Default mode</span>
                  <StatusBadge status="warn" />
                </div>
                <p>Repository and rule-level modes can override this setting.</p>
              </li>
            </ul>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Data handling</h2>
                <p>Defaults store metadata, findings, evidence, reviewers, and records.</p>
              </div>
              <ShieldCheck size={18} aria-hidden="true" />
            </div>
            <div className="panel-body">
              {(
                [
                  ["Source code storage", "disabled"],
                  ["Full diff retention", "disabled"],
                  ["Secret redaction", "enabled"],
                  ["LLM advisory features", "disabled"],
                  ["Audit record retention", "365 days"]
                ] as const
              ).map(([label, value]) => (
                <div className="toggle-row" key={label}>
                  <div>
                    <strong>{label}</strong>
                    <p className="muted">{value}</p>
                  </div>
                  <div
                    className={`toggle ${value === "enabled" ? "toggle--on" : ""}`}
                    aria-hidden="true"
                  >
                    <span />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <h2>Owner mappings</h2>
            </div>
            <div className="panel-body form-grid">
              {(
                [
                  ["Security team", "security-team"],
                  ["Platform team", "platform-team"],
                  ["Billing owner", "billing-owner"],
                  ["Database owner", "database-owner"]
                ] as const
              ).map(([label, value]) => (
                <div className="field" key={label}>
                  <label htmlFor={label.toLowerCase().replace(/\s/g, "-")}>{label}</label>
                  <input
                    className="input"
                    id={label.toLowerCase().replace(/\s/g, "-")}
                    defaultValue={value}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Audit exports</h2>
                <p>
                  Exports include records, findings, evidence, reviewers, overrides, and decisions.
                </p>
              </div>
              <button className="button" type="button">
                <Download size={16} aria-hidden="true" /> Create export
              </button>
            </div>
            <ul className="compact-list">
              <li>
                <div className="list-row">
                  <span>JSON export</span>
                  <StatusBadge status="approved" label="enabled" />
                </div>
                <p>Structured Change Control Records without source code.</p>
              </li>
              <li>
                <div className="list-row">
                  <span>CSV export</span>
                  <StatusBadge status="approved" label="enabled" />
                </div>
                <p>
                  Audit-friendly rows for repository, PR, policy, findings, evidence, and decision.
                </p>
              </li>
            </ul>
          </section>
        </div>
      </section>
    </>
  );
}
