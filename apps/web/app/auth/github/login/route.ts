import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { GITHUB_OAUTH_STATE_COOKIE, createOauthStateCookie } from "../../session";
import { githubOAuthRuntime } from "../runtime";

export async function GET(): Promise<never> {
  const { clientId, sessionSecret, secureCookies } = githubOAuthRuntime();
  if (!clientId || !sessionSecret) {
    redirect("/settings?error=GitHub%20OAuth%20is%20not%20configured");
  }

  const { state, value } = createOauthStateCookie(sessionSecret);
  const cookieStore = await cookies();
  cookieStore.set(GITHUB_OAUTH_STATE_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: "/",
    maxAge: 10 * 60
  });

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", "read:user");
  redirect(authorizeUrl.toString());
}
