import Link from "next/link";
import { Database, Play } from "lucide-react";
import type { DashboardData } from "./data";

type DataSourceNoticeProps = Pick<DashboardData, "source" | "message" | "records">;

export function DataSourceNotice({ source, message, records }: DataSourceNoticeProps) {
  if (source === "api" && records.length > 0) {
    return null;
  }

  const title = source === "empty" ? "No Change Control Records yet" : "API data unavailable";
  const previewHref = records[0]
    ? `/repositories/${records[0].record.repositoryId}/policy-preview`
    : "/onboarding";
  const previewLabel = records[0] ? "Run preview" : "Open onboarding";

  return (
    <section className={`notice notice--${source}`}>
      <Database size={18} aria-hidden="true" />
      <div>
        <h2>{title}</h2>
        <p>{message}</p>
      </div>
      <div className="control-row">
        <Link className="button" href={previewHref}>
          <Play size={16} aria-hidden="true" /> {previewLabel}
        </Link>
      </div>
    </section>
  );
}
