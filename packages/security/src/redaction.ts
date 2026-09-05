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
    | "azure_connection_string"
    | "azure_storage_key"
    | "cloudflare_api_token"
    | "twilio_sid"
    | "twilio_auth_token"
    | "aws_secret_key"
    | "high_entropy";
  category: "credential_like" | "local_placeholder";
  risk: "high" | "low";
  reason: string;
  localService?: boolean | undefined;
  value: string;
  redacted: string;
};

const REDACTION = "[REDACTED]";

// Scan large inputs in bounded overlapping chunks. This avoids a single huge
// regex operation while still checking the entire value; truncating at a fixed
// offset allowed an attacker to hide a credential in the unscanned tail.
const SECRET_SCAN_CHUNK_LENGTH = 65_536;
const SECRET_SCAN_OVERLAP_LENGTH = 16_384;

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
  {
    // AWS secret access keys are a bare 40-char base64-alphabet string with no
    // fixed prefix, which is nearly indistinguishable by shape alone from many
    // hashes/tokens (and already overlaps the high_entropy catch-all). A bare
    // unconditional pattern here would add matching noise, not real recall, so
    // this instead requires the value to appear immediately after a
    // recognizable aws_secret_access_key assignment on the same line, which is
    // how this credential actually appears in config files, env dumps, and CI
    // logs.
    kind: "aws_secret_key",
    regex:
      /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?(?:[A-Za-z0-9+/]{40})["']?/g
  },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe_key", regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "sendgrid_key", regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: "openai_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "npm_token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    // Azure Storage connection string shape, e.g.
    // "DefaultEndpointsProtocol=https;AccountName=foo;AccountKey=<base64>;EndpointSuffix=core.windows.net".
    // Bounded {0,512} gaps between the required fields keep this linear-time.
    kind: "azure_connection_string",
    regex:
      /\bDefaultEndpointsProtocol=https?;[\s\S]{0,512}?AccountKey=[A-Za-z0-9+/]{80,100}={0,2};[\s\S]{0,512}?EndpointSuffix=[A-Za-z0-9.-]+/g
  },
  {
    // Standalone Azure Storage account key value: 88-char base64 ending in
    // "==". This shape is distinctive enough (fixed length + padding) to
    // detect even outside a full connection string, e.g. AZURE_STORAGE_KEY=... .
    // No trailing \b: a literal "==" is followed by a non-word character (or
    // end of input) in the padded-base64 case, so \b can never match there;
    // the negative lookahead instead guards against matching a truncated
    // slice of a longer base64/entropy run.
    kind: "azure_storage_key",
    regex: /\b[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])/g
  },
  {
    // Current (2026+) Cloudflare credential formats use a fixed, checksummed
    // prefix: cfk_ (Global API Key), cfut_ (User API Token), cfat_ (Account
    // API Token), each followed by 40 characters plus a checksum suffix. Only
    // the prefixed format is matched here; the legacy unprefixed 40-character
    // token and 37-45 character hex Global API Key have no distinguishing
    // shape and are already covered by the high_entropy/api_key_assignment
    // catch-alls.
    kind: "cloudflare_api_token",
    regex: /\bcf(?:k|ut|at)_[A-Za-z0-9_-]{40,60}\b/g
  },
  {
    // Twilio Account SID (AC...) and API Key SID (SK...) are fixed-format
    // 34-character identifiers (2-letter prefix + 32 hex chars) per Twilio's
    // own API schema. The Account SID is not itself secret but is a strong
    // contextual signal worth redacting alongside real credentials.
    kind: "twilio_sid",
    regex: /\b(?:AC|SK)[0-9a-fA-F]{32}\b/g
  },
  {
    // Twilio Auth Tokens are bare 32-char lowercase hex with no fixed prefix,
    // so (like the AWS secret key above) a bare pattern would mostly just
    // duplicate high_entropy/api_key_assignment coverage with added noise.
    // Requiring adjacency to an auth_token-style assignment keeps this
    // targeted at how the credential actually appears in config/env content.
    kind: "twilio_auth_token",
    regex: /\b(?:twilio[_-]?auth[_-]?token|TWILIO_AUTH_TOKEN)\s*[:=]\s*["']?(?:[0-9a-f]{32})["']?/gi
  },
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
  for (const { kind, regex } of patterns) {
    output = output.replace(regex, (match) =>
      isNonSecretReference(match, kind) ? match : preservePrefix(match)
    );
  }
  return output;
}

