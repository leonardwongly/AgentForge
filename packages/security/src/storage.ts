import { redactSecrets } from "./redaction.js";

export type FullDiffRetention = "disabled" | "7d" | "30d" | "custom";

export type MetadataStoragePolicy = {
  sourceCodeStorage?: boolean | undefined;
  fullDiffRetention?: FullDiffRetention | undefined;
  redactSecrets?: boolean | undefined;
};

export const DEFAULT_METADATA_STORAGE_POLICY: Required<MetadataStoragePolicy> = {
  sourceCodeStorage: false,
  fullDiffRetention: "disabled",
  redactSecrets: true
};

const sourceCodeKeys = new Set([
  "blob",
  "content",
  "currentContent",
  "fileContent",
  "previousContent",
  "rawContent",
  "sourceBlob",
  "sourceCode"
]);

const diffKeys = new Set(["diff", "fullDiff", "patch", "rawDiff", "rawPatch"]);

const omitted = Symbol("omitted");

export function sanitizeForMetadataStorage<T>(
  value: T,
  policy: MetadataStoragePolicy = DEFAULT_METADATA_STORAGE_POLICY
): T {
  const effective = normalizePolicy(policy);
  const sanitized = sanitizeValue(value, effective);
  return (sanitized === omitted ? undefined : sanitized) as T;
}

export function normalizePolicy(
  policy: MetadataStoragePolicy = DEFAULT_METADATA_STORAGE_POLICY
): Required<MetadataStoragePolicy> {
  return {
    sourceCodeStorage:
      policy.sourceCodeStorage ?? DEFAULT_METADATA_STORAGE_POLICY.sourceCodeStorage,
    fullDiffRetention:
      policy.fullDiffRetention ?? DEFAULT_METADATA_STORAGE_POLICY.fullDiffRetention,
    redactSecrets: policy.redactSecrets ?? DEFAULT_METADATA_STORAGE_POLICY.redactSecrets
  };
}

export function shouldRetainFullDiff(policy: MetadataStoragePolicy): boolean {
  return normalizePolicy(policy).fullDiffRetention !== "disabled";
}

function sanitizeValue(
  value: unknown,
  policy: Required<MetadataStoragePolicy>,
  key?: string,
  ancestors: WeakSet<object> = new WeakSet<object>()
): unknown | typeof omitted {
  if (key && shouldOmitKey(key, policy)) {
    return omitted;
  }
  if (typeof value === "string") {
    return policy.redactSecrets ? redactString(value) : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return omitted;
    }
    ancestors.add(value);
    const sanitized = value
      .map((item) => sanitizeValue(item, policy, undefined, ancestors))
      .filter((item): item is unknown => item !== omitted);
    ancestors.delete(value);
    return sanitized;
  }
  if (value && typeof value === "object") {
    // Metadata is eventually serialized as JSON. Drop cyclic references at
    // this boundary instead of recursing forever or returning an object that
    // JSON.stringify cannot encode. The active-path set preserves repeated,
    // non-cyclic references in separate fields.
    if (ancestors.has(value)) {
      return omitted;
    }
    if (value instanceof Date) {
      return value;
    }
    ancestors.add(value);
    const entries: Array<[string, unknown]> = [];
    try {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        const sanitized = sanitizeValue(nestedValue, policy, nestedKey, ancestors);
        if (sanitized !== omitted) {
          entries.push([nestedKey, sanitized]);
        }
      }
    } catch {
      // A proxy/getter can throw while exposing metadata. Treat that branch as
      // untrusted and omit it; sanitization must never turn a logging path into
      // a process-level failure.
      return omitted;
    } finally {
      ancestors.delete(value);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function shouldOmitKey(key: string, policy: Required<MetadataStoragePolicy>): boolean {
  if (sourceCodeKeys.has(key)) {
    return !policy.sourceCodeStorage;
  }
  if (diffKeys.has(key)) {
    return !shouldRetainFullDiff(policy);
  }
  return false;
}

function redactString(value: string): string {
  return redactSecrets(value);
}
