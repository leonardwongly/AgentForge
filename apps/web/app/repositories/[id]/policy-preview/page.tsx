import { Play } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { demoRecords } from "../../../data";

export default function PolicyPreviewPage() {
  return (
    <>
      <header className="topbar">
        <div>
          <h1>Policy preview</h1>
          <p>Preview observe, warn, and enforce effects before changing required checks.</p>
        </div>
        <button className="button button--primary" type="button">
          <Play size={16} aria-hidden="true" /> Run preview
        </button>
      </header>
      <section className="page">
        <section className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>Recent PR</th>
                <th>Would pass</th>
                <th>Would warn</th>
                <th>Would block</th>
                <th>Triggered findings</th>
                <th>Required evidence</th>
              </tr>
            </thead>
            <tbody>
              {demoRecords.map((record) => (
                <tr key={record.id}>
                  <td>
                    {record.repositoryFullName} #{record.pullRequestNumber}
                  </td>
                  <td>{record.checkStatus === "pass" ? <StatusBadge status="pass" /> : "No"}</td>
                  <td>{record.checkStatus === "warn" ? <StatusBadge status="warn" /> : "No"}</td>
                  <td>{record.checkStatus === "block" ? <StatusBadge status="block" /> : "No"}</td>
                  <td>{record.verifiedFindings.length}</td>
                  <td>{record.requiredEvidence.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>
    </>
  );
}
