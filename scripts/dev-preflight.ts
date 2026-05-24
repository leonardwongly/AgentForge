import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";

type ServiceCheck = {
  name: string;
  host: string;
  port: number;
  required: boolean;
  remediation: string;
};

type CheckResult = {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  remediation?: string | undefined;
};

const requiredServices: ServiceCheck[] = [
  {
    name: "Postgres",
    host: "127.0.0.1",
    port: 15432,
    required: true,
    remediation: "Start local services with `docker compose up -d postgres redis minio`."
  },
  {
    name: "Redis",
    host: "127.0.0.1",
    port: 6379,
    required: true,
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
];

export async function runDevPreflight(): Promise<CheckResult[]> {
  const [envResult, dockerResult, ...serviceResults] = await Promise.all([
    checkEnvFile(),
    checkDockerCli(),
    ...requiredServices.map(checkService)
  ]);
  return [envResult, dockerResult, ...serviceResults];
}

export function formatPreflightReport(results: CheckResult[]): string {
  const lines = ["AgentForge local dev preflight:"];
  for (const result of results) {
    const status = result.ok ? "OK" : result.required ? "FAIL" : "WARN";
    lines.push(`${status} ${result.name}: ${result.detail}`);
    if (!result.ok && result.remediation) {
      lines.push(`  Fix: ${result.remediation}`);
    }
  }
  return lines.join("\n");
}

export function hasPreflightFailure(results: CheckResult[]): boolean {
  return results.some((result) => result.required && !result.ok);
}

async function checkEnvFile(): Promise<CheckResult> {
  try {
    await access(".env");
    return {
      name: ".env",
      ok: true,
      required: true,
      detail: "local configuration file exists"
    };
  } catch {
    return {
      name: ".env",
      ok: false,
      required: true,
      detail: "local configuration file is missing",
      remediation: "Run `cp .env.example .env`, then review local-only values before starting dev."
    };
  }
}

function checkDockerCli(): CheckResult {
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

async function checkService(service: ServiceCheck): Promise<CheckResult> {
  const reachable = await isPortOpen(service.host, service.port);
  return {
    name: service.name,
    ok: reachable,
    required: service.required,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runDevPreflight()
    .then((results) => {
      console.log(formatPreflightReport(results));
      if (hasPreflightFailure(results)) {
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
