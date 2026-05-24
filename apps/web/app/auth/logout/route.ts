import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DASHBOARD_SESSION_COOKIE, GITHUB_OAUTH_STATE_COOKIE } from "../session";

export async function GET(): Promise<never> {
  const cookieStore = await cookies();
  cookieStore.delete(DASHBOARD_SESSION_COOKIE);
  cookieStore.delete(GITHUB_OAUTH_STATE_COOKIE);
  redirect("/settings?updated=github-logout");
}
