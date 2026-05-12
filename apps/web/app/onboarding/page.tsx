import { CheckCircle2 } from "lucide-react";

const steps = [
  ["Connect GitHub App", "Install the app and verify webhook delivery."],
  ["Select organization", "Choose the GitHub organization to govern."],
  ["Select repositories", "Enable protected repositories without storing source code."],
  ["Choose policy pack", "Start from Startup Default, Fintech, Platform, or Enterprise Strict."],
  ["Choose starting mode", "Observe is recommended; warn and enforce can be staged."],
  ["Map owners", "Assign security, platform, billing, and database owners."],
  ["Configure data retention", "Keep full diff retention disabled unless explicitly needed."],
  ["Preview policy", "Run recent PRs through the pack before requiring checks."],
  ["Finish setup", "Publish Merge Guard checks and record outcomes."]
];

export default function OnboardingPage() {
  return (
    <>
      <header className="topbar">
        <div>
          <h1>Onboarding</h1>
          <p>Configure Merge Guard without writing YAML manually.</p>
        </div>
        <button className="button button--primary" type="button">
          <CheckCircle2 size={16} aria-hidden="true" /> Finish setup
        </button>
      </header>
      <section className="page">
        <div className="step-grid">
          {steps.map(([title, detail], index) => (
            <section className="step" key={title}>
              <h2>
                {index + 1}. {title}
              </h2>
              <p>{detail}</p>
            </section>
          ))}
        </div>
      </section>
    </>
  );
}
