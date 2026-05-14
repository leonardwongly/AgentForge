import Link from "next/link";
import { Download, FileCheck } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../data-source-notice";
import { formatDate, humanize, loadDashboardData } from "../data";

export default async function RecordsPage() {
  const data = await loadDashboardData();

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Change Control Records</h1>
          <p>Audit-ready records for evaluated pull requests, policy versions, and decisions.</p>
        </div>
        <button className="button button--primary" type="button">
          <Download size={16} aria-hidden="true" /> Export records
        </button>
      </header>

      <section className="page">
        <DataSourceNotice {...data} />

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Record index</h2>
              <p>Open a record to inspect findings, required evidence, reviewers, and lifecycle.</p>
            </div>
            <FileCheck size={18} aria-hidden="true" />
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>PR</th>
                <th>Status</th>
                <th>Policy</th>
                <th>Findings</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.records.length === 0 ? (
                <tr>
                  <td className="empty-row" colSpan={6}>
                    No Change Control Records are stored yet.
                  </td>
                </tr>
              ) : null}
              {data.records.map((item) => (
                <tr key={item.record.id}>
                  <td>{item.record.repositoryFullName}</td>
                  <td>
                    <Link href={`/records/${item.record.id}`}>
                      #{item.record.pullRequestNumber}
                    </Link>
                    <p className="muted">{item.title}</p>
                  </td>
                  <td>
                    <StatusBadge status={item.record.checkStatus} />
                  </td>
                  <td>{item.record.policyVersion}</td>
                  <td>
                    {item.record.verifiedFindings
                      .map((finding) => humanize(finding.type))
                      .join(", ") || "none"}
                  </td>
                  <td>{formatDate(item.record.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>
    </>
  );
}
