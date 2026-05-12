import { z } from "zod";
import type { PolicyMode } from "@agentforge/core";

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

const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  DEFAULT_POLICY_MODE: z.enum(["observe", "warn", "enforce"]).default("observe"),
  SOURCE_CODE_STORAGE: booleanFromEnv.default(false),
  FULL_DIFF_RETENTION: z.enum(["disabled", "7d", "30d", "custom"]).default("disabled"),
  REDACT_SECRETS: booleanFromEnv.default(true),
  LLM_FEATURES: booleanFromEnv.default(false),
  AUDIT_RECORD_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  EXPORT_STORAGE_BUCKET: z.string().optional(),
  EXPORT_STORAGE_REGION: z.string().optional(),
  SESSION_SECRET: z.string().optional()
});

export type AgentForgeConfig = {
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  nodeEnv: "development" | "test" | "production";
  github: {
    appId: string | undefined;
    privateKey: string | undefined;
    webhookSecret: string | undefined;
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
  const parsed = envSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    nodeEnv: parsed.NODE_ENV,
    github: {
      appId: parsed.GITHUB_APP_ID,
      privateKey: parsed.GITHUB_APP_PRIVATE_KEY,
      webhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
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
}
