"use client";

import { useState } from "react";
import { FileCode2, Plus, Trash2 } from "lucide-react";
import { createStandaloneRecord } from "./actions";

type PolicyPackOption = { id: string; name: string; defaultMode: string };

type ChangedFileRow = { filename: string; status: string; patch: string };

const STATUSES = ["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"];

export function StandaloneRecordForm({ policyPacks }: { policyPacks: PolicyPackOption[] }) {
  const [files, setFiles] = useState<ChangedFileRow[]>([
    { filename: "", status: "modified", patch: "" }
  ]);

  const updateFile = (index: number, patch: Partial<ChangedFileRow>) => {
    setFiles((prev) => prev.map((file, i) => (i === index ? { ...file, ...patch } : file)));
  };

  const addFile = () => {
    setFiles((prev) => [...prev, { filename: "", status: "modified", patch: "" }]);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <form action={createStandaloneRecord} className="standalone-form">
      <input name="returnTo" type="hidden" value="/records" />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="repositoryFullName">Repository (owner/name)</label>
          <input
            className="input"
            id="repositoryFullName"
            name="repositoryFullName"
            placeholder="acme/payments"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pullRequestNumber">PR number</label>
          <input
            className="input"
            id="pullRequestNumber"
            name="pullRequestNumber"
            type="number"
            min={1}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="title">Title</label>
          <input className="input" id="title" name="title" required />
        </div>
        <div className="field">
          <label htmlFor="authorLogin">Author</label>
          <input className="input" id="authorLogin" name="authorLogin" required />
        </div>
        <div className="field">
          <label htmlFor="baseBranch">Base branch</label>
          <input className="input" id="baseBranch" name="baseBranch" defaultValue="main" required />
        </div>
        <div className="field">
          <label htmlFor="headBranch">Head branch</label>
          <input className="input" id="headBranch" name="headBranch" required />
        </div>
        <div className="field">
          <label htmlFor="headSha">Head SHA</label>
          <input className="input" id="headSha" name="headSha" required />
        </div>
        <div className="field">
          <label htmlFor="policyPackId">Policy pack</label>
          <select className="select" id="policyPackId" name="policyPackId" defaultValue="fintech">
            {policyPacks.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--wide">
          <label htmlFor="body">Description</label>
          <textarea className="input" id="body" name="body" rows={2} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h3>Changed files</h3>
            <p>Paths and diffs drive the deterministic detectors.</p>
          </div>
          <button className="button" type="button" onClick={addFile}>
            <Plus size={16} aria-hidden="true" /> Add file
          </button>
        </div>
        {files.map((file, index) => (
          <div className="standalone-file-row" key={index}>
            <input
              className="input"
              name={`filename_${index}`}
              placeholder="src/billing/checkout.ts"
              value={file.filename}
              onChange={(event) => updateFile(index, { filename: event.target.value })}
              required
            />
            <select
              className="select"
              name={`status_${index}`}
              value={file.status}
              onChange={(event) => updateFile(index, { status: event.target.value })}
            >
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            <textarea
              className="input"
              name={`patch_${index}`}
              placeholder="@@ ... +..."
              value={file.patch}
              onChange={(event) => updateFile(index, { patch: event.target.value })}
              rows={2}
            />
            {files.length > 1 ? (
              <button
                className="button button--danger"
                type="button"
                onClick={() => removeFile(index)}
                aria-label="Remove changed file"
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="control-row">
        <button className="button button--primary" type="submit">
          <FileCode2 size={16} aria-hidden="true" /> Create Change Control Record
        </button>
      </div>
    </form>
  );
}
