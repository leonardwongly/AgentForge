import { CheckCircle2, GitBranch, Play, ShieldCheck } from "lucide-react";
import { ProgressBar, StatusBadge } from "@agentforge/ui";
import { loadRepositories, onboardingSteps } from "../data";

export default async function OnboardingPage() {
  const repositories = await loadRepositories();
  const repositoryLabel =
    repositories.repositories
      .map((repository) => repository.fullName.split("/").at(-1))
      .join(", ") || "Select repositories after connecting GitHub";

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
        {repositories.source !== "api" ? (
          <section className={`notice notice--${repositories.source}`}>
            <GitBranch size={18} aria-hidden="true" />
            <div>
              <h2>GitHub setup data unavailable</h2>
              <p>{repositories.message}</p>
            </div>
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Setup progress</h2>
              <p>Start in observe or warn, then move mature rules to enforce.</p>
            </div>
            <StatusBadge status="provided" label="step 3 of 9" />
          </div>
          <div className="panel-body">
            <ProgressBar value={33} label="Onboarding progress" />
          </div>
        </section>

        <div className="step-grid">
          {onboardingSteps.map((step, index) => (
            <section className={`step step--${step.status}`} key={step.title}>
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
                <select className="select" id="organization" defaultValue="acme">
                  <option value="acme">acme</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="repositories">Repositories</label>
                <select className="select" id="repositories" defaultValue={repositoryLabel}>
                  <option value={repositoryLabel}>{repositoryLabel}</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="policy-pack">Policy pack</label>
                <select className="select" id="policy-pack" defaultValue="fintech">
                  <option value="startup">Startup Default</option>
                  <option value="platform">Platform Engineering</option>
                  <option value="fintech">Fintech</option>
                  <option value="regulated">Healthcare / Regulated</option>
                  <option value="enterprise">Enterprise Strict</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="mode">Starting mode</label>
                <select className="select" id="mode" defaultValue="warn">
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
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <h2>Retention and advisory controls</h2>
            </div>
            <div className="panel-body">
              {(
                [
                  ["Source code storage", "disabled"],
                  ["Full diff retention", "disabled"],
                  ["Secret redaction", "enabled"],
                  ["LLM advisory features", "disabled"]
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
              <li>
                <div className="list-row">
                  <span>acme/payments #1842</span>
                  <StatusBadge status="block" label="would block" />
                </div>
                <p>Required evidence missing and billing owner approval pending.</p>
              </li>
              <li>
                <div className="list-row">
                  <span>acme/platform #913</span>
                  <StatusBadge status="warn" label="would warn" />
                </div>
                <p>Platform owner approval required for workflow change.</p>
              </li>
              <li>
                <div className="list-row">
                  <span>acme/open-source #88</span>
                  <StatusBadge status="pass" label="would pass" />
                </div>
                <p>No required evidence or reviewer requirement.</p>
              </li>
            </ul>
          </section>
        </div>
      </section>
    </>
  );
}
