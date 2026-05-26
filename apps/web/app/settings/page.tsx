import { Download, GitBranch, Save, ShieldCheck } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { loadGithubInstallations, loadSettings, type SettingsData } from "../data";
import { createRecordExport } from "../records/actions";
import { resolveDashboardActor } from "./actor";
import {
  approveGithubInstallation,
  recordGithubInstallation,
  rejectGithubInstallation,
  saveRepositorySettings
} from "./actions";
import { OwnerMappingFields, type OwnerMappingRow } from "./owner-mapping-fields";

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
  const [{ settings, source, message }, installationsResult, currentActor] = await Promise.all([
    loadSettings(),
    loadGithubInstallations(),
    resolveDashboardActor().catch(() => undefined)
  ]);
  const installations = installationsResult.data;
  const enabledRepositories =
    settings?.repositories.filter((repository) => repository.enabled) ?? [];
  const selectedRepository = enabledRepositories[0] ?? settings?.repositories[0];
  const selectedHandling = selectedRepository?.dataHandling ?? settings?.dataHandling;
  const defaultMode = selectedRepository?.mode;
  const installation = installationDisplay(settings?.githubInstallation);
  const canRecordGithubInstallation = settings?.runtimeStore === "postgres";
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
        {params?.updated === "github-installation-recorded" ? (
          <section className="notice">
            <GitBranch size={18} aria-hidden="true" />
            <div>
              <h2>GitHub installation recorded</h2>
              <p>Review and approve the pending installation before it can govern repositories.</p>
            </div>
          </section>
        ) : null}
        {params?.updated === "github-installation-approved" ? (
          <section className="notice">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <h2>GitHub installation approved</h2>
              <p>The installation is now linked to this AgentForge organization.</p>
            </div>
          </section>
        ) : null}
        {params?.updated === "github-installation-rejected" ? (
          <section className="notice">
            <GitBranch size={18} aria-hidden="true" />
            <div>
              <h2>GitHub installation rejected</h2>
              <p>The installation remains untrusted and cannot govern repositories.</p>
            </div>
          </section>
        ) : null}
        {params?.updated === "github-login" ? (
          <section className="notice">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <h2>GitHub login connected</h2>
              <p>Dashboard requests now use the signed GitHub session for actor context.</p>
            </div>
          </section>
        ) : null}
        {params?.updated === "github-logout" ? (
          <section className="notice">
            <GitBranch size={18} aria-hidden="true" />
            <div>
              <h2>Dashboard session cleared</h2>
              <p>Sign in again or use trusted proxy headers to manage protected settings.</p>
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
                  <span>Pending approvals</span>
                  <strong>{settings?.githubInstallation.pendingApprovalCount ?? 0}</strong>
                </div>
                <p>
                  {settings?.githubInstallation.installUrl
                    ? "Use the install link below, then approve the returned installation."
                    : "Configure GITHUB_APP_SLUG to enable the in-dashboard install link."}
                </p>
                <div className="control-row">
                  {settings?.githubInstallation.installUrl ? (
                    <a className="button" href={settings.githubInstallation.installUrl}>
                      <GitBranch size={16} aria-hidden="true" /> Install GitHub App
                    </a>
                  ) : null}
                </div>
              </li>
              <li>
                <div className="list-row">
                  <span>App credentials</span>
                  <StatusBadge
                    status={
                      settings?.githubInstallation.appCredentialsConfigured ? "approved" : "low"
                    }
                    label={
                      settings?.githubInstallation.appCredentialsConfigured
                        ? "configured"
                        : "missing"
                    }
                  />
                </div>
                <p>Required for installation tokens, repository sync, and GitHub check runs.</p>
              </li>
              <li>
                <div className="list-row">
                  <span>Webhook secret</span>
                  <StatusBadge
                    status={
                      settings?.githubInstallation.webhookSecretConfigured ? "approved" : "low"
                    }
                    label={
                      settings?.githubInstallation.webhookSecretConfigured
                        ? "configured"
                        : "missing"
                    }
                  />
                </div>
                <p>
                  Required to verify GitHub webhook deliveries before they affect runtime state.
                </p>
              </li>
              <li>
                <div className="list-row">
                  <span>Install link</span>
                  <StatusBadge
                    status={settings?.githubInstallation.installUrl ? "approved" : "low"}
                    label={settings?.githubInstallation.installUrl ? "configured" : "missing slug"}
                  />
                </div>
                <p>Set GITHUB_APP_SLUG to open GitHub App installation from the dashboard.</p>
              </li>
              <li>
                <div className="list-row">
                  <span>Runtime store</span>
                  <StatusBadge
                    status={canRecordGithubInstallation ? "approved" : "low"}
                    label={settings?.runtimeStore === "postgres" ? "Postgres" : "in-memory"}
                  />
                </div>
                <p>
                  {settings?.runtimeCapabilities?.productionReady
                    ? "Postgres records and Redis-backed evaluations are configured."
                    : "Public deployments require Postgres for durable records and Redis for queued evaluations."}
                </p>
              </li>
              <li>
                <div className="list-row">
                  <span>Dashboard authentication</span>
                  <StatusBadge
                    status={
                      settings?.auth?.builtInGithubOAuthConfigured ||
                      settings?.auth?.trustedProxyConfigured
                        ? "approved"
                        : "low"
                    }
                    label={
                      settings?.auth?.builtInGithubOAuthConfigured
                        ? "GitHub OAuth"
                        : settings?.auth?.trustedProxyConfigured
                          ? "trusted proxy"
                          : "not configured"
                    }
                  />
                </div>
                <p>
                  Built-in GitHub OAuth can be used for self-hosted admins, while trusted proxy
                  headers remain available for enterprise SSO deployments.
                </p>
                <div className="control-row">
                  {settings?.auth?.builtInGithubOAuthConfigured &&
                  currentActor?.source !== "session" ? (
                    <a className="button" href="/auth/github/login">
                      <ShieldCheck size={16} aria-hidden="true" /> Sign in with GitHub
                    </a>
                  ) : (
                    <button className="button" disabled type="button">
                      <ShieldCheck size={16} aria-hidden="true" /> Sign in with GitHub
                    </button>
                  )}
                  {currentActor?.source === "session" ? (
                    <a className="button" href="/auth/logout">
                      Sign out
                    </a>
                  ) : null}
                </div>
                {currentActor?.source === "local_environment" ? (
                  <p className="muted">Using the local development actor fallback.</p>
                ) : null}
                {currentActor?.source === "trusted_headers" ? (
                  <p className="muted">Using trusted proxy identity headers.</p>
                ) : null}
                {!settings?.auth?.builtInGithubOAuthConfigured ? (
                  <p className="muted">
                    Configure GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable GitHub OAuth.
                  </p>
                ) : null}
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

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>GitHub installation approvals</h2>
              <p>Installations must be approved by an admin before they can govern repositories.</p>
            </div>
            <GitBranch size={18} aria-hidden="true" />
          </div>
          <div className="panel-body">
            {installationsResult.source !== "api" ? (
              <p className="muted">{installationsResult.message}</p>
            ) : null}
            {installations?.installations.length === 0 ? (
              <p className="muted">
                No pending or linked GitHub installations are stored yet. Install the GitHub App or
                record an installation ID manually after completing GitHub setup.
              </p>
            ) : null}
            {!canRecordGithubInstallation ? (
              <p className="muted">
                Manual installation recording is disabled for the in-memory runtime. Start Postgres,
                run migrations, and use the Postgres-backed API before approving installations.
              </p>
            ) : null}
            {installations?.installations.map((item) => (
              <div className="toggle-row" key={item.id}>
                <div>
                  <strong>{item.accountLogin}</strong>
                  <p className="muted">
                    installation {item.githubInstallationId} · {item.accountType} · {item.status}
                  </p>
                  {item.approvedBy ? <p className="muted">Approved by {item.approvedBy}</p> : null}
                </div>
                {item.status === "pending_approval" ? (
                  <div className="control-row">
                    <form action={approveGithubInstallation}>
                      <input name="returnTo" type="hidden" value="/settings" />
                      <input name="installationRecordId" type="hidden" value={item.id} />
                      <button className="button button--primary" type="submit">
                        Approve
                      </button>
                    </form>
                    <form action={rejectGithubInstallation}>
                      <input name="returnTo" type="hidden" value="/settings" />
                      <input name="installationRecordId" type="hidden" value={item.id} />
                      <button className="button" type="submit">
                        Reject
                      </button>
                    </form>
                  </div>
                ) : (
                  <StatusBadge status={item.status === "approved" ? "approved" : "low"} />
                )}
              </div>
            ))}
            <form action={recordGithubInstallation} className="form-grid">
              <input name="returnTo" type="hidden" value="/settings" />
              <div className="field">
                <label htmlFor="githubInstallationId">Manual installation ID</label>
                <input
                  className="input"
                  disabled={!canRecordGithubInstallation}
                  id="githubInstallationId"
                  name="githubInstallationId"
                  placeholder="12345678"
                />
              </div>
              <div className="field">
                <label htmlFor="accountLogin">Account login</label>
                <input
                  className="input"
                  disabled={!canRecordGithubInstallation}
                  id="accountLogin"
                  name="accountLogin"
                  placeholder="acme"
                />
              </div>
              <div className="field">
                <label htmlFor="accountType">Account type</label>
                <select
                  className="select"
                  disabled={!canRecordGithubInstallation}
                  id="accountType"
                  name="accountType"
                  defaultValue="Organization"
                >
                  <option value="Organization">Organization</option>
                  <option value="User">User</option>
                </select>
              </div>
              <button className="button" disabled={!canRecordGithubInstallation} type="submit">
                Record installation
              </button>
            </form>
          </div>
        </section>

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
              <OwnerMappingFields
                disabled={!selectedRepository}
                emptyMessage="Use the blank rows above to create owner mappings. Setup is not enforce-ready until at least one reviewer route is saved."
                rows={ownerMappingRows}
                savedCount={repositoryOwnerMappings.length}
              />
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
                <span>Export delivery</span>
                <StatusBadge status="approved" label="API job download" />
              </div>
              <p>Generated artifacts are retained as export jobs and downloaded through the API.</p>
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
  if (installation?.status === "pending_approval") {
    return {
      status: "warn",
      label: "pending approval",
      detail: "A GitHub App installation was recorded but needs platform admin approval.",
      help: "Approve the pending installation below before governed repositories are enabled."
    };
  }
  if (installation?.credentialsConfigured) {
    return {
      status: "warn",
      label: "credentials only",
      detail:
        "GitHub App authentication and webhook settings are present, but no approved installation account is linked.",
      help: "Complete the GitHub App installation flow, receive a signed webhook, or record a Postgres-backed manual installation before enabling governed repositories."
    };
  }
  return {
    status: "low",
    label: "not connected",
    detail: "No GitHub installation is connected in the runtime data."
  };
}

function ownerRows(mappings: NonNullable<SettingsData["ownerMappings"]>): OwnerMappingRow[] {
  const existingRows = mappings.map((mapping, index) => ({
    key: `${mapping.ownerKey ?? mapping.reviewer}-${index}`,
    label: `Owner key ${index + 1}`,
    ownerKey: mapping.ownerKey ?? "",
    ownerKeyPlaceholder: "billing_owner",
    reviewer: mapping.reviewer,
    reviewerType: mapping.reviewerType
  }));
  const minimumRows = Math.max(4, existingRows.length + 1);
  return [
    ...existingRows,
    ...Array.from({ length: Math.max(0, minimumRows - existingRows.length) }, (_, index) => ({
      key: `new-${index}`,
      label: `Owner key ${existingRows.length + index + 1}`,
      ownerKey: "",
      ownerKeyPlaceholder: "billing_owner",
      reviewer: "",
      reviewerType: "team"
    }))
  ];
}
