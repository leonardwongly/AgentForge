import Link from "next/link";
import { Save, ShieldCheck, WandSparkles } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { loadPolicyYaml } from "../../../data";
import { saveRepositoryPolicy } from "./actions";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function PolicyEditorPage({ params }: PageProps) {
  const { id } = await params;
  const policy = await loadPolicyYaml(id);

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
          <button className="button button--primary" form="policy-editor-form" type="submit">
            <Save size={16} aria-hidden="true" /> Save new version
          </button>
        </div>
      </header>

      <section className="page">
        {policy.source !== "api" ? (
          <section className={`notice notice--${policy.source}`}>
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <h2>Policy API unavailable</h2>
              <p>{policy.message}</p>
            </div>
          </section>
        ) : null}

        <div className="summary-strip">
          <div>
            <span>Repository</span>
            <strong>{id}</strong>
          </div>
          <div>
            <span>Policy pack</span>
            <strong>{policy.policyPackId ?? "not configured"}</strong>
          </div>
          <div>
            <span>Current mode</span>
            <strong>{policy.mode ?? "not configured"}</strong>
          </div>
          <div>
            <span>Version</span>
            <strong>{policy.version ?? "not configured"}</strong>
          </div>
        </div>

        <div className="yaml-grid">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Active repository policy</h2>
                <p>Edits create a new immutable policy version for future evaluations.</p>
              </div>
              <Link className="button" href={`/repositories/${id}/policy-preview`}>
                <WandSparkles size={16} aria-hidden="true" /> Preview
              </Link>
            </div>
            <form
              action={saveRepositoryPolicy}
              className="policy-editor-form"
              id="policy-editor-form"
            >
              <input name="repositoryId" type="hidden" value={id} />
              <textarea
                aria-label="Repository policy YAML"
                className="code-pane code-pane--editor"
                defaultValue={policy.policy}
                name="contentYaml"
                spellCheck={false}
              />
            </form>
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
                    <StatusBadge
                      status={policy.policy ? "approved" : "low"}
                      label={policy.policy ? "loaded" : "not loaded"}
                    />
                  </div>
                </li>
                <li>
                  <div className="list-row">
                    <span>Mode</span>
                    {policy.mode ? (
                      <StatusBadge
                        status={policy.mode as "observe" | "warn" | "enforce" | "optimize"}
                      />
                    ) : (
                      <StatusBadge status="low" label="not configured" />
                    )}
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
                {policy.version ? (
                  <li>
                    <strong>{policy.version}</strong>
                    <p>Current repository policy version returned by the API.</p>
                  </li>
                ) : (
                  <li>No policy versions are available for this repository.</li>
                )}
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
                <div className="mode-card">
                  <h3>optimize</h3>
                  <p>Keeps enforce controls active while surfacing governance tuning work.</p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </>
  );
}
