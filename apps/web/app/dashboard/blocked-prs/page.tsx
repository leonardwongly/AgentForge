import Link from "next/link";
import { ExternalLink, Filter } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { demoRecords } from "../../data";

export default function BlockedPrsPage() {
  const actionRequired = demoRecords.filter(
    (record) =>
      record.checkStatus === "block" ||
      record.requiredEvidence.some((item) => item.status === "missing") ||
      record.requiredReviewers.some((item) => item.tier === "required" && !item.approved)
  );

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Blocked PRs</h1>
          <p>Policy-violating PRs with missing evidence or required reviewer approval.</p>
        </div>
        <button className="button" type="button">
          <Filter size={16} aria-hidden="true" /> Repository, mode, severity
        </button>
      </header>
      <section className="page">
        <section className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>PR</th>
                <th>Title</th>
                <th>Mode</th>
                <th>Findings</th>
                <th>Missing evidence</th>
                <th>Required reviewers</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {actionRequired.map((record) => (
                <tr key={record.id}>
                  <td>{record.repositoryFullName}</td>
                  <td>#{record.pullRequestNumber}</td>
                  <td>Checkout validation and release control updates</td>
                  <td>
                    <StatusBadge status={record.mode === "enforce" ? "enforce" : "observe"} />
                  </td>
                  <td>{record.verifiedFindings.length}</td>
                  <td>
                    {record.requiredEvidence.filter((item) => item.status === "missing").length}
                  </td>
                  <td>
                    {record.requiredReviewers
                      .filter((item) => item.tier === "required" && !item.approved)
                      .map((item) => item.reviewer)
                      .join(", ") || "None"}
                  </td>
                  <td>
                    <Link className="button" href={`/records/${record.id}`}>
                      <ExternalLink size={15} aria-hidden="true" /> Record
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>
    </>
  );
}
