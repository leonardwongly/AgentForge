export type RedactionMatch = {
  kind:
    | "aws_access_key"
    | "github_token"
    | "private_key"
    | "jwt"
    | "bearer_token"
    | "database_url"
    | "api_key_assignment"
    | "slack_token"
    | "google_api_key"
    | "stripe_key"
    | "sendgrid_key"
    | "openai_key"
    | "npm_token"
    | "high_entropy";
  category: "credential_like" | "local_placeholder";
  risk: "high" | "low";
  reason: string;
  localService?: boolean | undefined;
  value: string;
  redacted: string;
};

const REDACTION = "[REDACTED]";

// Upper bound on input length scanned by detectSecrets. Secret scanning of very
// large blobs (e.g. a 1MB diff) is low value and a DoS amplifier; detection is
// truncated to this many characters. redactSecrets is NOT truncated (it must
// never emit an un-redacted tail) and instead relies on every pattern being
// linear-time (no unbounded backtracking).
const MAX_SECRET_SCAN_LENGTH = 65_536;

const patterns: Array<{ kind: RedactionMatch["kind"]; regex: RegExp }> = [
  {
    // Bounded inner quantifier ({0,N}?) keeps this linear-time. An unbounded
    // `[\s\S]*?` allowed a quadratic (O(n^2)) ReDoS when many unterminated
    // BEGIN markers appeared in attacker-controlled input (AF-SEC ReDoS fix).
    kind: "private_key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  { kind: "github_token", regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { kind: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe_key", regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "sendgrid_key", regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: "openai_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "npm_token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
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
  const scanned =
    input.length > MAX_SECRET_SCAN_LENGTH ? input.slice(0, MAX_SECRET_SCAN_LENGTH) : input;
  const matches: RedactionMatch[] = [];
  for (const { kind, regex } of patterns) {
    regex.lastIndex = 0;
    for (const match of scanned.matchAll(regex)) {
      const value = match[0];
      matches.push({ kind, value, redacted: preservePrefix(value), ...classifyMatch(kind, value) });
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

function classifyMatch(
  kind: RedactionMatch["kind"],
  value: string
): Pick<RedactionMatch, "category" | "risk" | "reason" | "localService"> {
  if (kind === "database_url") {
    const localService = isLocalServiceUrl(value);
    if (localService && hasPlaceholderDatabaseCredentials(value)) {
      return {
        category: "local_placeholder",
        risk: "low",
        reason: "local service URL with placeholder credentials",
        localService
      };
    }

    return {
      category: "credential_like",
      risk: "high",
      reason: localService ? "credential-bearing local service URL" : "credential-shaped value",
      localService
    };
  }

  if (kind === "api_key_assignment" || kind === "high_entropy" || kind === "bearer_token") {
    if (isNonSecretReference(value, kind)) {
      return {
        category: "local_placeholder",
        risk: "low",
        reason: "non-secret reference (environment variable, template expression, or content hash)"
      };
    }
    if (isObviousPlaceholder(value)) {
      return {
        category: "local_placeholder",
        risk: "low",
        reason: "placeholder or local development value"
      };
    }
  }

  return {
    category: "credential_like",
    risk: "high",
    reason: "credential-shaped value"
  };
}

function isLocalServiceUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function isObviousPlaceholder(value: string): boolean {
  const inspected = inspectSecretValue(value).toLowerCase();
  return isPlaceholderToken(inspected);
}

function isNonSecretReference(value: string, kind: RedactionMatch["kind"]): boolean {
  const trimmed = value.trim();
  // Template / interpolation expressions: GitHub Actions ${{ ... }}, shell/JS ${ ... }
  if (/\$\{\{?/.test(trimmed)) {
    return true;
  }
  // Environment-variable reads - the literal secret never appears in source.
  if (/(?:process\.env|import\.meta\.env|os\.environ|Deno\.env\.get|ENV\[)/.test(trimmed)) {
    return true;
  }
  // Bare high-entropy hex runs are almost always content hashes or pinned commit
  // SHAs (e.g. pinned GitHub Actions), not credentials.
  if (
    kind === "high_entropy" &&
    (/^[0-9a-f]{40}$/iu.test(trimmed) || /^[0-9a-f]{64}$/iu.test(trimmed))
  ) {
    return true;
  }
  return false;
}

function isPlaceholderToken(value: string): boolean {
  if (
    /(?:placeholder|example|sample|dummy|changeme|change-me|local-only|dev-only)/.test(value) ||
    /your[_-]?(?:token|secret|password|api[_-]?key)/.test(value) ||
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)/.test(value)
  ) {
    return true;
  }

  return (
    /^(?:x+|0+|1+|a+|pass|password|user|root|postgres|agentforge|test-?[a-z0-9_-]*|dev-?[a-z0-9_-]*)$/u.test(
      value
    ) ||
    /(?:placeholder|example|sample|dummy|changeme|change-me|local-only|dev-only)/u.test(value) ||
    /^(.)\1{15,}$/u.test(value)
  );
}

function inspectSecretValue(value: string): string {
  const assignment = /^\s*[^:=]{2,40}?\s*[:=]\s*["']?([^"'\s]+)["']?$/u.exec(value);
  if (assignment?.[1]) {
    return assignment[1];
  }

  const bearer = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/iu.exec(value);
  return bearer?.[1] ?? value;
}

function hasPlaceholderDatabaseCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    const username = decodeURIComponent(parsed.username).toLowerCase();
    const password = decodeURIComponent(parsed.password).toLowerCase();
    if (!username && !password) {
      return true;
    }
    return [username, password].every((part) => !part || isPlaceholderToken(part));
  } catch {
    return false;
  }
}
