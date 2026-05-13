import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import semver from "semver";
import type {
  ChangedFile,
  FindingSeverity,
  PullRequestInput,
  VerifiedFact
} from "@agentforge/core";
import { detectSecrets, redactSecrets, summarizeSafeSnippet } from "@agentforge/security";

export type DetectorPolicyConfig = {
  sensitivePaths?: Record<string, { paths: string[] }>;
  migrationPaths?: string[];
  ciWorkflowPaths?: string[];
};

export type DetectorOptions = {
  maxPatchBytes?: number;
  maxFiles?: number;
};

const defaultOptions: Required<DetectorOptions> = {
  maxPatchBytes: 1_000_000,
  maxFiles: 1_000
};

const defaultCiWorkflowPaths = [
  ".github/workflows/**",
  "scripts/deploy/**",
  "infra/prod/**",
  "deployment/**",
  "ci/**",
  "buildkite/**",
  ".circleci/**",
  "Jenkinsfile"
];

const defaultMigrationPaths = [
  "db/migrations/**",
  "migrations/**",
  "database/migrations/**",
  "prisma/migrations/**",
  "alembic/versions/**"
];

const testFilePatterns = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*_test.py",
  "**/test_*.py",
  "**/tests/**"
];

const skipPatterns = [
  "it.skip(",
  "test.skip(",
  "describe.skip(",
  "xit(",
  "xdescribe(",
  "@pytest.mark.skip",
  "pytest.skip("
];

export function extractVerifiedFacts(
  pr: PullRequestInput,
  config: DetectorPolicyConfig = {},
  options: DetectorOptions = {}
): VerifiedFact[] {
  const merged = { ...defaultOptions, ...options };
  const files = pr.changedFiles.slice(0, merged.maxFiles);
  const agentAssisted = detectAgentSignals(pr).length > 0;
  return [
    ...detectSensitivePathChanges(files, config.sensitivePaths ?? {}, agentAssisted),
    ...detectCiWorkflowChanges(
      files,
      config.ciWorkflowPaths ?? defaultCiWorkflowPaths,
      agentAssisted
    ),
    ...detectTestChanges(files, merged),
    ...detectDependencyChanges(files),
    ...detectMigrationChanges(files, config.migrationPaths ?? defaultMigrationPaths),
    ...detectAgentSignals(pr),
    ...detectSecretLikeValues(files, merged)
  ];
}

export function detectorConfigFromPolicy(policy: {
  sensitive_paths?: Record<string, { paths: string[] }>;
  database?: { migrations?: { paths: string[] } };
}): DetectorPolicyConfig {
  return {
    sensitivePaths: policy.sensitive_paths ?? {},
    migrationPaths: policy.database?.migrations?.paths ?? defaultMigrationPaths,
    ciWorkflowPaths: defaultCiWorkflowPaths
  };
}

export function detectSensitivePathChanges(
  files: ChangedFile[],
  sensitivePaths: Record<string, { paths: string[] }>,
  agentAssisted = false
): VerifiedFact[] {
  const facts: VerifiedFact[] = [];
  for (const file of files) {
    for (const [ruleId, rule] of Object.entries(sensitivePaths)) {
      if (ruleId === "ci_and_deploy") {
        continue;
      }
      if (matchesAnyPath(file.filename, rule.paths)) {
        facts.push(
          makeFact({
            type: "sensitive_path_changed",
            source: "github_diff",
            path: file.filename,
            evidence: `Changed path matched ${ruleId} policy: ${file.filename}`,
            confidence: "verified",
            severity: "high",
            metadata: { ruleId, agentAssisted }
          })
        );
      }
    }
  }
  return dedupeFacts(facts);
}

export function detectCiWorkflowChanges(
  files: ChangedFile[],
  paths: string[] = defaultCiWorkflowPaths,
  agentAssisted = false
): VerifiedFact[] {
  return dedupeFacts(
    files
      .filter((file) => matchesAnyPath(file.filename, paths))
      .map((file) =>
        makeFact({
          type: "ci_workflow_changed",
          source: "github_diff",
          path: file.filename,
          evidence: `CI or deployment path changed: ${file.filename}`,
          confidence: "verified",
          severity: "high",
          metadata: { ruleId: "ci_and_deploy", agentAssisted }
        })
      )
  );
}

