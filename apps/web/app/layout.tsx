import type { Metadata } from "next";
import Link from "next/link";
import {
  ClipboardCheck,
  FileCheck,
  Gauge,
  GitPullRequestArrow,
  Home,
  Lightbulb,
  ListChecks,
  PieChart,
  Settings,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import { loadRepositories } from "./data";
import "./globals.css";

// This dashboard renders authenticated, per-request live data (it reads request
// identity and fetches Change Control state with `cache: "no-store"`). Force
// dynamic rendering for the whole route tree so Next.js does not attempt to
// statically prerender these pages at build time (which fails under the Next 16 /
// React 19 client-hook dispatcher during export).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AgentForge Merge Guard",
  description: "Deterministic, evidence-based pull request change control.",
  icons: {
    icon: "/favicon.svg"
  }
};

function navigation(repositoryId: string | undefined) {
  const items = [
    { href: "/dashboard", label: "Dashboard", icon: Home },
    { href: "/dashboard/blocked-prs", label: "Blocked PRs", icon: GitPullRequestArrow },
    { href: "/dashboard/policy-violations", label: "Policy Findings", icon: ListChecks },
    { href: "/dashboard/overrides", label: "Overrides", icon: ShieldCheck },
    { href: "/dashboard/evidence-completion", label: "Evidence", icon: PieChart },
    { href: "/dashboard/policy-insights", label: "Policy Insights", icon: Lightbulb },
    { href: "/records", label: "Records", icon: FileCheck }
  ];
  if (repositoryId) {
    items.push(
      { href: `/repositories/${repositoryId}/policy`, label: "Policy", icon: SlidersHorizontal },
      { href: `/repositories/${repositoryId}/policy-preview`, label: "Preview", icon: Gauge }
    );
  }
  return [
    ...items,
    { href: "/onboarding", label: "Onboarding", icon: ClipboardCheck },
    { href: "/settings", label: "Settings", icon: Settings }
  ];
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const repositories = await loadRepositories();
  const repositoryId = repositories.repositories[0]?.id;

  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <aside className="sidebar" aria-label="Primary navigation">
            <Link className="brand" href="/dashboard">
              <span className="brand-mark">AF</span>
              <span>AgentForge</span>
            </Link>
            <nav className="nav">
              {navigation(repositoryId).map((item) => {
                const Icon = item.icon;
                return (
                  <Link href={item.href} key={item.href}>
                    <Icon size={17} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </aside>
          <main className="shell-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
