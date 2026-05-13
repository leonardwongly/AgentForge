import Link from "next/link";
import { Save, ShieldCheck, WandSparkles } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { policyYaml } from "../../../data";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function PolicyEditorPage({ params }: PageProps) {
  const { id } = await params;

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Policy Editor</h1>
          <p>
            YAML policy-as-code with validation, immutable versions, and preview before enforcement.
          </p>
        </div>
        <div className="control-row">
          <button className="button" type="button">
            <ShieldCheck size={16} aria-hidden="true" /> Validate
          </button>
          <button className="button button--primary" type="button">
            <Save size={16} aria-hidden="true" /> Save new version
          </button>
        </div>
      </header>

      <section className="page">
        <div className="summary-strip">
          <div>
            <span>Repository</span>
            <strong>{id}</strong>
          </div>
          <div>
            <span>Policy pack</span>
            <strong>fintech</strong>
          </div>
          <div>
            <span>Current mode</span>
            <strong>warn</strong>
          </div>
          <div>
            <span>Version</span>
            <strong>1.4.0</strong>
          </div>
        </div>

        <div className="yaml-grid">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Fintech policy pack fork</h2>
                <p>Edits create a new immutable policy version for future evaluations.</p>
              </div>
              <Link className="button" href={`/repositories/${id}/policy-preview`}>
                <WandSparkles size={16} aria-hidden="true" /> Preview
              </Link>
            </div>
            <pre className="code-pane">{policyYaml}</pre>
          </section>

          <div className="bar-list">
            <section className="panel">
              <div className="panel-header">
                <h2>Validation</h2>
              </div>
              <ul className="checklist">
                <li>
                  <div className="list-row">
                    <span>Schema version</span>
                    <StatusBadge status="approved" label="valid" />
                  </div>
                </li>
                <li>
                  <div className="list-row">
                    <span>Mode</span>
                    <StatusBadge status="warn" />
                  </div>
                </li>
                <li>
                  <div className="list-row">
                    <span>Blocking confidence</span>
                    <StatusBadge status="approved" label="verified or observed" />
                  </div>
                </li>
                <li>
                  <div className="list-row">
                    <span>LLM advisory features</span>
                    <StatusBadge status="approved" label="disabled" />
                  </div>
                </li>
              </ul>
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2>Version history</h2>
              </div>
              <ul className="compact-list">
                <li>
                  <strong>fintech@1.4.0</strong>
                  <p>Current repository policy. Dependency and migration evidence required.</p>
                </li>
                <li>
                  <strong>fintech@1.3.0</strong>
                  <p>Added billing owner routing and rollback plan requirement.</p>
                </li>
                <li>
                  <strong>startup-default@1.0.0</strong>
                  <p>Initial observe-mode policy pack.</p>
                </li>
              </ul>
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2>Mode behavior</h2>
              </div>
              <div className="panel-body mode-grid">
                <div className="mode-card">
                  <h3>observe</h3>
                  <p>Records findings and always publishes a passing check.</p>
                </div>
                <div className="mode-card">
                  <h3>warn</h3>
                  <p>Records what would block without blocking merge.</p>
                </div>
                <div className="mode-card">
                  <h3>enforce</h3>
                  <p>Blocks when configured evidence or required approvals are missing.</p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </>
  );
}
