import { Download, GitBranch, Save, ShieldCheck } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { loadSettings } from "../data";

export default async function SettingsPage() {
  const { settings, source, message } = await loadSettings();
  const enabledRepositories =
    settings?.repositories.filter((repository) => repository.enabled) ?? [];
  const defaultMode = enabledRepositories[0]?.mode ?? settings?.repositories[0]?.mode;
  const dataHandlingRows = settings
    ? [
        ["Source code storage", settings.dataHandling.sourceCodeStorage ? "enabled" : "disabled"],
        ["Full diff retention", settings.dataHandling.fullDiffRetention],
        ["Secret redaction", settings.dataHandling.redactSecrets ? "enabled" : "disabled"],
        ["LLM advisory features", settings.dataHandling.llmFeatures ? "enabled" : "disabled"],
        ["Audit record retention", `${settings.dataHandling.auditRecordRetentionDays} days`]
      ]
    : [];

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
        {source !== "api" ? (
          <section className="notice notice--unavailable">
            <GitBranch size={18} aria-hidden="true" />
            <div>
              <h2>Settings data unavailable</h2>
              <p>{message}</p>
            </div>
          </section>
        ) : null}

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
                  <StatusBadge
                    status={settings?.githubInstallation.connected ? "approved" : "low"}
                    label={settings?.githubInstallation.connected ? "connected" : "not connected"}
                  />
                </div>
                <p>
                  {settings?.githubInstallation.connected
                    ? [
                        settings.githubInstallation.accountLogin,
                        settings.githubInstallation.accountType,
                        settings.githubInstallation.githubInstallationId
                          ? `installation ${settings.githubInstallation.githubInstallationId}`
                          : undefined
                      ]
                        .filter(Boolean)
                        .join(" · ") || "GitHub App credentials are configured."
                    : "No GitHub installation is connected in the runtime data."}
                </p>
              </li>
              <li>
                <div className="list-row">
                  <span>Protected repositories</span>
                  <strong>{enabledRepositories.length} enabled</strong>
                </div>
                <p>
                  {enabledRepositories.map((repository) => repository.fullName).join(", ") ||
                    "No repositories enabled yet."}
                </p>
              </li>
              <li>
                <div className="list-row">
                  <span>Default mode</span>
                  {defaultMode ? (
                    <StatusBadge status={defaultMode as "observe" | "warn" | "enforce"} />
                  ) : null}
                </div>
                <p>
                  {defaultMode
                    ? "Repository and rule-level modes can override this setting."
                    : "No repository mode is available yet."}
                </p>
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
              {dataHandlingRows.length === 0 ? (
                <p className="muted">Data-handling settings are not available.</p>
              ) : null}
              {dataHandlingRows.map(([label, value]) => (
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
              {settings?.ownerMappings.length === 0 ? (
                <p className="muted">
                  No owner mappings are available from evaluated PRs or repository configuration.
                </p>
              ) : null}
              {settings?.ownerMappings.map((mapping) => (
                <div className="field" key={mapping.reviewer}>
                  <label htmlFor={`mapping-${mapping.reviewer}`}>{mapping.reviewer}</label>
                  <input
                    className="input"
                    id={`mapping-${mapping.reviewer}`}
                    defaultValue={mapping.sources.join(", ")}
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
                  <StatusBadge
                    status={settings?.exports.json ? "approved" : "low"}
                    label={settings?.exports.json ? "enabled" : "disabled"}
                  />
                </div>
                <p>Structured Change Control Records without source code.</p>
              </li>
              <li>
                <div className="list-row">
                  <span>CSV export</span>
                  <StatusBadge
                    status={settings?.exports.csv ? "approved" : "low"}
                    label={settings?.exports.csv ? "enabled" : "disabled"}
                  />
                </div>
                <p>
                  Audit-friendly rows for repository, PR, policy, findings, evidence, and decision.
                </p>
              </li>
              <li>
                <div className="list-row">
                  <span>Export storage</span>
                  <StatusBadge
                    status={settings?.exports.storageBucketConfigured ? "approved" : "low"}
                    label={
                      settings?.exports.storageBucketConfigured ? "configured" : "not configured"
                    }
                  />
                </div>
                <p>
                  {settings?.exports.storageRegion
                    ? `Region: ${settings.exports.storageRegion}`
                    : "Exports are available through API jobs when no bucket is configured."}
                </p>
              </li>
            </ul>
          </section>
        </div>
      </section>
    </>
  );
}
