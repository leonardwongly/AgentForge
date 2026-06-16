import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DASHBOARD_SESSION_COOKIE, GITHUB_OAUTH_STATE_COOKIE } from "../session";

// POST-only: a state-changing logout must not be triggerable via a cross-site
// GET (e.g. <img src="/auth/logout">). The settings UI submits a POST form
// and Next.js server-action/form POSTs are same-origin (AF-SEC L5 fix).
export async function POST(): Promise<never> {
  const cookieStore = await cookies();
  cookieStore.delete(DASHBOARD_SESSION_COOKIE);
  cookieStore.delete(GITHUB_OAUTH_STATE_COOKIE);
  redirect("/settings?updated=github-logout");
}