export function detectSecrets(input: string): RedactionMatch[] {
  const matches: RedactionMatch[] = [];
  const seen = new Set<string>();
  for (const { kind, regex } of patterns) {
    for (
      let offset = 0;
      offset < input.length || (offset === 0 && input.length === 0);
      offset += SECRET_SCAN_CHUNK_LENGTH
    ) {
      const scanned = input.slice(
        offset,
        offset + SECRET_SCAN_CHUNK_LENGTH + SECRET_SCAN_OVERLAP_LENGTH
      );
      regex.lastIndex = 0;
      for (const match of scanned.matchAll(regex)) {
        // A match that starts in the overlap belongs to the next chunk, where
        // it will be emitted once with the full surrounding context.
        if (match.index !== undefined && match.index >= SECRET_SCAN_CHUNK_LENGTH) {
          continue;
        }
        const value = match[0];
        const key = `${kind}:${offset + (match.index ?? 0)}:${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          kind,
          value,
          redacted: preservePrefix(value),
          ...classifyMatch(kind, value)
        });
      }
    }
  }
  return matches;
}

export function redactObject<T>(value: T): T {
  return redactObjectValue(value, new WeakSet<object>()) as T;
}

function redactObjectValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return undefined;
    }
    ancestors.add(value);
    const redacted = value.map((item) => redactObjectValue(item, ancestors));
    ancestors.delete(value);
    return redacted;
  }
  // Preserve non-plain objects (e.g. Date) as-is: they carry no secret-bearing
  // string fields of their own and recursing through their (empty) enumerable
  // surface would silently collapse them to {} (data loss).
  if (value instanceof Date) {
    return value;
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) {
      return undefined;
    }
    ancestors.add(value);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactObjectValue(nested, ancestors)])
    );
    ancestors.delete(value);
    return redacted;
  }
  return value;
}

export function summarizeSafeSnippet(input: string, maxLength = 180): string {
  const boundedLength = Number.isSafeInteger(maxLength) ? Math.max(0, maxLength) : 180;
  if (boundedLength === 0) {
    return "";
  }
  const compact = redactSecrets(input).replace(/\s+/g, " ").trim();
  return compact.length > boundedLength
    ? `${takeCodePoints(compact, boundedLength - 1)}…`
    : compact;
}

/**
 * Takes at most the requested number of Unicode code points without first
 * materializing an array for the entire input. This keeps bounded snippets
 * bounded even when the source text is attacker-controlled and very large.
 */
function takeCodePoints(value: string, maxCodePoints: number): string {
  const limit = Number.isSafeInteger(maxCodePoints) ? Math.max(0, maxCodePoints) : 0;
  if (limit === 0 || value.length === 0) {
    return "";
  }
  if (value.length <= limit) {
    return value;
  }

  let end = 0;
  let count = 0;
  for (const codePoint of value) {
    if (count >= limit) {
      break;
    }
    end += codePoint.length;
    count += 1;
  }
  return value.slice(0, end);
}

function preservePrefix(match: string): string {
  if (/^(?:postgres|postgresql|mysql|mongodb|redis):\/\//i.test(match)) {
    return match.replace(/\/\/[^@/\s]+@/, `//${REDACTION}@`);
  }
  if (/^DefaultEndpointsProtocol=https?;/i.test(match)) {
    return match.replace(/AccountKey=[A-Za-z0-9+/]{80,100}={0,2};/i, `AccountKey=${REDACTION};`);
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

  if (
    kind === "api_key_assignment" ||
    kind === "high_entropy" ||
    kind === "bearer_token" ||
    kind === "aws_secret_key" ||
    kind === "twilio_auth_token" ||
    kind === "azure_connection_string"
  ) {
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
  // SHAs (e.g. pinned GitHub Actions), not credentials. A policy version may
  // expose the same digest after a `+` suffix; the high-entropy matcher starts
  // after the final semver dot (for example `0+<sha256>`), so recognize that
  // bounded digest form as a non-secret reference as well.
  if (
    kind === "high_entropy" &&
    (/^[0-9a-f]{40}$/iu.test(trimmed) ||
      /^[0-9a-f]{64}$/iu.test(trimmed) ||
      /^[A-Za-z0-9_-]*\+[0-9a-f]{64}$/iu.test(trimmed))
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

/**
 * Sanitizes attacker-controlled labels and titles before they cross durable or
 * queue boundaries. Secret redaction runs before control/whitespace folding so
 * the redaction marker itself is retained, and code-point truncation avoids
 * splitting surrogate pairs.
 */
export function sanitizeExternalMetadataText(value: string, maxLength: number): string {
  const boundedLength = Number.isSafeInteger(maxLength) ? Math.max(0, maxLength) : 0;
  if (boundedLength === 0) {
    return "";
  }
  const normalized = redactSecrets(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return takeCodePoints(normalized, boundedLength);
}
