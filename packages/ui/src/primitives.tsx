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
  status:
    | "pass"
    | "warn"
    | "block"
    | "missing"
    | "provided"
    | "approved"
    | "required"
    | "enforce"
    | "observe"
    | "conditional"
    | "suggested"
    | "critical"
    | "high"
    | "medium"
    | "low"
    | "overridden";
  label?: string | undefined;
};

export function StatusBadge({ status, label }: StatusBadgeProps): ReactNode {
  return <span className={`status-badge status-badge--${status}`}>{label ?? status}</span>;
}

type ProgressBarProps = {
  value: number;
  label: string;
};

export function ProgressBar({ value, label }: ProgressBarProps): ReactNode {
  const bounded = Math.max(0, Math.min(100, value));
  return (
    <div
      className="progress"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={bounded}
    >
      <span style={{ width: `${bounded}%` }} />
    </div>
  );
}
