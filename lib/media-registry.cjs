// lib/media-registry.cjs — Opaque Media Token Registry
"use strict";

const crypto = require("crypto");

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REGISTRY_ENTRIES = 1000;

class MediaRegistry {
    constructor(maxEntries = MAX_REGISTRY_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        this.store = new Map(); // id -> { id, upstreamUrl, platform, type, title, createdAt, expiresAt }
    }

    /**
     * Evicts expired items from the store.
     */
    sweepExpired() {
        const now = Date.now();
        for (const [id, entry] of this.store.entries()) {
            if (entry.expiresAt <= now) {
                this.store.delete(id);
            }
        }
    }

    /**
     * Registers a validated upstream media URL and returns an opaque reference.
     *
     * @param {object} params
     * @param {string} params.upstreamUrl - The validated upstream CDN URL
     * @param {string} params.platform - The source platform (e.g., instagram, youtube)
     * @param {string} [params.type='video'] - 'video' or 'image'
     * @param {string} [params.title='Media'] - Human-readable media title
     * @returns {object} { id, type, title, expiresAt: ISOString }
     */
    registerMedia({ upstreamUrl, platform, type = "video", title = "Media" }) {
        this.sweepExpired();

        // Enforce maximum capacity via LRU eviction (delete oldest entry)
        if (this.store.size >= this.maxEntries) {
            const oldestKey = this.store.keys().next().value;
            if (oldestKey) {
                this.store.delete(oldestKey);
            }
        }

        const id = "med_" + crypto.randomBytes(16).toString("hex");
        const now = Date.now();
        const expiresAt = now + this.ttlMs;

        const entry = {
            id,
            upstreamUrl,
            platform,
            type: type || "video",
            title: title || "Media",
            createdAt: now,
            expiresAt
        };

        this.store.set(id, entry);

        return {
            id,
            type: entry.type,
            title: entry.title,
            expiresAt: new Date(expiresAt).toISOString()
        };
    }

    /**
     * Retrieves a media entry by its opaque ID.
     *
     * @param {string} id
     * @returns {object|null}
     */
    getMedia(id) {
        if (!id || typeof id !== "string") return null;

        const entry = this.store.get(id);
        if (!entry) return null;

        if (entry.expiresAt <= Date.now()) {
            this.store.delete(id);
            return null;
        }

        // Re-insert to refresh LRU order
        this.store.delete(id);
        this.store.set(id, entry);

        return entry;
    }

    /**
     * Checks if a given upstream URL is currently registered.
     *
     * @param {string} url
     * @returns {object|null}
     */
    findByUpstreamUrl(url) {
        this.sweepExpired();
        for (const entry of this.store.values()) {
            if (entry.upstreamUrl === url) {
                return entry;
            }
        }
        return null;
    }

    get size() {
        return this.store.size;
    }
}

// Export singleton instance and class
const defaultRegistry = new MediaRegistry();

module.exports = {
    MediaRegistry,
    defaultRegistry
};
