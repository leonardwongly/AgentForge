"use client";

import { revertRepositoryPolicy } from "./actions";

type RevertPolicyFormProps = {
  repositoryId: string;
  versionId: string;
  version: string;
};

export function RevertPolicyForm({ repositoryId, versionId, version }: RevertPolicyFormProps) {
  return (
    <form
      action={revertRepositoryPolicy}
      className="revert-policy-form"
      onSubmit={(event) => {
        const confirmed = window.confirm(
          `Revert the active policy to version ${version}? This creates a new policy version with that version's content and immediately applies it to future evaluations.`
        );
        if (!confirmed) {
          event.preventDefault();
        }
      }}
    >
      <input name="repositoryId" type="hidden" value={repositoryId} />
      <input name="targetVersionId" type="hidden" value={versionId} />
      <button className="button" type="submit">
        Revert to this version
      </button>
    </form>
  );
}
