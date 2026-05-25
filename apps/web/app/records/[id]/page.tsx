import Link from "next/link";
import { CheckCircle2, Download, GitBranch, Send, ShieldCheck, XCircle } from "lucide-react";
import { MetricCard, StatusBadge } from "@agentforge/ui";
import { DataSourceNotice } from "../../data-source-notice";
import { AiDraftBlock } from "./ai-draft-block";
import {
  formatDate,
  governanceDecisionLabel,
  hasAgentSignal,
  humanize,
  loadRecord,
  missingEvidence,
  pendingRequiredReviewers,
  summarizeFindings
} from "../../data";
import {
  approveEvidence,
  approveReviewer,
  createRecordExport,
  rejectEvidence,
  submitEvidence
} from "../actions";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{
    updated?: string;
    exportId?: string;
    recordCount?: string;
    error?: string;
  }>;
};

export default async function RecordDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const query = await searchParams;
  const data = await loadRecord(id);
  const item = data.item;
  if (!item) {
    return (
      <>
        <header className="topbar">
          <div>
            <h1>Change Control Record</h1>
            <p>Record {id} was not found in the current data set.</p>
          </div>
        </header>
        <section className="page">
          <DataSourceNotice {...data} />
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Record not found</h2>
                <p>
                  Create a Change Control Record by sending a GitHub webhook or running a policy
                  preview.
                </p>
              </div>
            </div>
          </section>
        </section>
      </>
    );
  }
  const record = item.record;
  const missing = missingEvidence(record);
  const pendingReviewers = pendingRequiredReviewers(record);
  const decisionLabel = governanceDecisionLabel(record);
  const updateNotice = query?.updated ? evidenceUpdateNotice(query.updated) : undefined;
  const errorNotice = query?.error ? recordErrorNotice(query.error) : undefined;

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Change Control Record</h1>
          <p>
            {record.repositoryFullName} #{record.pullRequestNumber} · {record.headSha} ·{" "}
            {record.baseBranch}
          </p>
        </div>
        <div className="control-row">
          <a className="button" href={item.githubUrl} rel="noreferrer">
            <GitBranch size={16} aria-hidden="true" /> GitHub PR
          </a>
          <form action={createRecordExport}>
            <input name="returnTo" type="hidden" value={`/records/${id}`} />
            <input name="format" type="hidden" value="json" />
            <button className="button button--primary" type="submit">
              <Download size={16} aria-hidden="true" /> Export
            </button>
          </form>
        </div>
      </header>

      <section className="page">
        {query?.updated === "records-export" ? (
          <section className="notice">
            <Download size={18} aria-hidden="true" />
            <div>
              <h2>Export created</h2>
              <p>
                Job {query.exportId ?? "created"} contains {query.recordCount ?? "0"} Change Control
                Records.
              </p>
            </div>
          </section>
        ) : null}
        {updateNotice ? (
          <section className="notice">
            <CheckCircle2 size={18} aria-hidden="true" />
            <div>
              <h2>{updateNotice.title}</h2>
              <p>{updateNotice.detail}</p>
            </div>
          </section>
        ) : null}
        {errorNotice ? (
          <section className="notice notice--unavailable">
            <XCircle size={18} aria-hidden="true" />
            <div>
              <h2>{errorNotice.title}</h2>
              <p>{errorNotice.detail}</p>
            </div>
          </section>
        ) : null}
        <DataSourceNotice {...data} />

        {record.checkStatus === "pass" && (missing.length > 0 || pendingReviewers.length > 0) ? (
          <section className="notice">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <h2>Passing because policy is observing</h2>
              <p>
                {missing.length} evidence requirement(s) and {pendingReviewers.length} reviewer
                approval(s) remain open. They would block only after this policy moves to enforce or
                optimize.
              </p>
            </div>
          </section>
        ) : null}

        <div className="metrics-grid">
          <MetricCard
            label="Check status"
            value={record.checkStatus}
            detail="Merge Guard result for the latest deterministic evaluation."
            tone={
              record.checkStatus === "block"
                ? "block"
                : record.checkStatus === "warn"
                  ? "warn"
                  : "pass"
            }
          />
          <MetricCard
            label="Policy version"
            value={record.policyVersion}
            detail="Preserved for audit reconstruction."
            tone="neutral"
          />
          <MetricCard
            label="Open evidence"
            value={String(missing.length)}
            detail={
              missing.length > 0
                ? "Evidence requirements are missing, provided but unapproved, or rejected."
                : "All required evidence is approved or accepted."
            }
            tone={missing.length > 0 ? "block" : "pass"}
          />
          <MetricCard
            label="Required reviewers"
            value={String(pendingReviewers.length)}
            detail={
              pendingReviewers.length > 0
                ? "Required reviewer approvals still pending."
                : "No required reviewer approvals are pending."
            }
            tone={pendingReviewers.length > 0 ? "warn" : "pass"}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>{item.title}</h2>
              <p>
                Author {item.author} · Team {item.team} · Policy pack {record.policyPackId}
              </p>
              <p className="muted">
                Findings summary: {summarizeFindings(record.verifiedFindings)}
              </p>
            </div>
            <div className="inline-list">
              <StatusBadge status={record.mode} />
              <StatusBadge
                status={record.lifecycle === "overridden" ? "overridden" : record.checkStatus}
              />
              {hasAgentSignal(record) ? (
                <StatusBadge status="low" label="agent signal recorded" />
              ) : null}
            </div>
          </div>
          <div className="summary-strip">
            <div>
              <span>Created</span>
              <strong>{formatDate(record.createdAt)}</strong>
            </div>
            <div>
              <span>Updated</span>
              <strong>{formatDate(record.updatedAt)}</strong>
            </div>
            <div>
              <span>Decision</span>
              <strong>{decisionLabel}</strong>
            </div>
            <div>
              <span>Policy pack</span>
              <strong>{record.policyPackVersion ?? "custom"}</strong>
            </div>
          </div>
        </section>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Verified findings</h2>
                <p>Facts come from deterministic GitHub metadata, paths, manifests, and diffs.</p>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Evidence</th>
                  <th>Confidence</th>
                  <th>Severity</th>
                </tr>
              </thead>
              <tbody>
                {record.verifiedFindings.map((finding) => (
                  <tr key={finding.id}>
                    <td>{humanize(finding.type)}</td>
                    <td>{finding.evidence}</td>
                    <td>{finding.confidence}</td>
                    <td>
                      <StatusBadge status={finding.severity ?? "medium"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Lifecycle timeline</h2>
                <p>Evaluation, check publication, decision, and override state.</p>
              </div>
            </div>
            <ol className="timeline">
              <li>
                <strong>Opened</strong>
                <p>{formatDate(record.createdAt)}</p>
              </li>
              <li>
                <strong>Evaluated</strong>
                <p>{formatDate(record.updatedAt)}</p>
              </li>
              {item.checkHistory.map((check) => (
                <li key={`${check.status}:${check.publishedAt}`}>
                  <strong>Check published: {check.conclusion}</strong>
                  <p>{check.message}</p>
                </li>
              ))}
              <li>
                <strong>Decision: {decisionLabel}</strong>
                <p>
                  {record.decision?.decidedAt &&
                  missing.length === 0 &&
                  pendingReviewers.length === 0
                    ? formatDate(record.decision.decidedAt)
                    : "Open requirements remain; no final approval is recorded."}
                </p>
              </li>
            </ol>
          </section>
        </div>

        <div className="two-column">
          <section className="panel">
            <div className="panel-header">
              <h2>Required evidence</h2>
            </div>
            <ul className="checklist">
              {record.requiredEvidence.length === 0 ? (
                <li>No required evidence for this evaluation.</li>
              ) : (
                record.requiredEvidence.map((evidence) => (
                  <li key={evidence.id}>
                    <div className="list-row">
                      <strong>{humanize(evidence.kind)}</strong>
                      <StatusBadge status={evidence.status} />
                    </div>
                    <p>{evidence.contentSummary ?? "Required evidence missing."}</p>
                    {evidence.providedBy ? (
                      <p className="muted">
                        Provided by {evidence.providedBy}
                        {evidence.providedAt ? ` on ${formatDate(evidence.providedAt)}` : ""}.
                      </p>
                    ) : null}
                    {evidence.approvedBy ? (
                      <p className="muted">
                        Approved by {evidence.approvedBy}
                        {evidence.approvedAt ? ` on ${formatDate(evidence.approvedAt)}` : ""}.
                      </p>
                    ) : null}
                    {evidence.status !== "approved" ? (
                      <form action={submitEvidence} className="evidence-action-form">
                        <input name="returnTo" type="hidden" value={`/records/${id}`} />
                        <input name="recordId" type="hidden" value={record.id} />
                        <input name="evidenceId" type="hidden" value={evidence.id} />
                        <input name="kind" type="hidden" value={evidence.kind} />
                        <label htmlFor={`evidence-content-${evidence.id}`}>
                          {evidence.status === "rejected" ? "Correct evidence" : "Evidence content"}
                        </label>
                        <textarea
                          className="input evidence-textarea"
                          id={`evidence-content-${evidence.id}`}
                          maxLength={4000}
                          minLength={10}
                          name="content"
                          placeholder="Reference the rollback plan, migration dry run, security note, or linked artifact."
                          required
                          rows={3}
                        />
                        {evidence.aiDraft ? (
                          <AiDraftBlock evidenceId={evidence.id} draftText={evidence.aiDraft} />
                        ) : null}
                        <button className="button button--primary" type="submit">
                          <Send size={16} aria-hidden="true" /> Submit evidence
                        </button>
                      </form>
                    ) : null}
                    {evidence.status === "provided" ? (
                      <div className="evidence-actions">
                        <form action={approveEvidence}>
                          <input name="returnTo" type="hidden" value={`/records/${id}`} />
                          <input name="recordId" type="hidden" value={record.id} />
                          <input name="evidenceId" type="hidden" value={evidence.id} />
                          <button className="button" type="submit">
                            <CheckCircle2 size={16} aria-hidden="true" /> Approve evidence
                          </button>
                        </form>
                        <form action={rejectEvidence} className="evidence-reject-form">
                          <input name="returnTo" type="hidden" value={`/records/${id}`} />
                          <input name="recordId" type="hidden" value={record.id} />
                          <input name="evidenceId" type="hidden" value={evidence.id} />
                          <label htmlFor={`evidence-reject-${evidence.id}`}>Reject reason</label>
                          <input
                            className="input"
                            id={`evidence-reject-${evidence.id}`}
                            maxLength={1000}
                            minLength={10}
                            name="reason"
                            required
                            type="text"
                          />
                          <button className="button button--danger" type="submit">
                            <XCircle size={16} aria-hidden="true" /> Reject evidence
                          </button>
                        </form>
                      </div>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>Reviewer requirements</h2>
            </div>
            <ul className="checklist">
              {record.requiredReviewers.length === 0 ? (
                <li>No reviewer requirement for this evaluation.</li>
              ) : (
                record.requiredReviewers.map((reviewer) => (
                  <li key={reviewer.id}>
                    <div className="list-row">
                      <strong>{reviewer.reviewer}</strong>
                      <StatusBadge
                        status={reviewer.approved ? "approved" : reviewer.tier}
                        label={reviewer.approved ? "approved" : reviewer.tier}
                      />
                    </div>
                    <p>{reviewer.reason}</p>
                    {!reviewer.approved ? (
                      <form action={approveReviewer}>
                        <input name="returnTo" type="hidden" value={`/records/${id}`} />
                        <input name="recordId" type="hidden" value={record.id} />
                        <input name="reviewerId" type="hidden" value={reviewer.id} />
                        <button className="button" type="submit">
                          <CheckCircle2 size={16} aria-hidden="true" /> Approve reviewer
                        </button>
                      </form>
                    ) : reviewer.approvedBy ? (
                      <p className="muted">
                        Approved by {reviewer.approvedBy}
                        {reviewer.approvedAt ? ` on ${formatDate(reviewer.approvedAt)}` : ""}.
                      </p>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>

        {item.override ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Override details</h2>
                <p>Merge was allowed after authorized override with reason.</p>
              </div>
              <ShieldCheck size={18} aria-hidden="true" />
            </div>
            <div className="summary-strip">
              <div>
                <span>Actor</span>
                <strong>{item.override.actor}</strong>
              </div>
              <div>
                <span>Role</span>
                <strong>{item.override.actorRole}</strong>
              </div>
              <div>
                <span>Scope</span>
                <strong>{item.override.scope}</strong>
              </div>
              <div>
                <span>Visible in PR</span>
                <strong>{item.override.visibleInPr ? "yes" : "no"}</strong>
              </div>
            </div>
            <div className="panel-body">
              <p>{item.override.reason}</p>
            </div>
          </section>
        ) : null}
      </section>
    </>
  );
}

function evidenceUpdateNotice(updated: string): { title: string; detail: string } | undefined {
  switch (updated) {
    case "evidence-submitted":
      return {
        title: "Evidence submitted",
        detail: "The requirement is provided and awaiting approval."
      };
    case "evidence-approved":
      return {
        title: "Evidence approved",
        detail: "Merge Guard re-evaluated the record against the remaining open requirements."
      };
    case "evidence-rejected":
      return {
        title: "Evidence rejected",
        detail: "The requirement remains open until corrected evidence is submitted and approved."
      };
    case "reviewer-approved":
      return {
        title: "Reviewer approved",
        detail: "Merge Guard re-evaluated the record after the reviewer requirement was cleared."
      };
    default:
      return undefined;
  }
}

function recordErrorNotice(error: string): { title: string; detail: string } | undefined {
  switch (error) {
    case "record-export-failed":
      return {
        title: "Export was not created",
        detail: "The export request failed. Refresh the record and try again."
      };
    case "evidence-submission-required":
      return {
        title: "Evidence was not submitted",
        detail: "Select an evidence requirement and provide at least 10 characters of content."
      };
    case "evidence-submission-failed":
      return {
        title: "Evidence was not submitted",
        detail: "The evidence request failed. Refresh the record and try again."
      };
    case "evidence-approval-required":
      return {
        title: "Evidence was not approved",
        detail: "Select an evidence requirement before approving it."
      };
    case "evidence-approval-failed":
      return {
        title: "Evidence was not approved",
        detail: "The approval request failed. Refresh the record and try again."
      };
    case "evidence-rejection-required":
      return {
        title: "Evidence was not rejected",
        detail: "Select an evidence requirement and provide a rejection reason."
      };
    case "evidence-rejection-failed":
      return {
        title: "Evidence was not rejected",
        detail: "The rejection request failed. Refresh the record and try again."
      };
    case "reviewer-approval-required":
      return {
        title: "Reviewer was not approved",
        detail: "Select a reviewer requirement before approving it."
      };
    case "reviewer-approval-failed":
      return {
        title: "Reviewer was not approved",
        detail: "The reviewer approval request failed. Refresh the record and try again."
      };
    default:
      return undefined;
  }
}
