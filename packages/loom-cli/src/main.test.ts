import type { GitReader } from "@agentforge/loom-git-bridge";
import { describe, expect, it } from "vitest";
import { createAtomicFileWriter, main, type CliIo } from "./main.js";

interface Sink {
  readonly out: string[];
  readonly err: string[];
}

interface MemoryWriterOptions {
  readonly failInstallTarget?: string;
  readonly occupyInstallTarget?: string;
}

function hasFile(files: Readonly<Record<string, string>>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(files, path);
}

function createMemoryAtomicWriter(
  files: Record<string, string>,
  options: MemoryWriterOptions = {}
): CliIo["writeFilesAtomically"] {
  let nonce = 0;
  return createAtomicFileWriter({
    canonicalPath: (path) => path,
    inspectTarget: (path) => (hasFile(files, path) ? "file" : "missing"),
    temporaryPath: (targetPath, purpose) => `${targetPath}.${purpose}.${nonce++}`,
    writeExclusive: (path, content) => {
      if (hasFile(files, path)) {
        throw new Error(`temporary path already exists: ${path}`);
      }
      files[path] = content;
    },
    installExclusive: (sourcePath, targetPath) => {
      const isStagedInstall = sourcePath.includes(".staged.");
      if (
        isStagedInstall &&
        targetPath === options.occupyInstallTarget &&
        !hasFile(files, targetPath)
      ) {
        files[targetPath] = "concurrent writer";
      }
      if (isStagedInstall && targetPath === options.failInstallTarget) {
        throw new Error("injected second-target failure");
      }
      if (hasFile(files, targetPath)) {
        throw new Error(`exclusive install target already exists: ${targetPath}`);
      }
      const content = files[sourcePath];
      if (content === undefined) {
        throw new Error(`install source does not exist: ${sourcePath}`);
      }
      files[targetPath] = content;
    },
    rename: (sourcePath, targetPath) => {
      const content = files[sourcePath];
      if (content === undefined) {
        throw new Error(`rename source does not exist: ${sourcePath}`);
      }
      files[targetPath] = content;
      delete files[sourcePath];
    },
    remove: (path) => {
      delete files[path];
    }
  });
}

