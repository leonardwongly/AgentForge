import { Save, ShieldCheck } from "lucide-react";
import { policyYaml } from "../../../data";

export default function PolicyEditorPage() {
  return (
    <>
      <header className="topbar">
        <div>
          <h1>Policy editor</h1>
          <p>YAML policy-as-code with validation, preview, and version history.</p>
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
        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Fintech policy pack fork</h2>
                <p>Policy version fintech@1.0.0. Edits create a new immutable version.</p>
              </div>
            </div>
            <pre className="code-pane">{policyYaml}</pre>
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>Validation</h2>
            </div>
            <ul className="checklist">
              <li>Schema version: valid</li>
              <li>Mode: warn</li>
              <li>Blocking confidence: verified or observed only</li>
              <li>LLM features: disabled</li>
            </ul>
          </section>
        </div>
      </section>
    </>
  );
}
