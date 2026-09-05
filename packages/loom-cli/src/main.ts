/**
 * CLI command dispatch + flag parsing, with all side effects behind {@link CliIo}
 * so it is unit-testable with in-memory files and a fake GitReader.
 */
import type { GitReader } from "@agentforge/loom-git-bridge";
import { generateKeyPair, type DsseEnvelope } from "@agentforge/loom-provenance";
import { ratify, verifyAttestation, type RatifyRequest, type SignOptions } from "./engine.js";
import { formatRatify, formatVerify } from "./format.js";
import { initRepo, logRepo, proposeRepo, statusRepo } from "./native.js";
import { mirrorHeadState, restoreDrill, verifyMirrorEquivalence } from "./pilot.js";

export interface AtomicFileWrite {
  readonly path: string;
  readonly content: string;
}

export interface CliIo {
  readonly readFile: (path: string) => string;
  readonly writeFilesAtomically: (writes: readonly AtomicFileWrite[]) => void;
  readonly makeReader: (repoDir: string) => GitReader;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export type AtomicTargetKind = "missing" | "file" | "unsupported";

/** Low-level operations used to make the real filesystem adapter independently testable. */
export interface AtomicWriteOperations {
  readonly canonicalPath: (path: string) => string;
  readonly inspectTarget: (path: string) => AtomicTargetKind;
  readonly temporaryPath: (targetPath: string, purpose: "staged" | "backup") => string;
  readonly writeExclusive: (path: string, content: string) => void;
  /** Atomically installs source at an absent target and must fail if target exists. */
  readonly installExclusive: (sourcePath: string, targetPath: string) => void;
  readonly rename: (sourcePath: string, targetPath: string) => void;
  readonly remove: (path: string) => void;
}

interface PendingFileWrite {
  readonly targetPath: string;
  readonly content: string;
  readonly stagedPath: string;
  readonly backupPath: string;
  readonly hadOriginal: boolean;
  staged: boolean;
  backedUp: boolean;
  installed: boolean;
}

/**
 * Build an all-or-nothing multi-file writer from exclusive-install filesystem operations.
 * Every payload is staged before an existing target is moved or a new target is installed.
 */
export function createAtomicFileWriter(
  operations: AtomicWriteOperations
): CliIo["writeFilesAtomically"] {
  return (writes) => {
    const canonicalTargets = new Set<string>();
    const pending: PendingFileWrite[] = writes.map((write) => {
      const canonicalTarget = operations.canonicalPath(write.path);
      if (canonicalTargets.has(canonicalTarget)) {
        throw new Error(`atomic write has duplicate target: ${write.path}`);
      }
      canonicalTargets.add(canonicalTarget);

      const targetKind = operations.inspectTarget(write.path);
      if (targetKind === "unsupported") {
        throw new Error(`atomic write target is not a regular file: ${write.path}`);
      }
      return {
        targetPath: write.path,
        content: write.content,
        stagedPath: operations.temporaryPath(write.path, "staged"),
        backupPath: operations.temporaryPath(write.path, "backup"),
        hadOriginal: targetKind === "file",
        staged: false,
        backedUp: false,
        installed: false
      };
    });

    try {
      for (const file of pending) {
        operations.writeExclusive(file.stagedPath, file.content);
        file.staged = true;
      }
    } catch (error) {
      throwWithRecoveryErrors(error, removeStagedFiles(pending, operations));
    }

    try {
      for (const file of pending) {
        if (file.hadOriginal) {
          operations.rename(file.targetPath, file.backupPath);
          file.backedUp = true;
        }
      }
      for (const file of pending) {
        operations.installExclusive(file.stagedPath, file.targetPath);
        file.installed = true;
        operations.remove(file.stagedPath);
        file.staged = false;
      }
    } catch (error) {
      throwWithRecoveryErrors(error, rollBackFiles(pending, operations));
    }

    const cleanupErrors: unknown[] = [];
    for (const file of pending) {
      if (!file.backedUp) {
        continue;
      }
      try {
        operations.remove(file.backupPath);
        file.backedUp = false;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "atomic file write committed but cleanup failed");
    }
  };
}

function removeStagedFiles(
  pending: readonly PendingFileWrite[],
  operations: AtomicWriteOperations
): unknown[] {
  const errors: unknown[] = [];
  for (const file of pending) {
    if (!file.staged) {
      continue;
    }
    try {
      operations.remove(file.stagedPath);
      file.staged = false;
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function rollBackFiles(
  pending: readonly PendingFileWrite[],
  operations: AtomicWriteOperations
): unknown[] {
  const errors: unknown[] = [];
  for (const file of [...pending].reverse()) {
    if (file.installed) {
      try {
        operations.remove(file.targetPath);
        file.installed = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (file.backedUp) {
      try {
        operations.installExclusive(file.backupPath, file.targetPath);
        operations.remove(file.backupPath);
        file.backedUp = false;
      } catch (error) {
        errors.push(error);
      }
    }
  }
  errors.push(...removeStagedFiles(pending, operations));
  return errors;
}

function throwWithRecoveryErrors(error: unknown, recoveryErrors: readonly unknown[]): never {
  if (recoveryErrors.length === 0) {
    throw error;
  }
  throw new AggregateError(
    [error, ...recoveryErrors],
    "atomic file write failed and rollback was incomplete"
  );
}

type Flags = Readonly<Record<string, string | boolean | undefined>>;

function parseFlags(args: readonly string[]): Flags {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined || !arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function requireString(flags: Flags, key: string): string {
  const value = flags[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required --${key} <value>`);
  }
  return value;
}

function optionalString(flags: Flags, key: string, fallback: string): string {
  const value = flags[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const USAGE = [
  "usage: loom <ratify|verify|init|status|propose|log|pilot> [flags]",
  "  ratify --repo <dir> --base <ref> --head <ref> --policy <file>",
  "         [--sign [--out <file>] [--pubkey-out <file>] [--did <did>] [--policy-version <v>]]",
  "         [--space <id>] [--line <ref>] [--proposal <id>] [--title <t>] [--author <login>]",
  "  verify --repo <dir> --base <ref> --head <ref> --env <file> --pubkey <file>",
  "  init --repo <dir>",
  "  status --repo <dir>",
  "  propose --repo <dir> --title <t>",
  "  log --repo <dir>",
  "  pilot mirror --repo <dir> --git <gitRepoDir> --message <msg>",
  "  pilot verify --repo <dir> --git <gitRepoDir>",
  "  pilot restore --repo <dir> --backup <backupDir>"
].join("\n");

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  try {
    if (command === "ratify") {
      return await runRatify(flags, io);
    }
    if (command === "verify") {
      return await runVerify(flags, io);
    }
    if (command === "init") {
      io.log(initRepo(requireString(flags, "repo")));
      return 0;
    }
    if (command === "status") {
      io.log(statusRepo(requireString(flags, "repo")));
      return 0;
    }
    if (command === "propose") {
      const title = typeof flags.title === "string" ? flags.title : "untitled";
      io.log(await proposeRepo(requireString(flags, "repo"), title));
      return 0;
    }
    if (command === "log") {
      io.log(logRepo(requireString(flags, "repo")));
      return 0;
    }
    if (command === "pilot") {
      return await runPilot(rest, io);
    }
    io.error(USAGE);
    return command === undefined || command === "--help" || command === "help" ? 0 : 2;
  } catch (err) {
    io.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

async function runRatify(flags: Flags, io: CliIo): Promise<number> {
  const repoDir = requireString(flags, "repo");
  const baseRef = requireString(flags, "base");
  const headRef = requireString(flags, "head");
  const policyPath = requireString(flags, "policy");
  const reader = io.makeReader(repoDir);
  const policyYaml = io.readFile(policyPath);
  const wantSign = flags.sign === true || typeof flags.sign === "string";
  const signing = wantSign ? buildSigningPlan(flags) : undefined;

  const req: RatifyRequest = {
    reader,
    baseRef,
    headRef,
    policyYaml,
    space: optionalString(flags, "space", "loom/space"),
    lineRef: optionalString(flags, "line", "main"),
    proposalId: optionalString(flags, "proposal", "local"),
    title: optionalString(flags, "title", "Loom Transform"),
    author: optionalString(flags, "author", "unknown"),
    ...(signing === undefined ? {} : { sign: signing.options })
  };

  const res = await ratify(req);
  if (signing !== undefined) {
    if (res.envelope === undefined) {
      throw new Error("signing completed without an attestation envelope");
    }
    io.writeFilesAtomically([
      {
        path: signing.envelopePath,
        content: JSON.stringify(res.envelope, null, 2)
      },
      {
        path: signing.publicKeyPath,
        content: signing.options.key.publicKeyPem
      }
    ]);
  }

  io.log(formatRatify(res));
  if (signing !== undefined) {
    io.log(`attestation written: ${signing.envelopePath}`);
    io.log(`verification public key written: ${signing.publicKeyPath}`);
  }
  return res.evaluation.result.status === "block" ? 1 : 0;
}

async function runVerify(flags: Flags, io: CliIo): Promise<number> {
  const repoDir = requireString(flags, "repo");
  const baseRef = requireString(flags, "base");
  const headRef = requireString(flags, "head");
  const envelopePath = requireString(flags, "env");
  const publicKeyPath = requireString(flags, "pubkey");
  const policyVersion = optionalString(flags, "policy-version", "1");
  const reader = io.makeReader(repoDir);
  const envelope = JSON.parse(io.readFile(envelopePath)) as DsseEnvelope;
  const publicKeyPem = io.readFile(publicKeyPath);
  const res = await verifyAttestation({
    reader,
    baseRef,
    headRef,
    envelope,
    publicKeyPem,
    policyVersion
  });
  io.log(formatVerify(res));
  return res.verdict.ok ? 0 : 1;
}

async function runPilot(sub: readonly string[], io: CliIo): Promise<number> {
  const [subcommand, ...subRest] = sub;
  const flags = parseFlags(subRest);
  const repo = requireString(flags, "repo");
  if (subcommand === "mirror") {
    const gitRepo = requireString(flags, "git");
    const message = typeof flags.message === "string" ? flags.message : "loom mirror";
    const result = await mirrorHeadState(repo, gitRepo, message);
    if (!result.equivalent) {
      io.error(
        `mirror diverged: ${result.divergences.map((d) => `${d.path}: ${d.reason}`).join("; ")}`
      );
      io.error(`loom digest ${result.loomDigest} != git digest ${result.gitDigest}`);
      return 1;
    }
    io.log(`mirrored ${result.commitOid} (equivalent, digest ${result.loomDigest})`);
    return 0;
  }
  if (subcommand === "verify") {
    const gitRepo = requireString(flags, "git");
    const result = await verifyMirrorEquivalence(repo, gitRepo);
    if (!result.equivalent) {
      io.error(
        `mirror diverged: ${result.divergences.map((d) => `${d.path}: ${d.reason}`).join("; ")}`
      );
      return 1;
    }
    io.log(`mirror equivalent (digest ${result.loomDigest})`);
    return 0;
  }
  if (subcommand === "restore") {
    const backup = requireString(flags, "backup");
    const result = restoreDrill(repo, backup);
    if (!result.ok) {
      io.error(result.detail);
      return 1;
    }
    io.log(`${result.detail} (${result.linesVerified} Line heads)`);
    return 0;
  }
  io.error(USAGE);
  return 2;
}

interface SigningPlan {
  readonly options: SignOptions;
  readonly envelopePath: string;
  readonly publicKeyPath: string;
}

function buildSigningPlan(flags: Flags): SigningPlan {
  const envelopePath = optionalString(flags, "out", "loom-attestation.json");
  const publicKeyPath = optionalString(flags, "pubkey-out", "loom-attestation.pub.pem");
  if (envelopePath === publicKeyPath) {
    throw new Error("--out and --pubkey-out must identify different files");
  }
  return {
    options: {
      key: generateKeyPair(),
      checkerDid: optionalString(flags, "did", "did:loom:local-checker"),
      detectorSuiteVersion: optionalString(flags, "suite-version", "loom-ratify@1.1.0"),
      policyVersion: optionalString(flags, "policy-version", "1")
    },
    envelopePath,
    publicKeyPath
  };
}
