import Link from "next/link";
import { redirect } from "next/navigation";
import { GitBranch, ShieldCheck } from "lucide-react";
import { apiActorHeaders } from "../../../settings/api-actor-headers";
import { resolveDashboardActor } from "../../../settings/actor";

type GitHubInstallationCallbackProps = {
  searchParams?: Promise<{
    installation_id?: string;
    setup_action?: string;
  }>;
};

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

export default async function GitHubInstallationCallback({
  searchParams
}: GitHubInstallationCallbackProps) {
  const params = await searchParams;
  const installationId = params?.installation_id;
  let verificationFailure =
    "Sign in as a platform admin, then record and approve the installation.";
  if (!installationId) {
    return (
      <section className="page">
        <section className="notice notice--unavailable">
          <GitBranch size={18} aria-hidden="true" />
          <div>
            <h1>GitHub installation was not recorded</h1>
            <p>GitHub did not return an installation ID. Start the install flow again.</p>
            <Link className="button" href="/settings">
              Return to settings
            </Link>
          </div>
        </section>
      </section>
    );
  }

  try {
    const actor = await resolveDashboardActor();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(`${apiBaseUrl}/api/github/installations/verify`, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...apiActorHeaders(actor)
      },
      body: JSON.stringify({
        githubInstallationId: installationId,
        accountType: "Organization"
      })
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) {
      throw new Error("GitHub installation verification failed");
    }
  } catch (error) {
    if (isAbortError(error)) {
      verificationFailure =
        "Installation verification timed out. Open Settings and record the installation manually.";
    }
    return (
      <section className="page">
        <section className="notice notice--unavailable">
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <h1>Admin approval is required</h1>
            <p>
              {verificationFailure} Installation ID: {installationId}.
            </p>
            <Link className="button button--primary" href="/settings">
              Open settings
            </Link>
          </div>
        </section>
      </section>
    );
  }

  redirect("/settings?updated=github-installation-recorded");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
