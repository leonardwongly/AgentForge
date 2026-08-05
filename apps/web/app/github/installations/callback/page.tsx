import Link from "next/link";
import { GitBranch, ShieldCheck } from "lucide-react";
import { recordGithubInstallation } from "../../../settings/actions";

type GitHubInstallationCallbackProps = {
  searchParams?: Promise<{
    installation_id?: string;
    setup_action?: string;
  }>;
};

const githubInstallationIdPattern = /^\d{1,20}$/u;

export default async function GitHubInstallationCallback({
  searchParams
}: GitHubInstallationCallbackProps) {
  const params = await searchParams;
  const installationId = params?.installation_id;

  if (!installationId || !githubInstallationIdPattern.test(installationId)) {
    return (
      <section className="page">
        <section className="notice notice--unavailable">
          <GitBranch size={18} aria-hidden="true" />
          <div>
            <h1>GitHub installation was not recorded</h1>
            <p>
              {installationId
                ? "GitHub returned an invalid installation ID. Start the install flow again."
                : "GitHub did not return an installation ID. Start the install flow again."}
            </p>
            <Link className="button" href="/settings">
              Return to settings
            </Link>
          </div>
        </section>
      </section>
    );
  }

  return (
    <section className="page">
      <section className="notice">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <h1>Confirm GitHub installation</h1>
          <p>
            GitHub returned installation ID <strong>{installationId}</strong>. No installation has
            been recorded yet.
          </p>
          <p>
            A signed-in platform admin must explicitly record it. The API will verify both the
            installation and your authorization before changing governance state.
          </p>
          <form action={recordGithubInstallation}>
            <input type="hidden" name="githubInstallationId" value={installationId} />
            <input type="hidden" name="accountType" value="Organization" />
            <input type="hidden" name="returnTo" value="/settings" />
            <div className="control-row">
              <button className="button button--primary" type="submit">
                Record installation
              </button>
              <Link className="button" href="/settings">
                Cancel and return to settings
              </Link>
            </div>
          </form>
        </div>
      </section>
    </section>
  );
}
