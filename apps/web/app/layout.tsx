import type { Metadata } from "next";
import Link from "next/link";
import {
  ClipboardCheck,
  FileCheck,
  Gauge,
  GitPullRequestArrow,
  Home,
  Settings,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentForge Merge Guard",
  description: "Deterministic, evidence-based pull request change control.",
  icons: {
    icon: "/favicon.svg"
  }
};

const navigation = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/dashboard/blocked-prs", label: "Blocked PRs", icon: GitPullRequestArrow },
  { href: "/dashboard/overrides", label: "Overrides", icon: ShieldCheck },
  { href: "/records/ccr_demo", label: "Records", icon: FileCheck },
  { href: "/repositories/repo_local/policy", label: "Policy", icon: SlidersHorizontal },
  { href: "/repositories/repo_local/policy-preview", label: "Preview", icon: Gauge },
  { href: "/onboarding", label: "Onboarding", icon: ClipboardCheck },
  { href: "/settings", label: "Settings", icon: Settings }
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
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
              {navigation.map((item) => {
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
