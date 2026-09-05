import net from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireE2eLock,
  assertDistinctPorts,
  assertNoActiveE2eLock,
  assertNoNextBuildLock,
  assertPortsAvailable,
  assertProductionBuildExists,
  e2eTargets
} from "./e2e-preflight.js";

let temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
  );
  temporaryDirectories = [];
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentforge-e2e-preflight-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("e2e target validation", () => {
  it("uses configured URLs and detects duplicate host/port pairs", () => {
    const targets = e2eTargets({
      APP_BASE_URL: "http://localhost:3210",
      API_BASE_URL: "https://127.0.0.1:4210"
    });
    expect(targets.map((target) => target.url.origin)).toEqual([
      "http://localhost:3210",
      "https://127.0.0.1:4210"
    ]);
    expect(() =>
      assertDistinctPorts([
        { name: "web", url: new URL("http://LOCALHOST:3210/path") },
        { name: "api", url: new URL("https://localhost:3210") }
      ])
    ).toThrow(/both use localhost:3210/u);
    expect(() =>
      assertDistinctPorts([
        { name: "web", url: new URL("http://localhost:3210") },
        { name: "api", url: new URL("http://127.0.0.1:3210") }
      ])
    ).toThrow(/both use localhost:3210/u);
    expect(() =>
      assertDistinctPorts([
        { name: "web", url: new URL("http://localhost:3210") },
        { name: "api", url: new URL("http://[::1]:3210") }
      ])
    ).toThrow(/both use localhost:3210/u);
  });

  it("rejects a currently occupied service port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not expose a TCP address.");
      }
      await expect(
        assertPortsAvailable([{ name: "web", url: new URL(`http://127.0.0.1:${address.port}`) }])
      ).rejects.toThrow(/occupied ports.*web/u);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

describe("e2e build and lock guards", () => {
  it("requires a regular BUILD_ID file rather than accepting a directory", async () => {
    const directory = await temporaryDirectory();
    const buildIdPath = join(directory, "BUILD_ID");

    await expect(assertProductionBuildExists(buildIdPath)).rejects.toThrow(
      /No production web build/u
    );
    await mkdir(buildIdPath);
    await expect(assertProductionBuildExists(buildIdPath)).rejects.toThrow(
      /No production web build/u
    );
    await rm(buildIdPath, { recursive: true, force: true });
    await writeFile(buildIdPath, "build-id\n", "utf8");
    await expect(assertProductionBuildExists(buildIdPath)).resolves.toBeUndefined();
  });

  it("reports an existing Next lock through an injectable candidate list", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "build.lock");
    await writeFile(lockPath, "active", "utf8");
    await expect(assertNoNextBuildLock([lockPath])).rejects.toThrow(/Next build lock exists/u);
    await rm(lockPath);
    await expect(assertNoNextBuildLock([lockPath])).resolves.toBeUndefined();
  });

  it("removes malformed and stale lock files but blocks a live owner", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "e2e.lock");

    await writeFile(lockPath, "not json", "utf8");
    await expect(assertNoActiveE2eLock(lockPath)).resolves.toBeUndefined();

    // A corrupted lock must not make preflight read an unbounded payload.
    await writeFile(lockPath, "x".repeat(16 * 1024), "utf8");
    await expect(assertNoActiveE2eLock(lockPath)).resolves.toBeUndefined();

    await writeFile(lockPath, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER }), "utf8");
    await expect(assertNoActiveE2eLock(lockPath)).resolves.toBeUndefined();

    await writeFile(lockPath, JSON.stringify({ pid: process.pid }), "utf8");
    await expect(assertNoActiveE2eLock(lockPath)).rejects.toThrow(/appears active/u);
    await rm(lockPath);
  });

  it("does not let an old cleanup callback remove a newer run's lock", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "e2e.lock");
    const releaseOld = await acquireE2eLock(lockPath);
    const firstLock = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
    expect(firstLock.token).toEqual(expect.any(String));

    await releaseOld();
    const releaseNew = await acquireE2eLock(lockPath);
    const secondLock = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
    expect(secondLock.token).toEqual(expect.any(String));
    expect(secondLock.token).not.toBe(firstLock.token);

    // Cleanup should be idempotent and ownership-aware.
    await releaseOld();
    await expect(readFile(lockPath, "utf8")).resolves.toContain(secondLock.token!);
    await releaseNew();
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
