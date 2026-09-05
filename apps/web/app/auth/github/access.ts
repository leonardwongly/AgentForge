export function dashboardRoleForGitHubLogin(
  login: string,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (typeof login !== "string") {
    return undefined;
  }
  const normalized = login.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const admins = csvSet(env.AGENTFORGE_GITHUB_ADMIN_LOGINS);
  if (admins.has(normalized)) {
    return "platform_admin";
  }
  const allowed = csvSet(env.AGENTFORGE_GITHUB_ALLOWED_LOGINS);
  return allowed.has(normalized) ? "developer" : undefined;
}

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}
