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
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === undefined || value === "") {
      return undefined;
    }
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
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
  GITHUB_WEBHOOK_SECRET: optionalStringFromEnv,
  ALLOW_UNSIGNED_GITHUB_WEBHOOKS: booleanFromEnv.default(false),
  GITHUB_CLIENT_ID: optionalStringFromEnv,
  GITHUB_CLIENT_SECRET: optionalStringFromEnv,
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
  SESSION_SECRET: optionalStringFromEnv
});

export type AgentForgeConfig = {
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  nodeEnv: "development" | "test" | "production";
  github: {
    appId: string | undefined;
    privateKey: string | undefined;
    webhookSecret: string | undefined;
    allowUnsignedWebhooks: boolean;
    clientId: string | undefined;
    clientSecret: string | undefined;
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
      webhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
      allowUnsignedWebhooks: parsed.ALLOW_UNSIGNED_GITHUB_WEBHOOKS ?? false,
      clientId: parsed.GITHUB_CLIENT_ID,
      clientSecret: parsed.GITHUB_CLIENT_SECRET
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
    sessionSecret: parsed.SESSION_SECRET
  };
  validateProductionConfig(config);
  return config;
}

function validateProductionConfig(config: AgentForgeConfig): void {
  if (config.nodeEnv !== "production") {
    return;
  }
  const errors: string[] = [];
  if (!config.github.webhookSecret) {
    errors.push("GITHUB_WEBHOOK_SECRET is required in production.");
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
  if (errors.length > 0) {
    throw new Error(`Unsafe AgentForge production configuration: ${errors.join(" ")}`);
  }
}

function withDotEnvDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env !== process.env) {
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

function parseDotEnv(content: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
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
