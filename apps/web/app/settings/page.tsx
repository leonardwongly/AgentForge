import { Download, GitBranch, Save, ShieldCheck } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { loadSettings, type SettingsData } from "../data";
import { createRecordExport } from "../records/actions";
import { saveRepositorySettings } from "./actions";

type SettingsPageProps = {
  searchParams?: Promise<{
    updated?: string;
    exportId?: string;
    recordCount?: string;
    error?: string;
  }>;
};

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const params = await searchParams;
  const { settings, source, message } = await loadSettings();
  const enabledRepositories =
    settings?.repositories.filter((repository) => repository.enabled) ?? [];
  const selectedRepository = enabledRepositories[0] ?? settings?.repositories[0];
  const selectedHandling = selectedRepository?.dataHandling ?? settings?.dataHandling;
  const defaultMode = selectedRepository?.mode;
  const installation = installationDisplay(settings?.githubInstallation);
  const repositoryOwnerMappings =
    settings?.ownerMappings.filter((mapping) =>
      selectedRepository ? mapping.sources.includes(selectedRepository.id) : true
    ) ?? [];
  const ownerMappingRows = ownerRows(repositoryOwnerMappings);
  const routingDiagnostics = settings?.routingDiagnostics;
  const dataHandlingRows = selectedHandling
    ? [
        ["Source code storage", selectedHandling.sourceCodeStorage ? "enabled" : "disabled"],
        ["Full diff retention", selectedHandling.fullDiffRetention],
        ["Secret redaction", selectedHandling.redactSecrets ? "enabled" : "disabled"],
        ["LLM advisory features", selectedHandling.llmFeatures ? "enabled" : "disabled"],
        ["Audit record retention", `${selectedHandling.auditRecordRetentionDays} days`]
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
        <button
          className="button button--primary"
          disabled={!selectedRepository}
          form="repository-settings-form"
          type="submit"
        >
          <Save size={16} aria-hidden="true" /> Save settings
        </button>
      </header>

      <section className="page">
        {params?.updated === "repository-settings" ? (
          <section className="notice">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <h2>Repository settings saved</h2>
              <p>Runtime configuration was updated and dashboard data was reloaded.</p>
            </div>
          </section>
        ) : null}
        {params?.updated === "records-export" ? (
          <section className="notice">
            <Download size={18} aria-hidden="true" />
            <div>
              <h2>Audit export created</h2>
              <p>
                Job {params.exportId ?? "created"} contains {params.recordCount ?? "0"} Change
                Control Records.
              </p>
            </div>
          </section>
        ) : null}
        {params?.error ? (
          <section className="notice notice--unavailable">
            <GitBranch size={18} aria-hidden="true" />
            <div>
              <h2>Action failed</h2>
              <p>{params.error}</p>
            </div>
          </section>
        ) : null}

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
                  <StatusBadge status={installation.status} label={installation.label} />
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
                        .join(" · ") || "GitHub installation is verified."
                    : installation.detail}
                </p>
                {installation.help ? <p className="muted">{installation.help}</p> : null}
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
                    <StatusBadge
                      status={defaultMode as "observe" | "warn" | "enforce" | "optimize"}
                    />
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

        <form action={saveRepositorySettings} className="two-column" id="repository-settings-form">
          <input name="returnTo" type="hidden" value="/settings" />
          <input name="ownerMappingRowCount" type="hidden" value={ownerMappingRows.length} />
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Repository controls</h2>
                <p>Changes are persisted through the API and used by policy preview.</p>
              </div>
            </div>
            <div className="panel-body form-grid">
              <div className="field">
                <label htmlFor="repositoryId">Repository</label>
                <select
                  className="select"
                  disabled={!selectedRepository}
                  id="repositoryId"
                  name="repositoryId"
                  required
                  defaultValue={selectedRepository?.id ?? ""}
                >
                  {settings?.repositories.length === 0 ? (
                    <option value="">No repositories connected</option>
                  ) : null}
                  {settings?.repositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="enabled">Repository status</label>
                <select
                  className="select"
                  disabled={!selectedRepository}
                  id="enabled"
                  name="enabled"
                  defaultValue={String(selectedRepository?.enabled ?? true)}
                >
                  <option value="true">enabled</option>
                  <option value="false">disabled</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="mode">Mode</label>
                <select
                  className="select"
                  disabled={!selectedRepository}
                  id="mode"
                  name="mode"
                  defaultValue={selectedRepository?.mode ?? "observe"}
                >
                  <option value="observe">observe</option>
                  <option value="warn">warn</option>
                  <option value="enforce">enforce</option>
                  <option value="optimize">optimize</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="fullDiffRetention">Full diff retention</label>
                <select
                  className="select"
                  disabled={!selectedRepository}
                  id="fullDiffRetention"
                  name="fullDiffRetention"
                  defaultValue={selectedHandling?.fullDiffRetention ?? "disabled"}
                >
                  <option value="disabled">disabled</option>
                  <option value="7d">7d</option>
                  <option value="30d">30d</option>
                  <option value="custom">custom</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="sourceCodeStorage">Source code storage</label>
                <select
                  className="select"
                  disabled={!selectedRepository}
                  id="sourceCodeStorage"
                  name="sourceCodeStorage"
                  defaultValue={String(selectedHandling?.sourceCodeStorage ?? false)}
                >
                  <option value="false">disabled</option>
                  <option value="true">enabled</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="redactSecrets">Secret redaction</label>
                <select
                  className="select"
                  disabled={!selectedRepository}
                  id="redactSecrets"
                  name="redactSecrets"
                  defaultValue={String(selectedHandling?.redactSecrets ?? true)}
                >
                  <option value="true">enabled</option>
                  <option value="false">disabled</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="llmFeatures">LLM advisory features</label>
                <select
                  className="select"
                  disabled={!selectedRepository}
                  id="llmFeatures"
                  name="llmFeatures"
                  defaultValue={String(selectedHandling?.llmFeatures ?? false)}
                >
                  <option value="false">disabled</option>
                  <option value="true">enabled</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="auditRecordRetentionDays">Audit record retention days</label>
                <input
                  className="input"
                  disabled={!selectedRepository}
                  id="auditRecordRetentionDays"
                  max={3650}
                  min={1}
                  name="auditRecordRetentionDays"
                  type="number"
                  defaultValue={selectedHandling?.auditRecordRetentionDays ?? 365}
                />
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Owner mappings</h2>
                <p>Reviewer routing uses these owner keys for the selected repository.</p>
              </div>
            </div>
            <div className="panel-body owner-mapping-grid">
              {ownerMappingRows.map((mapping, index) => (
                <div className="owner-mapping-row" key={mapping.key}>
                  <div className="field">
                    <label htmlFor={`ownerKey_${index}`}>Owner key {index + 1}</label>
                    <input
                      className="input"
                      disabled={!selectedRepository}
                      id={`ownerKey_${index}`}
                      name={`ownerKey_${index}`}
                      placeholder="billing_owner"
                      defaultValue={mapping.ownerKey}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`reviewer_${index}`}>Reviewer {index + 1}</label>
                    <input
                      className="input"
                      disabled={!selectedRepository}
                      id={`reviewer_${index}`}
                      name={`reviewer_${index}`}
                      placeholder="billing-owner"
                      defaultValue={mapping.reviewer}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`reviewerType_${index}`}>Reviewer type {index + 1}</label>
                    <select
                      className="select"
                      disabled={!selectedRepository}
                      id={`reviewerType_${index}`}
                      name={`reviewerType_${index}`}
                      defaultValue={mapping.reviewerType}
                    >
                      <option value="team">team</option>
                      <option value="user">user</option>
                    </select>
                  </div>
                </div>
              ))}
              {repositoryOwnerMappings.length === 0 ? (
                <p className="muted">
                  Use the blank rows above to create owner mappings. Setup is not enforce-ready
                  until at least one reviewer route is saved.
                </p>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Routing diagnostics</h2>
                <p>CODEOWNERS preview, team verification, and saved reviewer formats.</p>
              </div>
              <GitBranch size={18} aria-hidden="true" />
            </div>
            <ul className="compact-list">
              <li>
                <div className="list-row">
                  <span>CODEOWNERS preview</span>
                  <StatusBadge
                    status={routingDiagnostics?.codeownersPreviewSupported ? "approved" : "low"}
                    label={
                      routingDiagnostics?.codeownersPreviewSupported ? "available" : "inactive"
                    }
                  />
                </div>
                <p>
                  Suggested mappings can be generated from CODEOWNERS patterns before enforcing
                  owner routes.
                </p>
              </li>
              <li>
                <div className="list-row">
                  <span>Members permission</span>
                  <StatusBadge
                    status={
                      !routingDiagnostics
                        ? "low"
                        : routingDiagnostics.membersReadPermission.status === "required"
                          ? "warn"
                          : "approved"
                    }
                    label={routingDiagnostics?.membersReadPermission.status ?? "not_required"}
                  />
                </div>
                <p>
                  {routingDiagnostics?.membersReadPermission.detail ?? "No diagnostics loaded."}
                </p>
              </li>
              <li>
                <div className="list-row">
                  <span>Saved routes</span>
                  <StatusBadge
                    status={repositoryOwnerMappings.length > 0 ? "approved" : "low"}
                    label={`${routingDiagnostics?.ownerMappingsConfigured ?? repositoryOwnerMappings.length} mapped`}
                  />
                </div>
                <p>
                  {routingDiagnostics
                    ? `${routingDiagnostics.teamMappings} team route(s), ${routingDiagnostics.userMappings} user route(s).`
                    : "Route counts are unavailable."}
                </p>
              </li>
            </ul>
          </section>
        </form>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Audit exports</h2>
              <p>
                Exports include records, findings, evidence, reviewers, overrides, and decisions.
              </p>
            </div>
            <form action={createRecordExport}>
              <input name="returnTo" type="hidden" value="/settings" />
              <input name="format" type="hidden" value="json" />
              <button className="button" type="submit">
                <Download size={16} aria-hidden="true" /> Create export
              </button>
            </form>
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
      </section>
    </>
  );
}

