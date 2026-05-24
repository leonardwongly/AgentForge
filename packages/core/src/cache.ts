import { Redis } from "ioredis";

export interface CacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemoryCacheBackend implements CacheBackend {
  private store = new Map<string, { value: string; expiresAt: number }>();

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
          lazyConnect: true
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

export function getMembershipCacheKey(org: string, teamSlug: string, username: string): string {
  return `agentforge:cache:membership:${org.toLowerCase()}:${teamSlug.toLowerCase()}:${username.toLowerCase()}`;
}

export function getFileContentCacheKey(
  owner: string,
  repo: string,
  ref: string,
  path: string
): string {
  const sanitizedPath = path.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `agentforge:cache:file-content:${owner.toLowerCase()}:${repo.toLowerCase()}:${ref.toLowerCase()}:${sanitizedPath}`;
}
