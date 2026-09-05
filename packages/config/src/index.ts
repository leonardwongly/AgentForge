import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import { z } from "zod";
import type { PolicyMode } from "@agentforge/core";

const LOCAL_DATABASE_URL = "postgresql://agentforge:agentforge@localhost:15432/agentforge";
const LOCAL_REDIS_URL = "redis://localhost:6379";

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value, context) => {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === undefined || value.trim() === "") {
      return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
    context.addIssue({
      code: "custom",
      message: "expected a boolean value (true/false, 1/0, yes/no, or on/off)"
    });
    return z.NEVER;
  });

const optionalStringFromEnv = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

const envSchema = z.object({
  DATABASE_URL: optionalStringFromEnv,
  REDIS_URL: optionalStringFromEnv,
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GITHUB_APP_ID: optionalStringFromEnv,
  GITHUB_APP_PRIVATE_KEY: optionalStringFromEnv,
  GITHUB_INSTALLATION_ID: optionalStringFromEnv,
  GITHUB_WEBHOOK_SECRET: optionalStringFromEnv,
  GITHUB_APP_SLUG: optionalStringFromEnv,
  ALLOW_UNSIGNED_GITHUB_WEBHOOKS: booleanFromEnv.default(false),
  GITHUB_CLIENT_ID: optionalStringFromEnv,
  GITHUB_CLIENT_SECRET: optionalStringFromEnv,
  AGENTFORGE_GITHUB_ADMIN_LOGINS: optionalStringFromEnv,
  AGENTFORGE_GITHUB_ALLOWED_LOGINS: optionalStringFromEnv,
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  DEFAULT_POLICY_MODE: z.enum(["observe", "warn", "enforce", "optimize"]).default("observe"),
  SOURCE_CODE_STORAGE: booleanFromEnv.default(false),
  FULL_DIFF_RETENTION: z.enum(["disabled", "7d", "30d", "custom"]).default("disabled"),
  REDACT_SECRETS: booleanFromEnv.default(true),
  LLM_FEATURES: booleanFromEnv.default(false),
  AUDIT_RECORD_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  EXPORT_STORAGE_BUCKET: optionalStringFromEnv,
  EXPORT_STORAGE_REGION: optionalStringFromEnv,
  SESSION_SECRET: optionalStringFromEnv,
  AGENTFORGE_API_PROXY_SECRET: optionalStringFromEnv,
  AGENTFORGE_DASHBOARD_PROXY_SECRET: optionalStringFromEnv,
  AGENTFORGE_API_TRUST_PROXY_HEADERS: booleanFromEnv.default(false),
  AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS: booleanFromEnv.default(false),
  AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: booleanFromEnv.default(false),
  AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: booleanFromEnv.default(false),
  AGENTFORGE_DASHBOARD_ORGANIZATION: optionalStringFromEnv,
  AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS: booleanFromEnv.default(false),
  NOTIFICATION_WEBHOOK_URL: optionalStringFromEnv,
  AUDIT_STREAM_WEBHOOK_URL: optionalStringFromEnv
});

