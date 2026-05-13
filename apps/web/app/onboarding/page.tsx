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
  pendingRequiredReviewers
} from "../data";

export default async function OnboardingPage() {
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
  const retentionRows = settings.settings
    ? [
        [
          "Source code storage",
          settings.settings.dataHandling.sourceCodeStorage ? "enabled" : "disabled"
        ],
        ["Full diff retention", settings.settings.dataHandling.fullDiffRetention],
        ["Secret redaction", settings.settings.dataHandling.redactSecrets ? "enabled" : "disabled"],
        [
          "LLM advisory features",
          settings.settings.dataHandling.llmFeatures ? "enabled" : "disabled"
        ]
      ]
    : [];

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Onboarding</h1>
          <p>Configure Merge Guard for governed repositories without writing YAML manually.</p>
        </div>
        <button className="button button--primary" type="button">
          <CheckCircle2 size={16} aria-hidden="true" /> Finish setup
        </button>
      </header>

      <section className="page">
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
                <label htmlFor="repositories">Repositories</label>
                <select
                  className="select"
                  id="repositories"
                  defaultValue={
                    enabledRepositories[0]?.id ?? repositories.repositories[0]?.id ?? ""
                  }
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
                <label htmlFor="policy-pack">Policy pack</label>
                <select
                  className="select"
                  id="policy-pack"
                  defaultValue={policyPacks.policyPacks[0]?.id ?? ""}
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
                <select className="select" id="mode" defaultValue={selectedMode}>
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
            <div className="panel-body form-grid">
              {settings.settings?.ownerMappings.length === 0 ? (
                <p className="muted">
                  No owner mappings are available yet. Evaluate a PR or configure policy owners to
                  populate routing targets.
                </p>
              ) : null}
              {settings.settings?.ownerMappings.map((mapping) => (
                <div className="field" key={mapping.reviewer}>
                  <label htmlFor={`owner-${mapping.reviewer}`}>{mapping.reviewer}</label>
                  <input
                    className="input"
                    id={`owner-${mapping.reviewer}`}
                    defaultValue={mapping.sources.join(", ")}
                  />
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <h2>Retention and advisory controls</h2>
            </div>
            <div className="panel-body">
              {retentionRows.length === 0 ? (
                <p className="muted">Data-handling settings are not available.</p>
              ) : null}
              {retentionRows.map(([label, value]) => (
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
                      {missing.map((evidence) => `${humanize(evidence.kind)} missing`).join(", ") ||
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
      </section>
    </>
  );
}
