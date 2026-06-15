import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const expectedVersion = "1.0.0";

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
};

const requiredFiles = [
  "README.md",
  "CHANGELOG.md",
  "RELEASE_NOTES.md",
  "LICENSE",
  "NOTICE",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  ".gitleaks.toml",
  "docker-compose.yml",
  "docs/auth.md",
  "docs/github-app-setup.md",
  "docs/release-checklist.md",
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/e2e.yml",
  ".github/workflows/security.yml"
];

const disallowedTrackedPatterns = [
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)playwright-report\//,
  /(^|\/)test-results\//,
  /(^|\/)coverage\//,
  /(^|\/)\.turbo\//,
  /(^|\/)\.playwright-mcp\//,
  /(^|\/)\.gradle\//,
  /(^|\/)local\.properties$/,
  /^apps\/android\/.*\/build\//,
  /^apps\/ios\/.*\/DerivedData\//,
  /^apps\/ios\/.*\.xcuserdata\//,
  /^artifacts\//,
  /(^|\/).+\.(pem|key|p12|pfx)$/,
  /(^|\/).+\.(apk|aab)$/,
  /(^|\/).*\.env\.backup[^/]*$/
];

const secretPatterns = [
  { name: "GitHub token", pattern: /ghp_[A-Za-z0-9_]{20,}/u },
  { name: "GitHub OAuth token", pattern: /gho_[A-Za-z0-9_]{20,}/u },
  { name: "GitHub fine-grained token", pattern: /github_pat_[A-Za-z0-9_]{20,}/u },
  { name: "Slack token", pattern: /xox[bpras]-[0-9]{10,}/u },
  { name: "Stripe live secret key", pattern: /sk_live_[A-Za-z0-9]{20,}/u },
  { name: "Stripe live restricted key", pattern: /rk_live_[A-Za-z0-9]{20,}/u },
  { name: "SendGrid token", pattern: /SG\.[A-Za-z0-9_-]{22,}/u },
  { name: "npm token", pattern: /npm_[A-Za-z0-9]{20,}/u },
  { name: "PyPI token", pattern: /pypi-[A-Za-z0-9_-]{50,}/u },
  { name: "OpenAI API key", pattern: /sk-[A-Za-z0-9]{20,}/u },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/u },
  { name: "Private key block", pattern: new RegExp("-----BEGIN .*PRIVATE " + "KEY-----", "u") }
];

const secretScanExclusions = [
  /^\.github\/workflows\/security\.yml$/,
  /^docs\/security-remediation-execution-plan\.md$/,
  /^fixtures\/repos\/secret-like-token\.json$/,
  /^packages\/security\/src\/redaction\.ts$/
];

