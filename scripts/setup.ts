/**
 * AgentForge setup — a single guided command that takes a fresh clone to a
 * seeded, running local stack. It is non-destructive: it never overwrites an
 * existing `.env`, and it only starts and migrates the local backing services.
 *
 * Run with: `pnpm setup`
 */
import { spawnSync } from "node:child_process";
import { access, copyFile } from "node:fs/promises";
import net from "node:net";

import { checkDockerCli, checkNodeVersion, checkPnpmVersion } from "./doctor.js";

type SetupStep = {
  name: string;
  run: () => Promise<void>;
};

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, stdio: "pipe" });
  return {
    ok: result.status === 0,
    output: (result.stdout || "").trim() || (result.stderr || "").trim()
  };
}

async function ensureEnvFile(): Promise<void> {
  try {
    await access(".env");
    console.log("  .env already exists — leaving it untouched.");
    return;
  } catch {
    await copyFile(".env.example", ".env");
    console.log("  Created .env from .env.example. Review local-only values before deploying.");
  }
}

async function startServices(): Promise<void> {
  const result = run("docker", ["compose", "up", "-d", "postgres", "redis", "minio"]);
  if (!result.ok) {
    throw new Error(`Failed to start Docker Compose services: ${result.output}`);
  }
  console.log("  Started postgres, redis, and minio via Docker Compose.");
}

async function waitForPort(host: string, port: number, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isPortOpen(host, port)) {
      console.log(`  ${label} is reachable at ${host}:${port}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} did not become reachable at ${host}:${port} within 60s.`);
}

async function runDbStep(label: string, command: string, args: string[]): Promise<void> {
  const result = run(command, args);
  if (!result.ok) {
    throw new Error(`${label} failed: ${result.output}`);
  }
  console.log(`  ${label} complete.`);
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function runSetup(): Promise<void> {
  console.log("AgentForge setup — taking a fresh clone to a seeded local stack.\n");

  // 1. Prerequisites
  const prereqs = [checkNodeVersion(), checkPnpmVersion(), checkDockerCli()];
  const failed = prereqs.filter((check) => !check.ok);
  if (failed.length > 0) {
    for (const check of failed) {
      console.log(`FAIL ${check.name}: ${check.detail}`);
      if (check.remediation) console.log(`  Fix: ${check.remediation}`);
    }
    throw new Error("Prerequisites are not satisfied; fix the items above and re-run `pnpm setup`.");
  }
  console.log("  Prerequisites OK (Node, pnpm, Docker).");

  const steps: SetupStep[] = [
    { name: "Create .env", run: ensureEnvFile },
    { name: "Start backing services", run: startServices },
    {
      name: "Wait for Postgres",
      run: async () => {
        await waitForPort("127.0.0.1", 15432, "Postgres");
      }
    },
    {
      name: "Wait for Redis",
      run: async () => {
        await waitForPort("127.0.0.1", 6379, "Redis");
      }
    },
    {
      name: "Validate Prisma schema",
      run: async () => {
        await runDbStep("Prisma schema validation", "pnpm", ["prisma:validate"]);
      }
    },
    {
      name: "Run database migrations",
      run: async () => {
        await runDbStep("Database migrations", "pnpm", ["db:migrate"]);
      }
    },
    {
      name: "Seed the database",
      run: async () => {
        await runDbStep("Database seed", "pnpm", ["db:seed"]);
      }
    }
  ];

  for (const step of steps) {
    process.stdout.write(`\n[${step.name}]\n`);
    await step.run();
  }

  console.log("\nSetup complete. Start the stack with `pnpm dev`.");
  console.log("Dashboard: http://localhost:3000  |  API: http://localhost:4000");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSetup()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      console.error(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
