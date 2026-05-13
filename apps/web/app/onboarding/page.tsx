import { CheckCircle2, GitBranch, Play, ShieldCheck } from "lucide-react";
import { ProgressBar, StatusBadge } from "@agentforge/ui";
import {
  humanize,
  loadDashboardData,
  loadOnboardingStatus,
  loadPolicyPacks,
  loadRepositories,
  loadSettings,
  missingEvidence,
  pendingRequiredReviewers,
  type SettingsData
} from "../data";
import { saveRepositorySettings } from "../settings/actions";

type OnboardingPageProps = {
  searchParams?: Promise<{ updated?: string; error?: string }>;
};

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const params = await searchParams;
  const [repositories, policyPacks, onboarding, settings, dashboard] = await Promise.all([
    loadRepositories(),
    loadPolicyPacks(),
    loadOnboardingStatus(),
    loadSettings(),
    loadDashboardData()
  ]);
  const enabledRepositories = repositories.repositories.filter((repository) => repository.enabled);
  const organizationNames = [
    ...new Set(
      [
        settings.settings?.githubInstallation.accountLogin,
        ...repositories.repositories.map((repository) => repository.fullName.split("/")[0])
      ].filter((value): value is string => Boolean(value))
    )
  ];
  const completedSteps = onboarding.steps.filter((step) => step.status === "complete").length;
  const progress =
    onboarding.steps.length === 0
      ? 0
      : Math.round((completedSteps / onboarding.steps.length) * 100);
  const selectedMode =
    enabledRepositories[0]?.mode ?? repositories.repositories[0]?.mode ?? "observe";
  const selectedRepository = enabledRepositories[0] ?? repositories.repositories[0];
  const selectedHandling = selectedRepository?.dataHandling ?? settings.settings?.dataHandling;
  const selectedPolicyPack =
    policyPacks.policyPacks.find((pack) => pack.id === selectedRepository?.currentPolicyPack) ??
    policyPacks.policyPacks[0];
  const repositoryOwnerMappings =
    settings.settings?.ownerMappings.filter((mapping) =>
      selectedRepository ? mapping.sources.includes(selectedRepository.id) : true
    ) ?? [];
  const ownerMappingRows = ownerRows(repositoryOwnerMappings);

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Onboarding</h1>
          <p>Configure Merge Guard for governed repositories without writing YAML manually.</p>
        </div>
        <button
          className="button button--primary"
          disabled={!selectedRepository}
          form="onboarding-settings-form"
          type="submit"
        >
          <CheckCircle2 size={16} aria-hidden="true" /> Finish setup
        </button>
      </header>

      <section className="page">
        {params?.updated === "repository-settings" ? (
          <section className="notice">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <h2>Setup settings saved</h2>
              <p>
                Repository mode, policy pack, owner mappings, and retention settings were saved.
              </p>
            </div>
          </section>
        ) : null}
        {params?.error ? (
          <section className="notice notice--unavailable">
            <GitBranch size={18} aria-hidden="true" />
            <div>
              <h2>Setup was not saved</h2>
              <p>{params.error}</p>
            </div>
          </section>
        ) : null}

        {[
          repositories.source !== "api"
            ? ["GitHub setup data unavailable", repositories.message]
            : undefined,
          policyPacks.source !== "api"
            ? ["Policy pack data unavailable", policyPacks.message]
            : undefined,
          onboarding.source !== "api"
            ? ["Onboarding status unavailable", onboarding.message]
            : undefined,
          settings.source !== "api" ? ["Settings data unavailable", settings.message] : undefined
        ]
          .filter((notice): notice is [string, string] => Boolean(notice))
          .map(([title, message]) => (
            <section className="notice notice--unavailable" key={title}>
              <GitBranch size={18} aria-hidden="true" />
              <div>
                <h2>{title}</h2>
                <p>{message}</p>
              </div>
            </section>
          ))}

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Setup progress</h2>
              <p>Start in observe or warn, then move mature rules to enforce.</p>
            </div>
            <StatusBadge
              status={progress === 100 ? "approved" : progress > 0 ? "provided" : "low"}
              label={`${completedSteps} of ${onboarding.steps.length} steps`}
            />
          </div>
          <div className="panel-body">
            <ProgressBar value={progress} label="Onboarding progress" />
          </div>
        </section>

        <div className="step-grid">
          {onboarding.steps.length === 0 ? (
            <section className="step step--pending">
              <div className="list-row">
                <h2>No onboarding status loaded</h2>
                <StatusBadge status="low" label="pending" />
              </div>
              <p>Start the API and connect runtime data to continue setup.</p>
            </section>
          ) : null}
          {onboarding.steps.map((step, index) => (
            <section className={`step step--${step.status}`} key={step.id}>
              <div className="list-row">
                <h2>
                  {index + 1}. {step.title}
                </h2>
                <StatusBadge
                  status={
                    step.status === "complete"
                      ? "approved"
                      : step.status === "active"
                        ? "provided"
                        : "low"
                  }
                  label={step.status}
                />
              </div>
              <p>{step.detail}</p>
            </section>
          ))}
        </div>

        <form action={saveRepositorySettings} id="onboarding-settings-form">
          <input name="returnTo" type="hidden" value="/onboarding" />
          <input name="ownerMappingRowCount" type="hidden" value={ownerMappingRows.length} />

          <div className="two-column">
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Repository and policy setup</h2>
                  <p>Selected settings determine which PRs receive Merge Guard checks.</p>
                </div>
                <GitBranch size={18} aria-hidden="true" />
              </div>
              <div className="panel-body form-grid">
                <div className="field">
                  <label htmlFor="organization">Organization</label>
                  <select
                    className="select"
                    disabled={!selectedRepository}
                    id="organization"
                    defaultValue={organizationNames[0] ?? ""}
                  >
                    {organizationNames.length === 0 ? (
                      <option value="">Connect GitHub App to load organizations</option>
                    ) : null}
                    {organizationNames.map((organization) => (
                      <option key={organization} value={organization}>
                        {organization}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="repositoryId">Repositories</label>
                  <select
                    className="select"
                    disabled={!selectedRepository}
                    id="repositoryId"
                    name="repositoryId"
                    required
                    defaultValue={selectedRepository?.id ?? ""}
                  >
                    {repositories.repositories.length === 0 ? (
                      <option value="">No repositories connected</option>
                    ) : null}
                    {repositories.repositories.map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repository.fullName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="policyPackId">Policy pack</label>
                  <select
                    className="select"
                    disabled={!selectedRepository}
                    id="policyPackId"
                    name="policyPackId"
                    defaultValue={selectedPolicyPack?.id ?? ""}
                  >
                    {policyPacks.policyPacks.length === 0 ? (
                      <option value="">No policy packs available</option>
                    ) : null}
                    {policyPacks.policyPacks.map((pack) => (
                      <option key={pack.id} value={pack.id}>
                        {pack.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="mode">Starting mode</label>
                  <select
                    className="select"
                    disabled={!selectedRepository}
                    id="mode"
                    name="mode"
                    defaultValue={selectedMode}
                  >
                    <option value="observe">observe</option>
                    <option value="warn">warn</option>
                    <option value="enforce">enforce</option>
                  </select>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Owner mapping</h2>
                  <p>Reviewer routing uses owner mappings when policy findings are triggered.</p>
                </div>
                <ShieldCheck size={18} aria-hidden="true" />
              </div>
              <div className="panel-body owner-mapping-grid">
                {ownerMappingRows.map((mapping, index) => (
                  <div className="owner-mapping-row" key={mapping.key}>
                    <div className="field">
                      <label htmlFor={`ownerKey_${index}`}>{mapping.label}</label>
                      <input
                        className="input"
                        disabled={!selectedRepository}
                        id={`ownerKey_${index}`}
                        name={`ownerKey_${index}`}
                        placeholder={mapping.ownerKeyPlaceholder}
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
                    Configure owner mappings before moving high-risk rules to enforce mode.
                  </p>
                ) : null}
              </div>
            </section>
          </div>

          <div className="two-column">
            <section className="panel">
              <div className="panel-header">
                <h2>Retention and advisory controls</h2>
              </div>
              <div className="panel-body form-grid">
                {!selectedHandling ? (
                  <p className="muted">Data-handling settings are not available.</p>
                ) : null}
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
                  <h2>Preview recent PRs</h2>
                  <p>Preview shows would pass, warn, or block before enabling required checks.</p>
                </div>
                <button className="button button--primary" type="button">
                  <Play size={16} aria-hidden="true" /> Run preview
                </button>
              </div>
              <ul className="compact-list">
                {dashboard.records.length === 0 ? (
                  <li>No recent PR evaluations are available for preview.</li>
                ) : null}
                {dashboard.records.slice(0, 3).map((item) => {
                  const missing = missingEvidence(item.record);
                  const reviewers = pendingRequiredReviewers(item.record);
                  const previewStatus =
                    missing.length > 0 || reviewers.length > 0 ? "block" : item.record.checkStatus;
                  return (
                    <li key={item.record.id}>
                      <div className="list-row">
                        <span>
                          {item.record.repositoryFullName} #{item.record.pullRequestNumber}
                        </span>
                        <StatusBadge status={previewStatus} label={`would ${previewStatus}`} />
                      </div>
                      <p>
                        {missing
                          .map((evidence) => `${humanize(evidence.kind)} missing`)
                          .join(", ") ||
                          reviewers
                            .map((reviewer) => `${reviewer.reviewer} approval pending`)
                            .join(", ") ||
                          "Configured policy requirements are satisfied."}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </form>
      </section>
    </>
  );
}

function ownerRows(mappings: NonNullable<SettingsData["ownerMappings"]>): Array<{
  key: string;
  label: string;
  ownerKey: string;
  ownerKeyPlaceholder: string;
  reviewer: string;
  reviewerType: string;
}> {
  const defaults = [
    { ownerKey: "security_team", label: "Security team", reviewer: "", reviewerType: "team" },
    { ownerKey: "platform_team", label: "Platform team", reviewer: "", reviewerType: "team" },
    { ownerKey: "billing_owner", label: "Billing owner", reviewer: "", reviewerType: "team" },
    { ownerKey: "database_owner", label: "Database owner", reviewer: "", reviewerType: "team" }
  ];
  const byOwnerKey = new Map(
    mappings.map((mapping) => [
      mapping.ownerKey ?? mapping.reviewer,
      {
        ownerKey: mapping.ownerKey ?? "",
        reviewer: mapping.reviewer,
        reviewerType: mapping.reviewerType
      }
    ])
  );
  return defaults.map((row, index) => {
    const configured = byOwnerKey.get(row.ownerKey) ?? row;
    return {
      key: `${row.ownerKey}-${index}`,
      label: row.label,
      ownerKey: configured.reviewer ? configured.ownerKey : "",
      ownerKeyPlaceholder: row.ownerKey,
      reviewer: configured.reviewer,
      reviewerType: configured.reviewerType
    };
  });
}
