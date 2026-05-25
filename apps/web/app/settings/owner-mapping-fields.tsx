"use client";

import { useEffect, useRef, useState } from "react";

export type OwnerMappingRow = {
  key: string;
  label: string;
  ownerKey: string;
  ownerKeyPlaceholder: string;
  reviewer: string;
  reviewerType: string;
};

type OwnerMappingFieldsProps = {
  disabled: boolean;
  emptyMessage?: string;
  rows: OwnerMappingRow[];
  savedCount: number;
};

const ownerKeyPattern = /^[a-z0-9_-]+$/u;

export function OwnerMappingFields({
  disabled,
  emptyMessage,
  rows,
  savedCount
}: OwnerMappingFieldsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const root = rootRef.current;
    const form = root?.closest("form");
    if (!root || !form) {
      return undefined;
    }

    const validate = (event: SubmitEvent) => {
      const result = validateOwnerMappings(root, rows.length);
      setError(result?.message);
      if (result) {
        event.preventDefault();
        event.stopPropagation();
        result.field?.focus();
      }
    };

    form.addEventListener("submit", validate, true);
    return () => form.removeEventListener("submit", validate, true);
  }, [rows.length]);

  return (
    <div className="owner-mapping-fields" onInput={() => setError(undefined)} ref={rootRef}>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {rows.map((mapping, index) => (
        <div className="owner-mapping-row" key={mapping.key}>
          <div className="field">
            <label htmlFor={`ownerKey_${index}`}>{mapping.label}</label>
            <input
              className="input"
              disabled={disabled}
              id={`ownerKey_${index}`}
              name={`ownerKey_${index}`}
              placeholder={mapping.ownerKeyPlaceholder}
              defaultValue={mapping.ownerKey}
            />
          </div>
          <div className="field">
            <label htmlFor={`reviewer_${index}`}>Reviewer {index + 1}</label>
            <input
              className="input"
              disabled={disabled}
              id={`reviewer_${index}`}
              name={`reviewer_${index}`}
              placeholder="owner-team or org/team"
              defaultValue={mapping.reviewer}
            />
          </div>
          <div className="field">
            <label htmlFor={`reviewerType_${index}`}>Reviewer type {index + 1}</label>
            <select
              className="select"
              disabled={disabled}
              id={`reviewerType_${index}`}
              name={`reviewerType_${index}`}
              defaultValue={mapping.reviewerType}
            >
              <option value="team">team</option>
              <option value="user">user</option>
            </select>
          </div>
        </div>
      ))}
      {savedCount === 0 && emptyMessage ? <p className="muted">{emptyMessage}</p> : null}
    </div>
  );
}

function validateOwnerMappings(root: HTMLElement, rowCount: number) {
  const seenOwnerKeys = new Set<string>();
  for (let index = 0; index < rowCount; index += 1) {
    const ownerKeyField = field(root, `ownerKey_${index}`);
    const reviewerField = field(root, `reviewer_${index}`);
    const reviewerTypeField = selectField(root, `reviewerType_${index}`);
    const ownerKey = normalizeOwnerKey(ownerKeyField?.value);
    const reviewer = reviewerField?.value.trim() ?? "";
    const reviewerType = reviewerTypeField?.value;

    if (!ownerKey && !reviewer) {
      continue;
    }
    if (!ownerKey || !reviewer || !reviewerType) {
      return {
        field: !ownerKey ? ownerKeyField : reviewerField,
        message: "Each owner mapping must include owner key, reviewer, and type."
      };
    }
    if (!ownerKeyPattern.test(ownerKey)) {
      return {
        field: ownerKeyField,
        message: "Owner keys may include only lowercase letters, numbers, underscores, and hyphens."
      };
    }
    if (!validReviewerForType(reviewer, reviewerType)) {
      return {
        field: reviewerField,
        message:
          reviewerType === "team"
            ? "Team reviewers must be a GitHub team slug or org/team value."
            : "User reviewers must be a GitHub user login and cannot include a team path."
      };
    }
    if (seenOwnerKeys.has(ownerKey)) {
      return {
        field: ownerKeyField,
        message: "Owner mapping keys must be unique per repository."
      };
    }
    seenOwnerKeys.add(ownerKey);
  }
  return undefined;
}

function field(root: HTMLElement, name: string): HTMLInputElement | undefined {
  const element = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  return element ?? undefined;
}

function selectField(root: HTMLElement, name: string): HTMLSelectElement | undefined {
  const element = root.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  return element ?? undefined;
}

function normalizeOwnerKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/gu, "_");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function validReviewerForType(reviewer: string, reviewerType: string): boolean {
  const normalized = reviewer.trim().replace(/^@/u, "");
  if (reviewerType === "user") {
    return githubUserLogin(normalized);
  }
  if (reviewerType !== "team") {
    return false;
  }
  if (normalized.includes("/")) {
    const [org, team, ...rest] = normalized.split("/");
    return rest.length === 0 && githubTeamSegment(org) && githubTeamSegment(team);
  }
  return githubTeamSegment(normalized);
}

function githubUserLogin(value: string | undefined): value is string {
  return Boolean(
    value && !value.includes("/") && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/u.test(value)
  );
}

function githubTeamSegment(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(value));
}
