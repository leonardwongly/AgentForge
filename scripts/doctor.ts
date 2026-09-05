/**
 * AgentForge doctor — a single command that validates the full local stack and
 * reports a readiness score. Complements `dev-preflight` by also checking the
 * toolchain (Node, pnpm, git) and summarizing required vs. optional health.
 *
 * Run with: `pnpm doctor`
 */
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  remediation?: string | undefined;
};

export type DoctorReport = {
  checks: DoctorCheck[];
  requiredPassed: number;
  requiredTotal: number;
  optionalPassed: number;
  optionalTotal: number;
  ready: boolean;
};

export const NODE_MINIMUM = "22.13";
export const PNPM_EXPECTED = "11.1.1";

const REQUIRED_SERVICES = [
  {
    name: "Postgres",
    host: "127.0.0.1",
    port: 15432,
    remediation: "Start local services with `docker compose up -d postgres redis minio`."
  },
  {
    name: "Redis",
    host: "127.0.0.1",
    port: 6379,
    remediation: "Start local services with `docker compose up -d postgres redis minio`."
  },
  {
    name: "MinIO",
    host: "127.0.0.1",
    port: 9000,
    required: false,
    remediation:
      "Start MinIO with `docker compose up -d minio` when testing local export or object-storage behavior."
  }
] as const;

export function computeReadinessScore(checks: DoctorCheck[]): DoctorReport {
  const required = checks.filter((check) => check.required);
  const optional = checks.filter((check) => !check.required);
  const requiredPassed = required.filter((check) => check.ok).length;
  const optionalPassed = optional.filter((check) => check.ok).length;
  return {
    checks,
    requiredPassed,
    requiredTotal: required.length,
    optionalPassed,
    optionalTotal: optional.length,
    ready: requiredPassed === required.length
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["AgentForge doctor — stack health check:"];
  for (const check of report.checks) {
    const status = check.ok ? "OK" : check.required ? "FAIL" : "WARN";
    lines.push(`${status} ${check.name}: ${check.detail}`);
    if (!check.ok && check.remediation) {
      lines.push(`  Fix: ${check.remediation}`);
    }
  }
  lines.push(
    `Readiness: ${report.requiredPassed}/${report.requiredTotal} required checks passed` +
      (report.optionalTotal > 0
        ? ` (${report.optionalPassed}/${report.optionalTotal} optional)`
        : "") +
      (report.ready ? " — ready" : " — not ready")
  );
  return lines.join("\n");
}

export async function runDoctor(
  env: Record<string, string | undefined> = process.env
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    checkPnpmVersion(),
    await checkEnvFile(),
    checkGitRepo(),
    checkDockerCli(),
    ...(await Promise.all(REQUIRED_SERVICES.map((service) => checkService(service))))
  ];
  return computeReadinessScore(checks);
}

export function checkNodeVersion(version = process.versions.node ?? ""): DoctorCheck {
  const ok = compareVersions(version, NODE_MINIMUM) >= 0;
  return {
    name: "Node.js",
    ok,
    required: true,
    detail: ok
      ? `v${version} (>= ${NODE_MINIMUM})`
      : `v${version} is below the minimum ${NODE_MINIMUM}`,
    remediation: ok ? undefined : "Install Node.js 22.13 or newer (e.g. via nvm or Homebrew)."
  };
}

export function checkPnpmVersion(): DoctorCheck {
  const result = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 5_000 });
  const version = result.status === 0 ? result.stdout.trim() : "";
  const ok = version === PNPM_EXPECTED;
  return {
    name: "pnpm",
    ok,
    required: true,
    detail: version ? `v${version} (expected ${PNPM_EXPECTED})` : "pnpm is not installed",
    remediation: ok
      ? undefined
      : "Use Corepack: `corepack enable && corepack prepare pnpm@11.1.1 --activate`."
  };
}

async function checkEnvFile(): Promise<DoctorCheck> {
  try {
    await access(".env");
    return { name: ".env", ok: true, required: true, detail: "local configuration file exists" };
  } catch {
    return {
      name: ".env",
      ok: false,
      required: true,
      detail: "local configuration file is missing",
      remediation: "Run `cp .env.example .env`, then review local-only values."
    };
  }
}

export function checkGitRepo(): DoctorCheck {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    timeout: 5_000
  });
  const ok = result.status === 0 && result.stdout.trim() === "true";
  return {
    name: "Git repository",
    ok,
    required: true,
    detail: ok ? "inside a git work tree" : "not inside a git work tree",
    remediation: ok ? undefined : "Clone or initialize the repository before running doctor."
  };
}

export function checkDockerCli(): DoctorCheck {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 5_000
  });
  if (result.status === 0) {
    return {
      name: "Docker",
      ok: true,
      required: true,
      detail: `daemon reachable (${result.stdout.trim() || "version unknown"})`
    };
  }
  const stderr = result.stderr.trim() || result.stdout.trim() || "docker daemon is not reachable";
  return {
    name: "Docker",
    ok: false,
    required: true,
    detail: stderr.replace(/\s+/g, " "),
    remediation:
      "Start Docker Desktop or another Docker-compatible runtime, then run `docker compose up -d postgres redis minio`."
  };
}

async function checkService(service: {
  name: string;
  host: string;
  port: number;
  required?: boolean;
  remediation: string;
}): Promise<DoctorCheck> {
  const reachable = await isPortOpen(service.host, service.port);
  const required = service.required ?? true;
  return {
    name: service.name,
    ok: reachable,
    required,
    detail: reachable
      ? `reachable at ${service.host}:${service.port}`
      : `not reachable at ${service.host}:${service.port}`,
    remediation: reachable ? undefined : service.remediation
  };
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(750);
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

function compareVersions(a: string, b: string): number {
  const parseVersion = (value: string): number[] => {
    if (!/^\d+(?:\.\d+)*$/u.test(value)) {
      return [0];
    }
    const parts = value.split(".").map((part) => Number(part));
    return parts.every((part) => Number.isSafeInteger(part)) ? parts : [0];
  };
  const aParts = parseVersion(a);
  const bParts = parseVersion(b);
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDoctor()
    .then((report) => {
      console.log(formatDoctorReport(report));
      if (!report.ready) {
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