export function detectTestChanges(
  files: ChangedFile[],
  options: DetectorOptions = {}
): VerifiedFact[] {
  const merged = { ...defaultOptions, ...options };
  const facts: VerifiedFact[] = [];
  for (const file of files) {
    const isTest = matchesAnyPath(file.filename, testFilePatterns);
    if (file.status === "removed" && isTest) {
      facts.push(
        makeFact({
          type: "test_deleted",
          source: "github_diff",
          path: file.filename,
          evidence: `Deleted test file: ${file.filename}`,
          confidence: "verified",
          severity: "high"
        })
      );
    }

    const patch = boundedPatch(file.patch, merged.maxPatchBytes);
    for (const pattern of skipPatterns) {
      if (patch.includes(`+${pattern}`) || patch.includes(`+ ${pattern}`)) {
        facts.push(
          makeFact({
            type: "test_skipped",
            source: "github_diff",
            path: file.filename,
            evidence: `Detected common test-weakening pattern: ${pattern}`,
            confidence: "observed",
            severity: "high",
            metadata: { pattern }
          })
        );
      }
    }

    const coverageDrop = detectCoverageThresholdDrop(patch);
    if (coverageDrop) {
      facts.push(
        makeFact({
          type: "coverage_threshold_reduced",
          source: "github_diff",
          path: file.filename,
          evidence: `Coverage threshold reduced from ${coverageDrop.before} to ${coverageDrop.after}`,
          confidence: "observed",
          severity: "high",
          metadata: coverageDrop
        })
      );
    }

    if (isTest && detectAssertionWeakening(patch)) {
      facts.push(
        makeFact({
          type: "suspicious_test_change",
          source: "github_diff",
          path: file.filename,
          evidence: "Detected common test-weakening pattern in assertions",
          confidence: "inferred",
          severity: "medium"
        })
      );
    }
  }
  return dedupeFacts(facts);
}

export function detectDependencyChanges(files: ChangedFile[]): VerifiedFact[] {
  const facts: VerifiedFact[] = [];
  for (const file of files) {
    if (file.filename.endsWith("package.json")) {
      facts.push(...detectPackageJsonDependencyChanges(file));
    } else if (file.filename.endsWith("requirements.txt")) {
      facts.push(...detectRequirementsChanges(file));
    } else if (
      ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "poetry.lock"].some((name) =>
        file.filename.endsWith(name)
      )
    ) {
      if (!file.previousContent && !file.currentContent && file.status !== "removed") {
        facts.push(
          makeFact({
            type: "dependency_bumped",
            source: "manifest_parser",
            path: file.filename,
            evidence: `Lockfile changed: ${file.filename}`,
            confidence: "observed",
            severity: "low",
            metadata: { lockfileOnly: true }
          })
        );
      }
    }
  }
  return dedupeFacts(facts);
}

export function detectMigrationChanges(
  files: ChangedFile[],
  paths: string[] = defaultMigrationPaths
): VerifiedFact[] {
  return dedupeFacts(
    files
      .filter((file) => file.status === "added" && matchesAnyPath(file.filename, paths))
      .map((file) =>
        makeFact({
          type: "migration_added",
          source: "github_diff",
          path: file.filename,
          evidence: `Database migration added: ${file.filename}`,
          confidence: "verified",
          severity: "high"
        })
      )
  );
}

