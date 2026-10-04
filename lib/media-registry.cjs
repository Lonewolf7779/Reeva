// lib/media-registry.cjs — Opaque Media Token Registry
"use strict";

const crypto = require("crypto");
const fs = require("fs");

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REGISTRY_ENTRIES = 1000;

class MediaRegistry {
    constructor(maxEntries = MAX_REGISTRY_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        this.store = new Map(); // id -> { id, upstreamUrl, platform, type, title, localFilePath, mode, createdAt, expiresAt }

        // Periodic background sweep of expired registry entries and local files
        this.cleanupTimer = setInterval(() => this.sweepExpired(), 5 * 60 * 1000);
        if (this.cleanupTimer && this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    /**
     * Safely unlinks a local file path if present.
     * @private
     */
    _cleanupFile(entry) {
        if (entry && entry.localFilePath && typeof entry.localFilePath === "string") {
            try {
                fs.unlinkSync(entry.localFilePath);
            } catch (_) {
                // Ignore missing or locked files
            }
        }
    }

    /**
     * Evicts expired items from the store.
     */
    sweepExpired() {
        const now = Date.now();
        for (const [id, entry] of this.store.entries()) {
            if (entry.expiresAt <= now) {
                this._cleanupFile(entry);
                this.store.delete(id);
            }
        }
    }

    /**
     * Registers a validated upstream media URL or merged file and returns an opaque reference.
     *
     * @param {object} params
     * @param {string} params.upstreamUrl - The validated upstream CDN URL
     * @param {string} params.platform - The source platform (e.g., instagram, youtube)
     * @param {string} [params.type='video'] - 'video', 'image', or 'audio'
     * @param {string} [params.title='Media'] - Human-readable media title
     * @param {string} [params.localFilePath=null] - Local merged media file path if applicable
     * @param {string} [params.mode=null] - Extraction mode (VIDEO_ONLY, AUDIO_ONLY, VIDEO_AND_AUDIO)
     * @returns {object} { id, type, title, expiresAt: ISOString }
     */
    registerMedia({ upstreamUrl, platform, type = "video", title = "Media", localFilePath = null, mode = null }) {
        this.sweepExpired();

        // Enforce maximum capacity via LRU eviction (delete oldest entry)
        if (this.store.size >= this.maxEntries) {
            const oldestKey = this.store.keys().next().value;
            if (oldestKey) {
                const oldestEntry = this.store.get(oldestKey);
                this._cleanupFile(oldestEntry);
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
            localFilePath: localFilePath || null,
            mode: mode || null,
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
            this._cleanupFile(entry);
            this.store.delete(id);
            return null;
        }

        // Re-insert to refresh LRU order
        this.store.delete(id);
        this.store.set(id, entry);

        return entry;
    }

    /**
     * Explicitly deletes a media entry and unlinks any associated local file.
     *
     * @param {string} id
     * @returns {boolean}
     */
    deleteMedia(id) {
        if (!id || typeof id !== "string") return false;
        const entry = this.store.get(id);
        if (entry) {
            this._cleanupFile(entry);
            this.store.delete(id);
            return true;
        }
        return false;
    }

    /**
     * Clears all registered media and cleans up local files.
     */
    clear() {
        for (const entry of this.store.values()) {
            this._cleanupFile(entry);
        }
        this.store.clear();
    }

    /**
     * Destroys registry instance, clearing timer and files.
     */
    destroy() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        this.clear();
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
