import { loadConfig } from "@agentforge/config";

export type GitHubOAuthRuntime = {
  clientId: string | undefined;
  clientSecret: string | undefined;
  sessionSecret: string | undefined;
  secureCookies: boolean;
  organizationId: string;
  accessEnv: {
    AGENTFORGE_GITHUB_ADMIN_LOGINS: string | undefined;
    AGENTFORGE_GITHUB_ALLOWED_LOGINS: string | undefined;
  };
};

let cachedRuntime: GitHubOAuthRuntime | undefined;

export function githubOAuthRuntime(env: NodeJS.ProcessEnv = process.env): GitHubOAuthRuntime {
  if (env === process.env && cachedRuntime) {
    return cachedRuntime;
  }
  const config = loadConfig(env);
  const runtime = {
    clientId: config.github.clientId,
    clientSecret: config.github.clientSecret,
    sessionSecret: config.sessionSecret,
    secureCookies: config.nodeEnv === "production",
    organizationId: config.dashboard.organizationId ?? "org_local",
    accessEnv: {
      AGENTFORGE_GITHUB_ADMIN_LOGINS: config.github.adminLogins,
      AGENTFORGE_GITHUB_ALLOWED_LOGINS: config.github.allowedLogins
    }
  };
  if (env === process.env) {
    cachedRuntime = runtime;
  }
  return runtime;
}
