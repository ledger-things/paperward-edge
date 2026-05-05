// src/config/kv.ts
//
// Two-layer tenant config cache (spec §6.1):
//  1. Module-scoped Map per Worker isolate, 60s freshness window
//  2. Cloudflare KV edge cache via cacheTtl: 60 on the underlying KV.get()
//
// On KV timeout: serve stale isolate cache if present; otherwise rethrow so
// the middleware can fail closed with 503.

import type { TenantConfig } from "@/config/types";

export type CacheOutcome = "hit" | "miss" | "stale";

type Entry = {
  config: TenantConfig;
  fetched_at: number;
};

const FRESHNESS_MS = 60_000;
const KV_CACHE_TTL_S = 60;

export class TenantConfigCache {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly kv: KVNamespace) {}

  /**
   * Returns the tenant config for a hostname, or null if no tenant is configured.
   * Throws on KV timeout when no stale cache is available.
   */
  async get(hostname: string): Promise<TenantConfig | null> {
    const now = Date.now();
    const cached = this.cache.get(hostname);

    if (cached && now - cached.fetched_at < FRESHNESS_MS) {
      return cached.config; // cache hit
    }

    let raw: string | null;
    try {
      raw = await this.kv.get(`domains:${hostname}`, { cacheTtl: KV_CACHE_TTL_S });
    } catch (err) {
      if (cached) {
        // stale fallback
        return cached.config;
      }
      throw err;
    }

    if (raw === null) {
      this.cache.delete(hostname);
      return null;
    }

    const config = JSON.parse(raw) as TenantConfig;
    this.cache.set(hostname, { config, fetched_at: now });
    return config;
  }

  /**
   * For tests: clear the in-memory cache so a subsequent .get() goes to KV.
   * Production code should not call this.
   */
  invalidate(hostname?: string): void {
    if (hostname) this.cache.delete(hostname);
    else this.cache.clear();
  }
}
