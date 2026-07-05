import { createHash } from "node:crypto";
import { Redis } from "ioredis";

export interface CacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

// Throttle the expiry sweep to at most once per interval so it never runs an
// O(N) loop on every single set() call (mirrors auth.ts's registerSignatureUse
// sweep throttle).
const MEMORY_CACHE_SWEEP_INTERVAL_MS = 60_000;

// Default hard cap on the number of entries MemoryCacheBackend will hold.
// Realistic key cardinality for this cache is per-PR-evaluation: one
// getFileContentCacheKey entry per changed file inspected (typically tens per
// PR, see packages/github/src/index.ts) and one getMembershipCacheKey entry
// per reviewer/team membership check (typically single digits per PR, see
// apps/api/src/routes/api-routes.ts). Even a sustained Redis outage spanning
// hundreds of PRs across many repos would stay well under 10,000 distinct
// keys, so this default bounds worst-case memory (well under a few MB of
// string data) without evicting entries a real workload would still want.
const DEFAULT_MAX_MEMORY_CACHE_ENTRIES = 10_000;

export class MemoryCacheBackend implements CacheBackend {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private lastSweepMs = 0;

  constructor(private readonly maxEntries: number = DEFAULT_MAX_MEMORY_CACHE_ENTRIES) {}

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.sweepExpired(Date.now());
    // Hard memory bound: evict oldest entries (Map preserves insertion order)
    // in amortized O(1) per insert (mirrors auth.ts's seenSignatures eviction).
    while (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.store.delete(oldest);
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  // Periodic sweep of expired entries so keys that are set once and never
  // get() again don't sit in memory past their TTL until the hard cap is hit.
  // Throttled to at most once per MEMORY_CACHE_SWEEP_INTERVAL_MS so it stays
  // amortized rather than an O(N) loop on every set() call.
  private sweepExpired(nowMs: number): void {
    if (nowMs - this.lastSweepMs <= MEMORY_CACHE_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweepMs = nowMs;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= nowMs) {
        this.store.delete(key);
      }
    }
  }
}

export class RedisCacheManager implements CacheBackend {
  private redis: Redis | null = null;
  private memoryFallback = new MemoryCacheBackend();
  private hasConnectionError = false;

  constructor(redisUrl?: string) {
    if (redisUrl) {
      try {
        this.redis = new Redis(redisUrl, {
          maxRetriesPerRequest: null,
          showFriendlyErrorStack: true,
          lazyConnect: true,
          // See SignatureReplayGuard's identical setting: bounds how long a
          // single command can hang on a connected-but-unresponsive Redis
          // before ioredis rejects it and this class falls back to memory.
          commandTimeout: 2_000
        });

        this.redis.on("error", (err) => {
          console.error("Redis Cache error:", err.message);
          this.hasConnectionError = true;
        });

        this.redis.on("connect", () => {
          this.hasConnectionError = false;
        });
      } catch (err) {
        console.error("Failed to initialize Redis Cache:", err);
        this.redis = null;
      }
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.redis || this.hasConnectionError) {
      return this.memoryFallback.get(key);
    }
    try {
      return await this.redis.get(key);
    } catch (err) {
      console.warn(`Redis Cache get failed for ${key}, falling back to memory:`, err);
      return this.memoryFallback.get(key);
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.redis || this.hasConnectionError) {
      await this.memoryFallback.set(key, value, ttlSeconds);
      return;
    }
    try {
      await this.redis.set(key, value, "EX", ttlSeconds);
    } catch (err) {
      console.warn(`Redis Cache set failed for ${key}, falling back to memory:`, err);
      await this.memoryFallback.set(key, value, ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    // Delete from both to ensure consistency during fallback transitions
    await this.memoryFallback.del(key);
    if (!this.redis) {
      return;
    }
    try {
      await this.redis.del(key);
    } catch (err) {
      console.warn(`Redis Cache del failed for ${key}:`, err);
    }
  }

  async disconnect(): Promise<void> {
    const redis = this.redis;
    this.redis = null;
    if (redis) {
      try {
        if (redis.status === "ready") {
          await redis.quit();
        } else {
          redis.disconnect(false);
        }
      } catch {
        // ignore
      }
    }
  }
}

// Cache key components are encoded (and the free-form repo path is hashed) so
// that distinct inputs can never collapse to the same key. Previously the path
// was sanitized with a lossy `/`->`_` replacement, allowing `a/package.json`
// and `a_package.json` to collide; and components were joined with ":" without
// escaping, so a value containing ":" could forge another key (AF-SEC fix).
function encodeKeyPart(value: string): string {
  return encodeURIComponent(value.toLowerCase());
}

export function getMembershipCacheKey(org: string, teamSlug: string, username: string): string {
  return `agentforge:cache:membership:${encodeKeyPart(org)}:${encodeKeyPart(teamSlug)}:${encodeKeyPart(
    username
  )}`;
}

export function getFileContentCacheKey(
  owner: string,
  repo: string,
  ref: string,
  path: string
): string {
  // Hash the raw (case-sensitive) path: collision-resistant and fixed length,
  // so no two distinct paths share a key and the path cannot inject delimiters.
  const pathHash = createHash("sha256").update(path).digest("hex");
  return `agentforge:cache:file-content:${encodeKeyPart(owner)}:${encodeKeyPart(repo)}:${encodeKeyPart(
    ref
  )}:${pathHash}`;
}

// Bounded, swept in-memory "seen signature" set used as the fallback backend
// for SignatureReplayGuard (mirrors MemoryCacheBackend's eviction/sweep
// pattern, but only needs to store an expiry timestamp per key, not a value).
const DEFAULT_MAX_MEMORY_REPLAY_ENTRIES = 50_000;
const MEMORY_REPLAY_SWEEP_INTERVAL_MS = 60_000;

class MemorySignatureReplayBackend {
  private seen = new Map<string, number>();
  private lastSweepMs = 0;

  constructor(private readonly maxEntries: number = DEFAULT_MAX_MEMORY_REPLAY_ENTRIES) {}

  /** Returns true if this is the first time `key` has been claimed within `ttlSeconds`. */
  claim(key: string, ttlSeconds: number, nowMs: number): boolean {
    this.sweepExpired(nowMs);
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > nowMs) {
      return false;
    }
    while (this.seen.size >= this.maxEntries && !this.seen.has(key)) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.seen.delete(oldest);
    }
    this.seen.set(key, nowMs + ttlSeconds * 1000);
    return true;
  }

