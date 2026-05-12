import type { ReactNode } from "react";

type MetricCardProps = {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "block" | "warn" | "pass";
};

export function MetricCard({ label, value, detail, tone = "neutral" }: MetricCardProps): ReactNode {
  return (
    <section className={`metric-card metric-card--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </section>
  );
}

type StatusBadgeProps = {
  status: "pass" | "warn" | "block" | "missing" | "provided" | "approved" | "enforce" | "observe";
};

export function StatusBadge({ status }: StatusBadgeProps): ReactNode {
  return <span className={`status-badge status-badge--${status}`}>{status}</span>;
}