function makeIo(
  files: Record<string, string>,
  sink: Sink,
  writeFilesAtomically: CliIo["writeFilesAtomically"] = createMemoryAtomicWriter(files)
): CliIo {
  return {
    readFile: (path) => {
      const value = files[path];
      if (value === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return value;
    },
    writeFilesAtomically,
    makeReader: (): GitReader => ({
      lsTree: (ref) =>
        Promise.resolve(
          ref === "head" ? [{ path: "README.md", mode: "100644", type: "blob" as const }] : []
        ),
      readFile: () => Promise.resolve("# hello\n")
    }),
    log: (message) => sink.out.push(message),
    error: (message) => sink.err.push(message)
  };
}

const warnPolicy = "version: 1\nagentforge:\n  mode: warn\n  apply_to:\n    - all_pull_requests\n";

describe("loom CLI main", () => {
  it("ratify prints a decision and returns 0 for a passing change", async () => {
    const files: Record<string, string> = { "policy.yaml": warnPolicy };
    const sink: Sink = { out: [], err: [] };
    const code = await main(
      ["ratify", "--repo", ".", "--base", "base", "--head", "head", "--policy", "policy.yaml"],
      makeIo(files, sink)
    );
    expect(code).toBe(0);
    expect(sink.out.join("\n")).toContain("decision: PASS");
  });

  it("ratify and verify round-trip with explicit base and head refs", async () => {
    const files: Record<string, string> = { "policy.yaml": warnPolicy };
    const ratifySink: Sink = { out: [], err: [] };
    const io = makeIo(files, ratifySink);
    const ratifyCode = await main(
      [
        "ratify",
        "--repo",
        ".",
        "--base",
        "base",
        "--head",
        "head",
        "--policy",
        "policy.yaml",
        "--sign",
        "--out",
        "attestation.json",
        "--pubkey-out",
        "attestation.pub.pem"
      ],
      io
    );
    expect(ratifyCode).toBe(0);
    expect(ratifySink.out.join("\n")).toContain("attestation written: attestation.json");
    expect(ratifySink.out.join("\n")).toContain(
      "verification public key written: attestation.pub.pem"
    );

    const verifySink: Sink = { out: [], err: [] };
    const verifyCode = await main(
      [
        "verify",
        "--repo",
        ".",
        "--base",
        "base",
        "--head",
        "head",
        "--env",
        "attestation.json",
        "--pubkey",
        "attestation.pub.pem"
      ],
      makeIo(files, verifySink)
    );

    expect(verifyCode).toBe(0);
    expect(verifySink.out.join("\n")).toContain("attestation: VALID");
    expect(verifySink.out.join("\n")).toContain("base:");
    expect(verifySink.out.join("\n")).toContain("result:");
    expect(verifySink.err).toEqual([]);
  });

  it("performs zero artifact writes when ratification fails before signing", async () => {
    const files: Record<string, string> = {
      "policy.yaml": "version: invalid\n",
      "attestation.json": "previous envelope",
      "attestation.pub.pem": "previous public key"
    };
    const sink: Sink = { out: [], err: [] };
    const memoryWriter = createMemoryAtomicWriter(files);
    let writeCalls = 0;
    const code = await main(
      [
        "ratify",
        "--repo",
        ".",
        "--base",
        "base",
        "--head",
        "head",
        "--policy",
        "policy.yaml",
        "--sign",
        "--out",
        "attestation.json",
        "--pubkey-out",
        "attestation.pub.pem"
      ],
      makeIo(files, sink, (writes) => {
        writeCalls += 1;
        memoryWriter(writes);
      })
    );

    expect(code).toBe(2);
    expect(writeCalls).toBe(0);
    expect(files["attestation.json"]).toBe("previous envelope");
    expect(files["attestation.pub.pem"]).toBe("previous public key");
    expect(sink.out).toEqual([]);
    expect(sink.err.join("\n")).toContain("policy invalid");
  });

  it("restores both prior artifacts when installing the second target fails", async () => {
    const files: Record<string, string> = {
      "policy.yaml": warnPolicy,
      "attestation.json": "previous envelope",
      "attestation.pub.pem": "previous public key"
    };
    const originalPaths = Object.keys(files).sort();
    const sink: Sink = { out: [], err: [] };
    const failingWriter = createMemoryAtomicWriter(files, {
      failInstallTarget: "attestation.pub.pem"
    });
    let writeBatches = 0;
    let batchTargets: string[] = [];

    const code = await main(
      [
        "ratify",
        "--repo",
        ".",
        "--base",
        "base",
        "--head",
        "head",
        "--policy",
        "policy.yaml",
        "--sign",
        "--out",
        "attestation.json",
        "--pubkey-out",
        "attestation.pub.pem"
      ],
      makeIo(files, sink, (writes) => {
        writeBatches += 1;
        batchTargets = writes.map((write) => write.path);
        failingWriter(writes);
      })
    );

    expect(code).toBe(2);
    expect(writeBatches).toBe(1);
    expect(batchTargets).toEqual(["attestation.json", "attestation.pub.pem"]);
    expect(files["attestation.json"]).toBe("previous envelope");
    expect(files["attestation.pub.pem"]).toBe("previous public key");
    expect(Object.keys(files).sort()).toEqual(originalPaths);
    expect(sink.out).toEqual([]);
    expect(sink.err.join("\n")).toContain("injected second-target failure");
  });

  it("does not clobber a concurrently created target and rolls back earlier installs", () => {
    const files: Record<string, string> = { "first.json": "previous first" };
    const writer = createMemoryAtomicWriter(files, {
      occupyInstallTarget: "second.pem"
    });

    expect(() =>
      writer([
        { path: "first.json", content: "new first" },
        { path: "second.pem", content: "new second" }
      ])
    ).toThrow(/exclusive install target already exists/);

    expect(files).toEqual({
      "first.json": "previous first",
      "second.pem": "concurrent writer"
    });
  });

  it("requires --base when verifying an attestation", async () => {
    const sink: Sink = { out: [], err: [] };
    const code = await main(
      ["verify", "--repo", ".", "--head", "head", "--env", "missing", "--pubkey", "missing"],
      makeIo({}, sink)
    );
    expect(code).toBe(2);
    expect(sink.err.join("\n")).toContain("missing required --base <value>");
  });

  it("returns usage error (2) for an unknown command", async () => {
    const sink: Sink = { out: [], err: [] };
    const code = await main(["frobnicate"], makeIo({}, sink));
    expect(code).toBe(2);
    expect(sink.err.join("\n")).toContain("usage:");
  });

  it("returns 2 when a required flag is missing", async () => {
    const sink: Sink = { out: [], err: [] };
    const code = await main(["ratify", "--repo", "."], makeIo({}, sink));
    expect(code).toBe(2);
    expect(sink.err.join("\n")).toContain("missing required");
  });

  it("prints usage and returns 0 for help", async () => {
    const sink: Sink = { out: [], err: [] };
    const code = await main(["help"], makeIo({}, sink));
    expect(code).toBe(0);
    expect(sink.err.join("\n")).toContain("usage:");
    expect(sink.err.join("\n")).toContain(
      "verify --repo <dir> --base <ref> --head <ref> --env <file> --pubkey <file>"
    );
  });
});
