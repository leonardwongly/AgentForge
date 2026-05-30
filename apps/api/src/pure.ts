// Pure, side-effect-free helpers extracted from app.ts as the first strangler
// slice toward a thinner API composition root (assessment C1/C2). Pure code is
// unit-testable without Prisma/Redis, unlike the request handlers in app.ts.

export function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// groupBy counted occurrences identically to countBy in app.ts; keep the name
// as a thin alias so call sites are unchanged while the duplication is removed.
export function groupBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return countBy(items, getKey);
}

export function percent(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((part / total) * 100);
}

export function prometheusLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return `${name} ${value}`;
  }
  const labelText = entries
    .map(([key, labelValue]) => `${key}="${prometheusLabelValue(labelValue)}"`)
    .join(",");
  return `${name}{${labelText}} ${value}`;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