function main(): void {
  const checks: CheckResult[] = [
    checkRequiredFiles(),
    checkApacheLicense(),
    checkPackageVersions(),
    checkTrackedArtifacts(),
    checkSecretPatterns(),
    checkLocalComposeBindings(),
    checkSupplyChainWorkflowCoverage(),
    checkReleaseDocsMentionVersion(),
    checkMainWorkflowCoverage(),
    checkPullRequestWorkflowCoverage(),
    checkProductionAuthDocs()
  ];

  for (const check of checks) {
    const prefix = check.ok ? "ok" : "fail";
    console.log(`${prefix} - ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
  }

  const failures = checks.filter((check) => !check.ok);
  if (failures.length > 0) {
    throw new Error(
      `Release readiness check failed: ${failures.map((item) => item.name).join(", ")}`
    );
  }
}

function checkLocalComposeBindings(): CheckResult {
  const compose = readText("docker-compose.yml");
  const requiredBindings = [
    "127.0.0.1:15432:5432",
    "127.0.0.1:6379:6379",
    "127.0.0.1:9000:9000",
    "127.0.0.1:9001:9001"
  ];
  const unsafeBindings = ['"15432:5432"', '"6379:6379"', '"9000:9000"', '"9001:9001"'].filter(
    (binding) => compose.includes(binding)
  );
  const missingBindings = requiredBindings.filter((binding) => !compose.includes(binding));
  const missingLocalWarning =
    !compose.includes("Local development only") ||
    !compose.includes("Do not reuse these credentials");

  const failures = [
    ...missingBindings.map((binding) => `missing ${binding}`),
    ...unsafeBindings.map((binding) => `unsafe ${binding}`),
    ...(missingLocalWarning ? ["missing local credential warning"] : [])
  ];

  return {
    name: "local compose services are loopback-bound",
    ok: failures.length === 0,
    detail: failures.length > 0 ? failures.join(", ") : undefined
  };
}

function checkSupplyChainWorkflowCoverage(): CheckResult {
  const securityWorkflow = readText(".github/workflows/security.yml");
  const dependencyReviewWorkflow = readText(".github/workflows/dependency-review.yml");
  const required = [
    { name: "Gitleaks scan", ok: securityWorkflow.includes("gitleaks detect") },
    {
      name: "Gitleaks config",
      ok: securityWorkflow.includes("--config .gitleaks.toml") && existsSync(".gitleaks.toml")
    },
    {
      name: "moderate audit threshold",
      ok: securityWorkflow.includes("pnpm audit --audit-level moderate")
    },
    {
      name: "blocking dependency review",
      ok: !dependencyReviewWorkflow.includes("continue-on-error")
    },
    {
      name: "dependency license check",
      ok: dependencyReviewWorkflow.includes("license-check: true")
    }
  ];
  const missing = required.filter((item) => !item.ok).map((item) => item.name);
  return {
    name: "secret and dependency review gates are blocking",
    ok: missing.length === 0,
    detail: missing.length > 0 ? `missing ${missing.join(", ")}` : undefined
  };
}

function checkRequiredFiles(): CheckResult {
  const missing = requiredFiles.filter((file) => !existsSync(file));
  return {
    name: "required public release files exist",
    ok: missing.length === 0,
    detail: missing.length > 0 ? `missing ${missing.join(", ")}` : undefined
  };
}

function checkApacheLicense(): CheckResult {
  const license = readText("LICENSE");
  const notice = readText("NOTICE");
  const ok = license.includes("Apache License") && notice.includes("AgentForge");
  return {
    name: "Apache-2.0 license and notice are present",
    ok
  };
}

function checkPackageVersions(): CheckResult {
  const packageFiles = [
    "package.json",
    ...findPackageFiles("apps"),
    ...findPackageFiles("packages")
  ];
  const mismatches = packageFiles.filter((file) => {
    const packageJson = JSON.parse(readText(file)) as { version?: string; private?: boolean };
    return packageJson.version !== expectedVersion || packageJson.private !== true;
  });
  return {
    name: "private workspace packages are versioned for v1.0.0",
    ok: mismatches.length === 0,
    detail: mismatches.length > 0 ? `mismatched ${mismatches.join(", ")}` : undefined
  };
}

function findPackageFiles(directory: string): string[] {
  const ignoredDirectories = new Set([".next", ".turbo", "coverage", "dist", "node_modules"]);
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isFile() && entry.name === "package.json") {
      return [path];
    }
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      return findPackageFiles(path);
    }
    return [];
  });
}

function checkTrackedArtifacts(): CheckResult {
  const trackedFiles = run("git", ["ls-files"]).trim().split("\n").filter(Boolean);
  const badFiles = trackedFiles.filter(
    (file) =>
      !file.endsWith(".env.example") &&
      disallowedTrackedPatterns.some((pattern) => pattern.test(file))
  );
  return {
    name: "local secrets and generated artifacts are not tracked",
    ok: badFiles.length === 0,
    detail: badFiles.length > 0 ? badFiles.join(", ") : undefined
  };
}

function checkSecretPatterns(): CheckResult {
  const trackedFiles = run("git", ["ls-files"]).trim().split("\n").filter(Boolean);
  const findings: string[] = [];
  for (const file of trackedFiles) {
    if (secretScanExclusions.some((pattern) => pattern.test(file))) {
      continue;
    }
    const content = readText(file);
    for (const secret of secretPatterns) {
      if (secret.pattern.test(content)) {
        findings.push(`${file} (${secret.name})`);
      }
    }
  }
  return {
    name: "tracked files do not contain common secret patterns",
    ok: findings.length === 0,
    detail: findings.length > 0 ? findings.join(", ") : undefined
  };
}

function checkReleaseDocsMentionVersion(): CheckResult {
  const changelog = readText("CHANGELOG.md");
  const releaseNotes = readText("RELEASE_NOTES.md");
  const ok =
    changelog.includes("1.0.0") &&
    changelog.includes("2026-05-26") &&
    releaseNotes.includes("v1.0.0") &&
    releaseNotes.includes("Validation");
  return {
    name: "v1.0.0 changelog and release notes are populated",
    ok
  };
}

function checkMainWorkflowCoverage(): CheckResult {
  const workflows = [
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/e2e.yml",
    ".github/workflows/security.yml"
  ];
  const missingPushMain = workflows.filter(
    (file) => !readText(file).includes("branches:\n      - main")
  );
  return {
    name: "required release workflows run on main",
    ok: missingPushMain.length === 0,
    detail:
      missingPushMain.length > 0
        ? `missing main push trigger in ${missingPushMain.join(", ")}`
        : undefined
  };
}

function checkPullRequestWorkflowCoverage(): CheckResult {
  const workflows = [
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/dependency-review.yml",
    ".github/workflows/e2e.yml",
    ".github/workflows/security.yml"
  ];
  const missingPullRequest = workflows.filter((file) => !readText(file).includes("pull_request:"));
  return {
    name: "required workflows run on pull requests",
    ok: missingPullRequest.length === 0,
    detail:
      missingPullRequest.length > 0
        ? `missing pull_request trigger in ${missingPullRequest.join(", ")}`
        : undefined
  };
}

function checkProductionAuthDocs(): CheckResult {
  const docs = [readText("README.md"), readText("docs/auth.md"), readText("SECURITY.md")].join(
    "\n"
  );
  const required = [
    "GitHub OAuth",
    "trusted proxy",
    "SESSION_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "AGENTFORGE_API_PROXY_SECRET",
    "AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR",
    "Do not use local actor"
  ];
  const missing = required.filter((item) => !docs.includes(item));
  return {
    name: "production authentication model is documented",
    ok: missing.length === 0,
    detail: missing.length > 0 ? `missing ${missing.join(", ")}` : undefined
  };
}

function readText(file: string): string {
  return readFileSync(file, "utf8");
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" });
}

main();
