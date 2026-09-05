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
  const [envResult, localActorResult, dockerResult, ...serviceResults] = await Promise.all([
    checkEnvFile(),
    checkLocalActorExposure(),
    checkDockerCli(),
    ...requiredServices.map(checkService)
  ]);
  return [envResult, localActorResult, dockerResult, ...serviceResults];
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

export function checkLocalActorExposure(
  env: Record<string, string | undefined> = process.env
): CheckResult {
  const localActorEnabled =
    env.AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR === "true" ||
    env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS === "true";
  if (!localActorEnabled) {
    return {
      name: "Local actor exposure",
      ok: true,
      required: true,
      detail: "local actor fallback is disabled"
    };
  }

  const configuredUrls = [
    ["APP_BASE_URL", env.APP_BASE_URL ?? "http://localhost:3000"],
    ["NEXT_PUBLIC_APP_URL", env.NEXT_PUBLIC_APP_URL],
    ["API_BASE_URL", env.API_BASE_URL ?? "http://localhost:4000"]
  ] as const;
  const unsafeUrls = configuredUrls.filter(
    ([, value]) => value !== undefined && !isLoopbackUrl(value)
  );
  if (unsafeUrls.length === 0) {
    return {
      name: "Local actor exposure",
      ok: true,
      required: true,
      detail: "local actor fallback is enabled only for loopback URLs"
    };
  }

  return {
    name: "Local actor exposure",
    ok: false,
    required: true,
    detail: `local actor fallback is enabled with non-local URL(s): ${unsafeUrls
      .map(([name, value]) => `${name}=${safeUrlForReport(value)}`)
      .join(", ")}`,
    remediation:
      "Disable local actor fallback/header mode or set APP_BASE_URL, NEXT_PUBLIC_APP_URL, and API_BASE_URL to localhost, 127.0.0.1, or [::1]."
  };
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

function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function safeUrlForReport(value: string | undefined): string {
  if (value === undefined) {
    return "[unset]";
  }
  try {
    const parsed = new URL(value);
    // Preflight output is often copied into CI logs. Keep the useful origin
    // while excluding credentials, query tokens, paths, and fragments that a
    // misconfigured URL could otherwise leak.
    return parsed.origin;
  } catch {
    return "[invalid URL]";
  }
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
