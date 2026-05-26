import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  DASHBOARD_SESSION_COOKIE,
  GITHUB_OAUTH_STATE_COOKIE,
  createDashboardSessionCookie,
  readOauthStateCookie
} from "../../session";
import { dashboardRoleForGitHubLogin } from "../access";
import { githubOAuthRuntime } from "../runtime";

type GitHubTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GitHubUserResponse = {
  login?: string;
};

export async function GET(request: Request): Promise<never> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const { clientId, clientSecret, sessionSecret, secureCookies, organizationId, accessEnv } =
    githubOAuthRuntime();

  if (!sessionSecret || !clientId || !clientSecret) {
    redirect("/settings?error=GitHub%20OAuth%20is%20not%20configured");
  }
  const expectedState = readOauthStateCookie((await headers()).get("cookie"), sessionSecret);

  if (!code || !state || !expectedState || state !== expectedState) {
    redirect("/settings?error=Invalid%20GitHub%20OAuth%20state");
  }

  let login: string | undefined;
  try {
    const token = await exchangeCodeForToken({ clientId, clientSecret, code });
    const user = await loadGitHubUser(token);
    login = user.login;
  } catch {
    redirect("/settings?error=GitHub%20OAuth%20login%20failed");
  }

  if (!login) {
    redirect("/settings?error=GitHub%20OAuth%20did%20not%20return%20a%20login");
  }
  const role = dashboardRoleForGitHubLogin(login, accessEnv);
  if (!role) {
    const requestId = requestIdForLog(request);
    console.warn(
      JSON.stringify({
        errorCode: "UNAUTHORIZED_GITHUB_LOGIN",
        githubLogin: login,
        httpMethod: request.method,
        requestId,
        route: "/auth/github/callback",
        statusCode: 403
      })
    );
    redirect(
      `/settings?error=GitHub%20login%20is%20not%20authorized&requestId=${encodeURIComponent(
        requestId
      )}`
    );
  }

  try {
    const cookieStore = await cookies();
    cookieStore.delete(GITHUB_OAUTH_STATE_COOKIE);
    cookieStore.set(
      DASHBOARD_SESSION_COOKIE,
      createDashboardSessionCookie(
        {
          login,
          role,
          organizationId,
          provider: "github"
        },
        sessionSecret
      ),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookies,
        path: "/",
        maxAge: 60 * 60 * 8
      }
    );
  } catch {
    redirect("/settings?error=GitHub%20OAuth%20login%20failed");
  }

  redirect("/settings?updated=github-login");
}

async function exchangeCodeForToken(input: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code
    }),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = (await response.json()) as GitHubTokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? "GitHub OAuth token failed");
  }
  return payload.access_token;
}

function requestIdForLog(request: Request): string {
  const requestId = request.headers.get("x-request-id")?.trim();
  if (requestId && requestId.length <= 128) {
    return requestId;
  }
  return crypto.randomUUID();
}

async function loadGitHubUser(token: string): Promise<GitHubUserResponse> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "AgentForge"
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error("GitHub user lookup failed");
  }
  return (await response.json()) as GitHubUserResponse;
}
