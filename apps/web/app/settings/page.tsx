import { Save } from "lucide-react";

export default function SettingsPage() {
  return (
    <>
      <header className="topbar">
        <div>
          <h1>Settings</h1>
          <p>Installation, repositories, retention, LLM controls, roles, and audit exports.</p>
        </div>
        <button className="button button--primary" type="button">
          <Save size={16} aria-hidden="true" /> Save settings
        </button>
      </header>
      <section className="page">
        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <h2>Data handling</h2>
            </div>
            <ul className="checklist">
              <li>Source code storage: disabled</li>
              <li>Full diff retention: disabled</li>
              <li>Secret redaction: enabled</li>
              <li>Audit record retention: 365 days</li>
              <li>LLM features: disabled</li>
            </ul>
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>Owner mappings</h2>
            </div>
            <ul className="checklist">
              <li>Security team: security-team</li>
              <li>Platform team: platform-team</li>
              <li>Billing owner: billing-owner</li>
              <li>Database owner: database-owner</li>
            </ul>
          </section>
        </div>
      </section>
    </>
  );
}
