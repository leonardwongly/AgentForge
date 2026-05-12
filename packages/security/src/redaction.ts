export type RedactionMatch = {
  kind:
    | "aws_access_key"
    | "github_token"
    | "private_key"
    | "jwt"
    | "bearer_token"
    | "database_url"
    | "api_key_assignment"
    | "high_entropy";
  value: string;
  redacted: string;
};

const REDACTION = "[REDACTED]";

const patterns: Array<{ kind: RedactionMatch["kind"]; regex: RegExp }> = [
  {
    kind: "private_key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  { kind: "github_token", regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { kind: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "bearer_token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi },
  {
    kind: "database_url",
    regex: /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s"'<>]+/gi
  },
  {
    kind: "api_key_assignment",
    regex:
      /\b(?:api[_-]?key|client[_-]?secret|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}["']?/gi
  },
  {
    kind: "high_entropy",
    regex: /\b[A-Za-z0-9+/=_-]{40,}\b/g
  }
];

export function redactSecrets(input: string): string {
  let output = input;
  for (const { regex } of patterns) {
    output = output.replace(regex, (match) => preservePrefix(match));
  }
  return output;
}

export function detectSecrets(input: string): RedactionMatch[] {
  const matches: RedactionMatch[] = [];
  for (const { kind, regex } of patterns) {
    regex.lastIndex = 0;
    for (const match of input.matchAll(regex)) {
      const value = match[0];
      matches.push({ kind, value, redacted: preservePrefix(value) });
    }
  }
  return matches;
}

export function redactObject<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactObject(nested)])
    ) as T;
  }
  return value;
}

export function summarizeSafeSnippet(input: string, maxLength = 180): string {
  const compact = redactSecrets(input).replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function preservePrefix(match: string): string {
  if (/^(?:postgres|postgresql|mysql|mongodb|redis):\/\//i.test(match)) {
    return match.replace(/\/\/[^@/\s]+@/, `//${REDACTION}@`);
  }
  const assignment = match.match(/^([^:=]{2,40}[:=]\s*)/);
  if (assignment) {
    return `${assignment[1]}${REDACTION}`;
  }
  if (/^Bearer\s+/i.test(match)) {
    return "Bearer [REDACTED]";
  }
  return REDACTION;
}