export function detectAgentSignals(pr: PullRequestInput): VerifiedFact[] {
  const facts: VerifiedFact[] = [];
  const author = pr.authorLogin.toLowerCase();
  if (author.endsWith("[bot]") || author.includes("bot")) {
    facts.push(
      agentSignal("bot_author", `PR author appears to be an automation account: ${pr.authorLogin}`)
    );
  }
  if (/^(ai|agent|copilot|cursor|codex)\//i.test(pr.headBranch)) {
    facts.push(
      agentSignal(
        "branch_pattern",
        `Branch matched configured agent-assistance pattern: ${pr.headBranch}`
      )
    );
  }
  const label = (pr.labels ?? []).find((item) =>
    /ai-assisted|agent-generated|copilot|cursor|codex/i.test(item)
  );
  if (label) {
    facts.push(agentSignal("ai_label", `Label indicates agent assistance: ${label}`));
  }
  const commit = pr.commits?.find((item) =>
    /generated by|co-authored-by:.*(copilot|codex|cursor)/i.test(item.message)
  );
  if (commit) {
    facts.push(
      agentSignal("commit_metadata", `Commit metadata indicates agent assistance: ${commit.sha}`)
    );
  }
  if (/ai assisted:\s*yes/i.test(pr.body ?? "")) {
    facts.push(agentSignal("pr_body_marker", "PR body declares AI assisted: yes"));
  }
  if (pr.markedAgentAssistedBy) {
    facts.push(
      makeFact({
        type: "agent_signal_detected",
        source: "user_attestation",
        evidence: `Agent assistance attested by ${pr.markedAgentAssistedBy}`,
        confidence: "attested",
        severity: "medium",
        metadata: { signal: "user_declaration" }
      })
    );
  }
  return dedupeFacts(facts);
}

export function detectSecretLikeValues(
  files: ChangedFile[],
  options: DetectorOptions = {}
): VerifiedFact[] {
  const merged = { ...defaultOptions, ...options };
  const facts: VerifiedFact[] = [];
  for (const file of files) {
    const additions = addedLines(boundedPatch(file.patch, merged.maxPatchBytes));
    const found = detectSecrets(additions);
    for (const match of found) {
      facts.push(
        makeFact({
          type: "secret_like_value_detected",
          source: "github_diff",
          path: file.filename,
          evidence: `Secret-like ${match.kind} detected in ${file.filename}: ${redactSecrets(match.value)}`,
          confidence: "observed",
          severity: "critical",
          metadata: { kind: match.kind, patch: redactSecrets(additions) }
        })
      );
    }
  }
  return dedupeFacts(facts);
}

function detectPackageJsonDependencyChanges(file: ChangedFile): VerifiedFact[] {
  if (!file.currentContent) {
    return [];
  }
  const before = parsePackageJsonDeps(file.previousContent ?? "{}");
  const after = parsePackageJsonDeps(file.currentContent);
  const facts: VerifiedFact[] = [];

  for (const [name, version] of Object.entries(after)) {
    const previous = before[name];
    if (!previous) {
      facts.push(
        makeFact({
          type: "dependency_added",
          source: "manifest_parser",
          path: file.filename,
          evidence: `${name}@${version}`,
          confidence: "verified",
          severity: "medium",
          metadata: { package: name, version }
        })
      );
    } else if (previous !== version) {
      const beforeSemver = coerceVersion(previous);
      const afterSemver = coerceVersion(version);
      const major = beforeSemver && afterSemver && afterSemver.major > beforeSemver.major;
      facts.push(
        makeFact({
          type: "dependency_bumped",
          source: "manifest_parser",
          path: file.filename,
          evidence: `${name} changed from ${previous} to ${version}`,
          confidence: "verified",
          severity: major ? "high" : "medium",
          metadata: {
            package: name,
            before: previous,
            after: version,
            majorVersionBump: Boolean(major)
          }
        })
      );
    }
  }
  return facts;
}

