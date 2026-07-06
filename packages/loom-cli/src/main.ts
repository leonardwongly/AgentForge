/**
 * CLI command dispatch + flag parsing, with all side effects behind {@link CliIo}
 * so it is unit-testable with in-memory files and a fake GitReader.
 */
import type { GitReader } from "@agentforge/loom-git-bridge";
import { generateKeyPair, type DsseEnvelope } from "@agentforge/loom-provenance";
import { ratify, verifyAttestation, type RatifyRequest, type SignOptions } from "./engine.js";
import { formatRatify, formatVerify } from "./format.js";

export interface CliIo {
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string) => void;
  readonly makeReader: (repoDir: string) => GitReader;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
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
  "usage: loom <ratify|verify> [flags]",
  "  ratify --repo <dir> --base <ref> --head <ref> --policy <file>",
  "         [--sign [--out <file>] [--pubkey-out <file>] [--did <did>] [--policy-version <v>]]",
  "         [--space <id>] [--line <ref>] [--proposal <id>] [--title <t>] [--author <login>]",
  "  verify --repo <dir> --head <ref> --env <file> --pubkey <file>"
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
    io.error(USAGE);
    return command === undefined || command === "--help" || command === "help" ? 0 : 2;
  } catch (err) {
    io.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

async function runRatify(flags: Flags, io: CliIo): Promise<number> {
  const reader = io.makeReader(requireString(flags, "repo"));
  const policyYaml = io.readFile(requireString(flags, "policy"));
  const wantSign = flags.sign === true || typeof flags.sign === "string";

  const req: RatifyRequest = {
    reader,
    baseRef: requireString(flags, "base"),
    headRef: requireString(flags, "head"),
    policyYaml,
    space: optionalString(flags, "space", "loom/space"),
    lineRef: optionalString(flags, "line", "main"),
    proposalId: optionalString(flags, "proposal", "local"),
    title: optionalString(flags, "title", "Loom Transform"),
    author: optionalString(flags, "author", "unknown"),
    ...(wantSign ? { sign: buildSign(flags, io) } : {})
  };

  const res = await ratify(req);
  io.log(formatRatify(res));
  if (res.envelope) {
    const out = optionalString(flags, "out", "loom-attestation.json");
    io.writeFile(out, JSON.stringify(res.envelope, null, 2));
    io.log(`attestation written: ${out}`);
  }
  return res.evaluation.result.status === "block" ? 1 : 0;
}

async function runVerify(flags: Flags, io: CliIo): Promise<number> {
  const reader = io.makeReader(requireString(flags, "repo"));
  const envelope = JSON.parse(io.readFile(requireString(flags, "env"))) as DsseEnvelope;
  const publicKeyPem = io.readFile(requireString(flags, "pubkey"));
  const res = await verifyAttestation({
    reader,
    headRef: requireString(flags, "head"),
    envelope,
    publicKeyPem
  });
  io.log(formatVerify(res));
  return res.verdict.ok ? 0 : 1;
}

function buildSign(flags: Flags, io: CliIo): SignOptions {
  const key = generateKeyPair();
  const pubOut = optionalString(flags, "pubkey-out", "loom-attestation.pub.pem");
  io.writeFile(pubOut, key.publicKeyPem);
  io.log(`verification public key written: ${pubOut}`);
  return {
    key,
    checkerDid: optionalString(flags, "did", "did:loom:local-checker"),
    detectorSuiteVersion: optionalString(flags, "suite-version", "loom-ratify@1.1.0"),
    policyVersion: optionalString(flags, "policy-version", "1")
  };
}
