import { randomUUID } from "node:crypto";
import net from "node:net";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type E2eTarget = {
  name: "api" | "web";
  url: URL;
};

export type PreflightOptions = {
  requireBuild?: boolean;
  skipPortCheck?: boolean;
  skipE2eLockCheck?: boolean;
  skipNextLockCheck?: boolean;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(repoRoot, "apps", "web");
const defaultLockPath = join(repoRoot, "node_modules", ".cache", "agentforge", "e2e.lock");
const MAX_LOCK_BYTES = 8 * 1024;
const nextLockCandidates = [
  join(webDir, ".next", "lock"),
  join(webDir, ".next", "build.lock"),
  join(webDir, ".next", "cache", "build.lock")
];

export function e2eTargets(env: NodeJS.ProcessEnv = process.env): E2eTarget[] {
  return [
    {
      name: "web",
      url: new URL(env.APP_BASE_URL ?? "http://127.0.0.1:3100")
    },
    {
      name: "api",
      url: new URL(env.API_BASE_URL ?? "http://127.0.0.1:4100")
    }
  ];
}

export async function runE2ePreflight(
  options: PreflightOptions = {},
  targets = e2eTargets()
): Promise<void> {
  assertDistinctPorts(targets);
  if (!options.skipE2eLockCheck) {
    await assertNoActiveE2eLock(defaultLockPath);
  }
  if (!options.skipNextLockCheck) {
    await assertNoNextBuildLock();
  }
  if (!options.skipPortCheck) {
    await assertPortsAvailable(targets);
  }
  if (options.requireBuild) {
    await assertProductionBuildExists();
  }
}

export function assertDistinctPorts(targets: E2eTarget[]): void {
  const seen = new Map<string, E2eTarget>();
  for (const target of targets) {
    const key = `${targetHostKey(target.url.hostname)}:${urlPort(target.url)}`;
    const existing = seen.get(key);
    if (existing) {
      throw new Error(
        `E2E ${existing.name} and ${target.name} targets both use ` +
          `${existing.url.hostname}:${urlPort(existing.url)}. ` +
          "Set APP_BASE_URL and API_BASE_URL to distinct localhost ports."
      );
    }
    seen.set(key, target);
  }
}

function targetHostKey(hostname: string): string {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
  return ["localhost", "127.0.0.1", "::1"].includes(normalized) ? "loopback" : normalized;
}

export async function assertPortsAvailable(targets: E2eTarget[]): Promise<void> {
  const conflicts: string[] = [];
  for (const target of targets) {
    if (await isPortOpen(target.url.hostname, urlPort(target.url))) {
      conflicts.push(`${target.name} ${target.url.origin}`);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `E2E preflight found occupied ports: ${conflicts.join(", ")}. ` +
        "Stop the existing service or set APP_BASE_URL/API_BASE_URL to unused ports before running pnpm test:e2e."
    );
  }
}

export async function assertNoNextBuildLock(lockPaths = nextLockCandidates): Promise<void> {
  for (const lockPath of lockPaths) {
    if (await fileExists(lockPath)) {
      throw new Error(
        `Next build lock exists at ${lockPath}. ` +
          "Wait for the existing next build to finish, then remove the stale lock only if no build is running."
      );
    }
  }
}

export async function assertProductionBuildExists(
  buildIdPath = join(webDir, ".next", "BUILD_ID")
): Promise<void> {
  if (!(await regularFileExists(buildIdPath))) {
    throw new Error(
      "No production web build was found at apps/web/.next/BUILD_ID. " +
        "Run pnpm --filter @agentforge/web build or use pnpm test:e2e so the build is created under the E2E lock."
    );
  }
}

export async function acquireE2eLock(lockPath = defaultLockPath): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  await removeStaleE2eLock(lockPath);
  const token = randomUUID();
  try {
    await writeFile(
      lockPath,
      JSON.stringify(
        {
          pid: process.pid,
          token,
          command: "pnpm test:e2e",
          createdAt: new Date().toISOString()
        },
        null,
        2
      ),
      { flag: "wx" }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    await assertNoActiveE2eLock(lockPath);
    return acquireE2eLock(lockPath);
  }
  return async () => {
    // A caller may invoke its cleanup more than once, or a long-lived caller
    // may outlive a subsequent run that acquired the same path. Only remove
    // the lock this invocation owns; never delete a newer owner's lock.
    const lock = await readLock(lockPath);
    if (lock?.token !== token) {
      return;
    }
    await rm(lockPath, { force: true });
  };
}

export async function assertNoActiveE2eLock(lockPath = defaultLockPath): Promise<void> {
  const lock = await readLock(lockPath);
  if (!lock) {
    return;
  }
  if (lock.pid && isPidAlive(lock.pid)) {
    throw new Error(
      `Another E2E run appears active with pid ${lock.pid}. ` +
        `If that process is gone, remove ${lockPath} and rerun pnpm test:e2e.`
    );
  }
  await rm(lockPath, { force: true });
}

async function removeStaleE2eLock(lockPath: string): Promise<void> {
  const lock = await readLock(lockPath);
  if (lock && (!lock.pid || !isPidAlive(lock.pid))) {
    await rm(lockPath, { force: true });
  }
}

async function readLock(lockPath: string): Promise<{ pid?: number; token?: string } | undefined> {
  try {
    const metadata = await stat(lockPath);
    if (!metadata.isFile() || metadata.size > MAX_LOCK_BYTES) {
      return {};
    }
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    return {
      ...(typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
        ? { pid: parsed.pid }
        : {}),
      ...(typeof parsed.token === "string" && parsed.token.length > 0
        ? { token: parsed.token }
        : {})
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return {};
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolvePort) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(750);
    socket.once("connect", () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePort(false);
    });
    socket.once("error", () => resolvePort(false));
  });
}

function urlPort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function cliOptions(argv: string[]): PreflightOptions {
  return {
    requireBuild: argv.includes("--require-build"),
    skipPortCheck: argv.includes("--skip-port-check"),
    skipE2eLockCheck: argv.includes("--skip-e2e-lock-check"),
    skipNextLockCheck: argv.includes("--skip-next-lock-check")
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runE2ePreflight(cliOptions(process.argv.slice(2)))
    .then(() => {
      console.log("E2E preflight passed.");
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