  private sweepExpired(nowMs: number): void {
    if (nowMs - this.lastSweepMs <= MEMORY_REPLAY_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweepMs = nowMs;
    for (const [key, expiry] of this.seen) {
      if (expiry <= nowMs) {
        this.seen.delete(key);
      }
    }
  }
}

/**
 * Cross-instance-safe signature replay protection. Uses Redis's atomic
 * `SET key val NX EX ttl` (set-if-not-exists-with-expiry in one round trip,
 * no separate get-then-set race) so that once a signature is claimed by any
 * one process, every other process sharing the same Redis sees it as claimed
 * too — closing the multi-instance replay gap that a per-process in-memory
 * Map cannot (AF-SEC: signature replay caches must be cluster-wide when the
 * API/dashboard run behind a load balancer with more than one instance).
 *
 * Falls back to a bounded, swept in-memory claim set (same semantics, single
 * process only) when no REDIS_URL is configured or Redis is unreachable, so
 * local development and single-instance deployments keep working exactly as
 * before this change, just without the cross-instance guarantee.
 */
export class SignatureReplayGuard {
  private redis: Redis | null = null;
  private memoryFallback: MemorySignatureReplayBackend;
  private hasConnectionError = false;

  /**
   * `memoryFallbackMaxEntries` is exposed (rather than only using the
   * production default) so tests can force the eviction branch
   * deterministically with a small cap, instead of needing tens of
   * thousands of claims to exhaust the real default.
   */
  constructor(redisUrl?: string, memoryFallbackMaxEntries?: number) {
    this.memoryFallback = new MemorySignatureReplayBackend(memoryFallbackMaxEntries);
    if (redisUrl) {
      try {
        this.redis = new Redis(redisUrl, {
          // Caps retry attempts (distinct from commandTimeout, which caps
          // how long any single attempt waits) so a persistently
          // unreachable Redis gives up retrying and surfaces as an error
          // promptly, rather than requeueing indefinitely.
          maxRetriesPerRequest: 3,
          showFriendlyErrorStack: true,
          lazyConnect: true,
          // Bounds how long a single command can hang waiting on a
          // connected-but-unresponsive Redis before ioredis rejects it. Without
          // this, a hung (not errored) Redis leaves claim() awaiting
          // indefinitely instead of falling back to the in-memory guard --
          // exactly the failure mode the fallback exists to protect against.
          commandTimeout: 2_000
        });
        this.redis.on("error", (err) => {
          console.error("Redis SignatureReplayGuard error:", err.message);
          this.hasConnectionError = true;
        });
        this.redis.on("connect", () => {
          this.hasConnectionError = false;
        });
      } catch (err) {
        console.error("Failed to initialize Redis SignatureReplayGuard:", err);
        this.redis = null;
      }
    }
  }

  /**
   * Attempts to claim `key` (a namespaced signature) for `ttlSeconds`.
   * Returns true the first time a given key is claimed within that window,
   * false on every subsequent attempt (i.e. a replay). Fails open to the
   * in-memory fallback (not open to "always allow") if Redis errors, so a
   * transient Redis outage degrades to single-instance replay protection
   * rather than removing replay protection entirely.
   */
  async claim(key: string, ttlSeconds: number, nowMs: number = Date.now()): Promise<boolean> {
    if (!this.redis || this.hasConnectionError) {
      return this.memoryFallback.claim(key, ttlSeconds, nowMs);
    }
    try {
      const result = await this.redis.set(key, "1", "EX", ttlSeconds, "NX");
      return result === "OK";
    } catch (err) {
      // Never log the raw key: it is namespaced as
      // "agentforge:replay:{api|dashboard}:{signature}" and the signature
      // itself is sensitive (the actual HMAC over the signed request). Log
      // only the namespace prefix so failures remain diagnosable without
      // leaking signature material into logs during a Redis outage.
      const keyPrefix = key.split(":").slice(0, 3).join(":");
      console.warn(
        `Redis SignatureReplayGuard claim failed for key prefix ${keyPrefix}, falling back:`,
        err
      );
      return this.memoryFallback.claim(key, ttlSeconds, nowMs);
    }
  }

  async disconnect(): Promise<void> {
    const redis = this.redis;
    this.redis = null;
    if (redis) {
      try {
        if (redis.status === "ready") {
          await redis.quit();
        } else {
          redis.disconnect(false);
        }
      } catch {
        // ignore
      }
    }
  }
}