export type AgentForgeConfig = {
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  nodeEnv: "development" | "test" | "production";
  github: {
    appId: string | undefined;
    privateKey: string | undefined;
    installationId: string | undefined;
    webhookSecret: string | undefined;
    appSlug: string | undefined;
    allowUnsignedWebhooks: boolean;
    clientId: string | undefined;
    clientSecret: string | undefined;
    adminLogins: string | undefined;
    allowedLogins: string | undefined;
  };
  appBaseUrl: string;
  apiBaseUrl: string;
  defaultPolicyMode: PolicyMode;
  sourceCodeStorage: boolean;
  fullDiffRetention: "disabled" | "7d" | "30d" | "custom";
  redactSecrets: boolean;
  llmFeatures: boolean;
  auditRecordRetentionDays: number;
  exportStorageBucket: string | undefined;
  exportStorageRegion: string | undefined;
  sessionSecret: string | undefined;
  notificationWebhookUrl: string | undefined;
  auditStreamWebhookUrl: string | undefined;
  auth: {
    apiTrustProxyHeaders: boolean;
    apiAllowLocalActorHeaders: boolean;
    dashboardTrustProxyHeaders: boolean;
    dashboardAllowLocalActor: boolean;
    proxyStripsIdentityHeaders: boolean;
    apiProxySecret: string | undefined;
    dashboardProxySecret: string | undefined;
  };
  dashboard: {
    organizationId: string | undefined;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentForgeConfig {
  const parsed = envSchema.parse(withDotEnvDefaults(env));
  const localRuntime = parsed.NODE_ENV !== "production";
  const config = {
    databaseUrl: parsed.DATABASE_URL ?? (localRuntime ? LOCAL_DATABASE_URL : undefined),
    redisUrl: parsed.REDIS_URL ?? (localRuntime ? LOCAL_REDIS_URL : undefined),
    nodeEnv: parsed.NODE_ENV,
    github: {
      appId: parsed.GITHUB_APP_ID,
      privateKey: parsed.GITHUB_APP_PRIVATE_KEY,
      installationId: parsed.GITHUB_INSTALLATION_ID,
      webhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
      appSlug: parsed.GITHUB_APP_SLUG,
      allowUnsignedWebhooks: parsed.ALLOW_UNSIGNED_GITHUB_WEBHOOKS ?? false,
      clientId: parsed.GITHUB_CLIENT_ID,
      clientSecret: parsed.GITHUB_CLIENT_SECRET,
      adminLogins: parsed.AGENTFORGE_GITHUB_ADMIN_LOGINS,
      allowedLogins: parsed.AGENTFORGE_GITHUB_ALLOWED_LOGINS
    },
    appBaseUrl: parsed.APP_BASE_URL,
    apiBaseUrl: parsed.API_BASE_URL,
    defaultPolicyMode: parsed.DEFAULT_POLICY_MODE,
    sourceCodeStorage: parsed.SOURCE_CODE_STORAGE ?? false,
    fullDiffRetention: parsed.FULL_DIFF_RETENTION,
    redactSecrets: parsed.REDACT_SECRETS ?? true,
    llmFeatures: parsed.LLM_FEATURES ?? false,
    auditRecordRetentionDays: parsed.AUDIT_RECORD_RETENTION_DAYS,
    exportStorageBucket: parsed.EXPORT_STORAGE_BUCKET,
    exportStorageRegion: parsed.EXPORT_STORAGE_REGION,
    sessionSecret: parsed.SESSION_SECRET,
    notificationWebhookUrl: parsed.NOTIFICATION_WEBHOOK_URL,
    auditStreamWebhookUrl: parsed.AUDIT_STREAM_WEBHOOK_URL,
    auth: {
      apiTrustProxyHeaders: parsed.AGENTFORGE_API_TRUST_PROXY_HEADERS ?? false,
      apiAllowLocalActorHeaders: parsed.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS ?? false,
      dashboardTrustProxyHeaders: parsed.AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS ?? false,
      dashboardAllowLocalActor: parsed.AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR ?? false,
      proxyStripsIdentityHeaders: parsed.AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS ?? false,
      apiProxySecret: parsed.AGENTFORGE_API_PROXY_SECRET,
      dashboardProxySecret: parsed.AGENTFORGE_DASHBOARD_PROXY_SECRET
    },
    dashboard: {
      organizationId: parsed.AGENTFORGE_DASHBOARD_ORGANIZATION
    }
  };
  validateLocalActorExposure(config);
  validateProductionConfig(config);
  return config;
}

function validateLocalActorExposure(config: AgentForgeConfig): void {
  if (!config.auth.apiAllowLocalActorHeaders && !config.auth.dashboardAllowLocalActor) {
    return;
  }
  const errors: string[] = [];
  for (const [name, value] of [
    ["APP_BASE_URL", config.appBaseUrl],
    ["API_BASE_URL", config.apiBaseUrl]
  ] as const) {
    if (!isLoopbackUrl(value)) {
      errors.push(
        `${name} must use localhost, 127.0.0.1, or [::1] when local actor mode is enabled.`
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Unsafe AgentForge local actor configuration: ${errors.join(" ")}`);
  }
}

const MIN_PRODUCTION_SECRET_LENGTH = 32;

const WEAK_SECRET_PLACEHOLDERS = new Set(["changeme", "secret", "password", "test"]);

function normalizeForPlaceholderCheck(secret: string): string {
  return secret.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isWeakPlaceholderSecret(secret: string): boolean {
  const normalized = normalizeForPlaceholderCheck(secret);
  for (const placeholder of WEAK_SECRET_PLACEHOLDERS) {
    let remainder = normalized;
    while (remainder.startsWith(placeholder)) {
      remainder = remainder.slice(placeholder.length);
    }
    const isFullyConsumedOrTrailingPrefix = remainder === "" || placeholder.startsWith(remainder);
    if (normalized.startsWith(placeholder) && isFullyConsumedOrTrailingPrefix) {
      return true;
    }
  }
  return false;
}

function checkProductionSecretStrength(
  envVarName: string,
  secret: string | undefined,
  errors: string[]
): void {
  if (!secret) {
    return;
  }
  if (secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    errors.push(
      `${envVarName} must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production for adequate HMAC key strength.`
    );
    return;
  }
  if (isWeakPlaceholderSecret(secret)) {
    errors.push(`${envVarName} must not use a common placeholder value in production.`);
  }
}

function validateProductionConfig(config: AgentForgeConfig): void {
  if (config.nodeEnv !== "production") {
    return;
  }
  const errors: string[] = [];
  const builtInGithubOAuthConfigured = Boolean(
    config.github.clientId || config.github.clientSecret
  );
  if (!config.github.webhookSecret) {
    errors.push("GITHUB_WEBHOOK_SECRET is required in production.");
  }
  if (!config.databaseUrl) {
    errors.push("DATABASE_URL is required in production for durable tenant-scoped persistence.");
  }
  if (!config.redisUrl) {
    errors.push("REDIS_URL is required in production for durable queues and replay protection.");
  }
  for (const [name, destination] of [
    ["NOTIFICATION_WEBHOOK_URL", config.notificationWebhookUrl],
    ["AUDIT_STREAM_WEBHOOK_URL", config.auditStreamWebhookUrl]
  ] as const) {
    if (destination && !isSecureWebhookUrl(destination)) {
      errors.push(`${name} must use an https URL in production.`);
    }
  }
  checkProductionSecretStrength("GITHUB_WEBHOOK_SECRET", config.github.webhookSecret, errors);
  if (!config.github.appId) {
    errors.push(
      "GITHUB_APP_ID is required in production so AgentForge can mint installation tokens and publish checks."
    );
  }
  if (!config.github.privateKey) {
    errors.push(
      "GITHUB_APP_PRIVATE_KEY is required in production so AgentForge can authenticate as the GitHub App."
    );
  }
  if (builtInGithubOAuthConfigured && !config.github.clientId) {
    errors.push(
      "GITHUB_CLIENT_ID is required in production for built-in GitHub OAuth and installation callback setup."
    );
  }
  if (builtInGithubOAuthConfigured && !config.github.clientSecret) {
    errors.push("GITHUB_CLIENT_SECRET is required in production for built-in GitHub OAuth.");
  }
  if (builtInGithubOAuthConfigured && !config.sessionSecret) {
    errors.push(
      "SESSION_SECRET is required in production for signed dashboard sessions and OAuth state."
    );
  }
  if (builtInGithubOAuthConfigured) {
    checkProductionSecretStrength("SESSION_SECRET", config.sessionSecret, errors);
  }
  if (config.github.allowUnsignedWebhooks) {
    errors.push("ALLOW_UNSIGNED_GITHUB_WEBHOOKS must be false in production.");
  }
  if (config.sourceCodeStorage) {
    errors.push("SOURCE_CODE_STORAGE must remain false in production.");
  }
  if (!config.redactSecrets) {
    errors.push("REDACT_SECRETS must remain true in production.");
  }
  if (!config.auth.apiTrustProxyHeaders) {
    errors.push("AGENTFORGE_API_TRUST_PROXY_HEADERS must be true in production.");
  }
  if (config.auth.apiTrustProxyHeaders && !config.auth.apiProxySecret) {
    errors.push(
      "AGENTFORGE_API_PROXY_SECRET must be configured when AGENTFORGE_API_TRUST_PROXY_HEADERS is enabled."
    );
  }
  if (config.auth.apiTrustProxyHeaders) {
    checkProductionSecretStrength(
      "AGENTFORGE_API_PROXY_SECRET",
      config.auth.apiProxySecret,
      errors
    );
  }
  if (!config.auth.dashboardTrustProxyHeaders) {
    errors.push("AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS must be true in production.");
  }
  if (config.auth.dashboardTrustProxyHeaders && !config.auth.dashboardProxySecret) {
    errors.push(
      "AGENTFORGE_DASHBOARD_PROXY_SECRET must be configured when AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS is enabled so inbound identity headers are cryptographically verified."
    );
  }
  if (config.auth.dashboardTrustProxyHeaders) {
    checkProductionSecretStrength(
      "AGENTFORGE_DASHBOARD_PROXY_SECRET",
      config.auth.dashboardProxySecret,
      errors
    );
  }
  if (config.auth.apiAllowLocalActorHeaders) {
    errors.push("AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS must be false in production.");
  }
  if (config.auth.dashboardAllowLocalActor) {
    errors.push("AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR must be false in production.");
  }
  if (!config.auth.proxyStripsIdentityHeaders) {
    errors.push("AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS must be true in production.");
  }
  if (errors.length > 0) {
    throw new Error(`Unsafe AgentForge production configuration: ${errors.join(" ")}`);
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isSecureWebhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !hostname || parsed.username || parsed.password) {
      return false;
    }
    // HTTPS alone does not prevent SSRF to link-local or loopback services.
    // Deployments should still prefer an explicit destination allowlist; this
    // denylist blocks the common metadata/private-network targets by default.
    if (
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      hostname === "metadata.google.internal" ||
      hostname === "::1" ||
      /^127\./u.test(hostname) ||
      /^10\./u.test(hostname) ||
      /^192\.168\./u.test(hostname) ||
      /^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(hostname) ||
      hostname === "169.254.169.254"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function withDotEnvDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env !== process.env) {
    return env;
  }
  if (env.NODE_ENV === "test" || env.VITEST) {
    return env;
  }
  const dotEnvPath = findDotEnv(cwd());
  if (!dotEnvPath) {
    return env;
  }
  const fromFile = parseDotEnv(readFileSync(dotEnvPath, "utf8"));
  return { ...fromFile, ...env };
}

function findDotEnv(start: string): string | undefined {
  let current = start;
  for (;;) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function parseDotEnv(content: string): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    parsed[key] = unquote(value);
  }
  return parsed;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