function detectRequirementsChanges(file: ChangedFile): VerifiedFact[] {
  const before = parseRequirements(file.previousContent ?? "");
  const after = parseRequirements(file.currentContent ?? "");
  const facts: VerifiedFact[] = [];
  for (const [name, version] of after.entries()) {
    const previous = before.get(name);
    if (!previous) {
      facts.push(
        makeFact({
          type: "dependency_added",
          source: "manifest_parser",
          path: file.filename,
          evidence: version ? `${name}==${version}` : name,
          confidence: "verified",
          severity: "medium",
          metadata: { package: name, version }
        })
      );
    } else if (version && previous !== version) {
      const beforeSemver = coerceVersion(previous);
      const afterSemver = coerceVersion(version);
      const major = beforeSemver && afterSemver && afterSemver.major > beforeSemver.major;
      facts.push(
        makeFact({
          type: "dependency_bumped",
          source: "manifest_parser",
          path: file.filename,
          evidence: `${name} changed from ${previous} to ${version}`,
          confidence: "verified",
          severity: major ? "high" : "medium",
          metadata: {
            package: name,
            before: previous,
            after: version,
            majorVersionBump: Boolean(major)
          }
        })
      );
    }
  }
  return facts;
}

function parsePackageJsonDeps(content: string): Record<string, string> {
  try {
    const json = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return {
      ...(json.dependencies ?? {}),
      ...(json.devDependencies ?? {}),
      ...(json.optionalDependencies ?? {})
    };
  } catch {
    return {};
  }
}

function parseRequirements(content: string): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)(?:==|>=|~=|<=|>|<)?([^;\s#]+)?/.exec(trimmed);
    if (match?.[1]) {
      result.set(match[1].toLowerCase(), match[2]);
    }
  }
  return result;
}

function detectCoverageThresholdDrop(patch: string): { before: number; after: number } | undefined {
  const removed = [
    ...patch.matchAll(
      /^-\s*"?(?:branches|functions|lines|statements|coverage)"?\s*[:=]\s*(\d{1,3})/gm
    )
  ]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  const added = [
    ...patch.matchAll(
      /^\+\s*"?(?:branches|functions|lines|statements|coverage)"?\s*[:=]\s*(\d{1,3})/gm
    )
  ]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  for (const before of removed) {
    for (const after of added) {
      if (after < before) {
        return { before, after };
      }
    }
  }
  return undefined;
}

function detectAssertionWeakening(patch: string): boolean {
  return (
    /^-\s*expect\(.+\)\.(?:toEqual|toBe|toContain|toThrow)/m.test(patch) &&
    /^\+\s*(?:expect\(.+\)\.not\.|\/\/|#)/m.test(patch)
  );
}

function addedLines(patch = ""): string {
  return patch
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function boundedPatch(patch: string | undefined, maxPatchBytes: number): string {
  if (!patch) {
    return "";
  }
  return patch.length > maxPatchBytes ? patch.slice(0, maxPatchBytes) : patch;
}

function matchesAnyPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}

function agentSignal(signal: string, evidence: string): VerifiedFact {
  return makeFact({
    type: "agent_signal_detected",
    source: "github_metadata",
    evidence,
    confidence: "observed",
    severity: "medium",
    metadata: { signal }
  });
}

function coerceVersion(version: string): semver.SemVer | null {
  return semver.coerce(version.replace(/^[~^]/, ""));
}

function makeFact(input: {
  type: VerifiedFact["type"];
  source: VerifiedFact["source"];
  evidence: string;
  confidence: VerifiedFact["confidence"];
  path?: string;
  severity?: FindingSeverity;
  metadata?: Record<string, unknown>;
}): VerifiedFact {
  const basis = `${input.type}:${input.source}:${input.path ?? ""}:${input.evidence}`;
  const fact: VerifiedFact = {
    id: `fact_${createHash("sha1").update(basis).digest("hex").slice(0, 12)}`,
    type: input.type,
    source: input.source,
    evidence: summarizeSafeSnippet(input.evidence),
    confidence: input.confidence
  };
  if (input.path) {
    fact.path = input.path;
  }
  if (input.severity) {
    fact.severity = input.severity;
  }
  if (input.metadata) {
    fact.metadata = input.metadata;
  }
  return fact;
}

function dedupeFacts(facts: VerifiedFact[]): VerifiedFact[] {
  return [...new Map(facts.map((fact) => [fact.id, fact])).values()];
}
