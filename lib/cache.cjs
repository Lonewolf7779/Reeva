// lib/cache.cjs — Bounded Process-Local In-Memory LRU Cache
"use strict";

const { URL } = require("url");

const DEFAULT_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || "500", 10);
const DEFAULT_TTL_MS = parseInt(process.env.CACHE_TTL_MS || "600000", 10); // 10 minutes

// Common tracking parameters to strip for canonical cache keys
const TRACKING_PARAMS = Object.freeze([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "igshid",
    "fbclid",
    "gclid",
    "msclkid",
    "ref",
    "ref_src",
    "ref_url",
    "source",
    "feature"
]);

/**
 * Normalizes a URL to produce a canonical cache key.
 *
 * @param {string} rawUrl
 * @returns {string} Normalized canonical URL
 */
function normalizeCacheKey(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";

    try {
        const parsed = new URL(rawUrl.trim());

        // Remove known tracking query parameters
        for (const param of TRACKING_PARAMS) {
            parsed.searchParams.delete(param);
        }

        // Sort remaining query params for determinism
        parsed.searchParams.sort();

        // Remove trailing slash on pathname if not root
        if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
            parsed.pathname = parsed.pathname.slice(0, -1);
        }

        return parsed.href;
    } catch {
        return rawUrl.trim().toLowerCase();
    }
}

/**
 * Bounded LRU in-memory cache.
 * Note: This cache is strictly process-local. It does not persist across restarts
 * or share state across clustered worker processes.
 */
class BoundedCache {
    constructor(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        this.store = new Map();

        // Periodic sweep of expired items every 5 minutes
        this.cleanupTimer = setInterval(() => this.sweepExpired(), 5 * 60 * 1000);
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref(); // Do not prevent process exit
        }
    }

    sweepExpired() {
        const now = Date.now();
        for (const [key, entry] of this.store.entries()) {
            if (entry.expiresAt <= now) {
                this.store.delete(key);
            }
        }
    }

    get(rawKey) {
        const key = normalizeCacheKey(rawKey);
        const entry = this.store.get(key);
        if (!entry) return undefined;

        if (entry.expiresAt <= Date.now()) {
            this.store.delete(key);
            return undefined;
        }

        // Move to most recently used position
        this.store.delete(key);
        this.store.set(key, entry);

        return entry.value;
    }

    set(rawKey, value, customTtlMs) {
        const key = normalizeCacheKey(rawKey);
        this.sweepExpired();

        // Enforce maximum size constraint
        if (this.store.size >= this.maxEntries) {
            const oldestKey = this.store.keys().next().value;
            if (oldestKey) {
                this.store.delete(oldestKey);
            }
        }

        const ttl = typeof customTtlMs === "number" && customTtlMs > 0 ? customTtlMs : this.ttlMs;
        const expiresAt = Date.now() + ttl;

        this.store.set(key, { value, expiresAt });
    }

    has(rawKey) {
        return this.get(rawKey) !== undefined;
    }

    delete(rawKey) {
        const key = normalizeCacheKey(rawKey);
        return this.store.delete(key);
    }

    clear() {
        this.store.clear();
    }

    get size() {
        return this.store.size;
    }

    destroy() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        this.store.clear();
    }
}

const defaultCache = new BoundedCache();

module.exports = {
    BoundedCache,
    defaultCache,
    normalizeCacheKey
};