function installationDisplay(installation: SettingsData["githubInstallation"] | undefined): {
  status: "approved" | "warn" | "low";
  label: string;
  detail: string;
  help?: string | undefined;
} {
  if (installation?.connected) {
    return {
      status: "approved",
      label: "verified",
      detail: "GitHub App installation account is verified."
    };
  }
  if (installation?.credentialsConfigured) {
    return {
      status: "warn",
      label: "credentials only",
      detail: "GitHub App credentials are configured, but no installation account is verified.",
      help: "Complete the GitHub App installation flow or receive a signed webhook before enabling governed repositories."
    };
  }
  return {
    status: "low",
    label: "not connected",
    detail: "No GitHub installation is connected in the runtime data."
  };
}

function ownerRows(
  mappings: NonNullable<SettingsData["ownerMappings"]>
): Array<{ key: string; ownerKey: string; reviewer: string; reviewerType: string }> {
  const existingRows = mappings.map((mapping, index) => ({
    key: `${mapping.ownerKey ?? mapping.reviewer}-${index}`,
    ownerKey: mapping.ownerKey ?? "",
    reviewer: mapping.reviewer,
    reviewerType: mapping.reviewerType
  }));
  const minimumRows = Math.max(4, existingRows.length + 1);
  return [
    ...existingRows,
    ...Array.from({ length: Math.max(0, minimumRows - existingRows.length) }, (_, index) => ({
      key: `new-${index}`,
      ownerKey: "",
      reviewer: "",
      reviewerType: "team"
    }))
  ];
}
