import { loadConfig } from "../packages/config/src/index.ts";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "../packages/detectors/src/index.ts";
import {
  createGithubClient,
  createGithubInstallationToken,
  fetchPullRequestInputFromGithub,
  publishMergeGuardCheckWithClient
} from "../packages/github/src/index.ts";
import {
  evaluateMergeGuard,
  getPolicyPack,
  parsePolicyYaml
} from "../packages/policy/src/index.ts";
import { redactSecrets } from "../packages/security/src/index.ts";

type SmokeOptions = {
  owner?: string | undefined;
  repo?: string | undefined;
  pull?: number | undefined;
  installationId?: string | undefined;
  publishCheck: boolean;
  help: boolean;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const config = loadConfig();
  options.installationId ??= config.github.installationId;
  validateOptions(options);
  const missing = [
    ["GITHUB_APP_ID", config.github.appId],
    ["GITHUB_APP_PRIVATE_KEY", config.github.privateKey],
    ["GITHUB_INSTALLATION_ID or --installation-id", options.installationId]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing GitHub App smoke-test configuration: ${missing.join(", ")}.`);
  }

  const token = await createGithubInstallationToken({
    appId: config.github.appId!,
    privateKey: config.github.privateKey!,
    installationId: options.installationId!
  });
  const client = createGithubClient(token);
  const pr = await fetchPullRequestInputFromGithub({
    client,
    owner: options.owner!,
    repo: options.repo!,
    pullNumber: options.pull!
  });
  const policyYaml = getPolicyPack("fintech")?.contentYaml;
  if (!policyYaml) {
    throw new Error("Built-in fintech policy pack is unavailable.");
  }
  const parsed = parsePolicyYaml(policyYaml);
  if (parsed.errors.length > 0) {
    throw new Error(`Built-in fintech policy pack is invalid: ${parsed.errors.join("; ")}`);
  }

  const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
  const result = evaluateMergeGuard(pr, facts, parsed.config);
  const published = options.publishCheck
    ? await publishMergeGuardCheckWithClient({
        client,
        owner: options.owner!,
        repo: options.repo!,
        pr,
        result
      })
    : undefined;

  console.log(
    JSON.stringify(
      {
        repository: `${options.owner}/${options.repo}`,
        pullRequestNumber: options.pull,
        installationId: options.installationId,
        mode: result.mode,
        status: result.status,
        checkConclusion: published?.conclusion,
        checkPublished: Boolean(published),
        checkRunId: published?.id,
        changedFileCount: pr.changedFiles.length,
        reviewCount: pr.reviews?.length ?? 0,
        findingCount: result.findings.length,
        missingEvidenceCount: result.requiredEvidence.filter((item) => item.status === "missing")
          .length,
        pendingReviewerCount: result.requiredReviewers.filter((item) => !item.approved).length,
        note: options.publishCheck
          ? "Published AgentForge Merge Guard check run."
          : "Read-only smoke completed. Re-run with --publish-check to publish the check run."
      },
      null,
      2
    )
  );
}

function parseArgs(argv: string[]): SmokeOptions {
  const options: SmokeOptions = {
    publishCheck: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inlineValue] = arg.split("=", 2);
    const readValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}.`);
      }
      index += 1;
      return value;
    };

    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--owner") {
      options.owner = readValue();
    } else if (flag === "--repo") {
      options.repo = readValue();
    } else if (flag === "--pull") {
      options.pull = parsePositiveInteger(readValue(), "--pull");
    } else if (flag === "--installation-id") {
      options.installationId = readValue();
    } else if (flag === "--publish-check") {
      options.publishCheck = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function validateOptions(options: SmokeOptions): asserts options is SmokeOptions & {
  owner: string;
  repo: string;
  pull: number;
} {
  const errors: string[] = [];
  if (!options.owner || !isSafeGithubName(options.owner)) {
    errors.push("--owner must be a GitHub owner or organization name.");
  }
  if (!options.repo || !isSafeGithubName(options.repo)) {
    errors.push("--repo must be a GitHub repository name.");
  }
  if (!options.pull) {
    errors.push("--pull must be a positive pull request number.");
  }
  if (options.installationId && !/^\d+$/u.test(options.installationId)) {
    errors.push("--installation-id must be a numeric GitHub installation ID.");
  }
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed.toString() !== value) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function isSafeGithubName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/u.test(value);
}

function printUsage(): void {
  console.log(`Usage: pnpm github:smoke --owner <owner> --repo <repo> --pull <number> [options]

Options:
  --installation-id <id>  GitHub App installation ID. Defaults to GITHUB_INSTALLATION_ID.
  --publish-check        Publish the AgentForge Merge Guard check run. Default is read-only.
  --help                 Show this help text.

Required environment:
  GITHUB_APP_ID
  GITHUB_APP_PRIVATE_KEY
  GITHUB_INSTALLATION_ID or --installation-id

By default this command fetches PR facts, evaluates the built-in fintech policy, and prints only
metadata counts. It does not print source code, patches, credentials, or installation tokens.`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactSecrets(message));
  process.exitCode = 1;
});
