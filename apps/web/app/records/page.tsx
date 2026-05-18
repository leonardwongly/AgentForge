import Link from "next/link";
import { Download, FileCheck } from "lucide-react";
import { StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../data-source-notice";
import { formatDate, loadDashboardData, summarizeFindings } from "../data";
import { createRecordExport } from "./actions";

type RecordsPageProps = {
  searchParams?: Promise<{
    updated?: string;
    exportId?: string;
    recordCount?: string;
    error?: string;
  }>;
};

export default async function RecordsPage({ searchParams }: RecordsPageProps) {
  const params = await searchParams;
  const data = await loadDashboardData();

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Change Control Records</h1>
          <p>Audit-ready records for evaluated pull requests, policy versions, and decisions.</p>
        </div>
        <form action={createRecordExport}>
          <input name="returnTo" type="hidden" value="/records" />
          <input name="format" type="hidden" value="json" />
          <button className="button button--primary" type="submit">
            <Download size={16} aria-hidden="true" /> Export records
          </button>
        </form>
      </header>

      <section className="page">
        {params?.updated === "records-export" ? (
          <section className="notice">
            <Download size={18} aria-hidden="true" />
            <div>
              <h2>Export created</h2>
              <p>
                Job {params.exportId ?? "created"} contains {params.recordCount ?? "0"} Change
                Control Records.
              </p>
            </div>
          </section>
        ) : null}
        {params?.error ? (
          <section className="notice notice--unavailable">
            <Download size={18} aria-hidden="true" />
            <div>
              <h2>Export was not created</h2>
              <p>{params.error}</p>
            </div>
          </section>
        ) : null}
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
                  <td>{summarizeFindings(item.record.verifiedFindings)}</td>
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
