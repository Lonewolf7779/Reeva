// lib/media-registry.cjs — Opaque Media Token Registry
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REGISTRY_ENTRIES = 1000;

class MediaRegistry {
    constructor(maxEntries = MAX_REGISTRY_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        this.store = new Map(); // id -> { id, upstreamUrl, platform, type, title, localFilePath, mode, createdAt, expiresAt }
        this.activeReaders = new Map(); // normalizedFilePath -> readerCount
        this.pendingDeletions = new Set(); // normalizedFilePath
        this.deletionsInProgress = new Set(); // normalizedFilePath

        // Periodic background sweep of expired registry entries and local files
        this.cleanupTimer = setInterval(() => this.sweepExpired(), 5 * 60 * 1000);
        if (this.cleanupTimer && this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    /**
     * Resolves a local file path to an absolute normalized string.
     * @private
     * @param {string} filePath
     * @returns {string|null}
     */
    _normalizePath(filePath) {
        if (!filePath || typeof filePath !== "string") return null;
        return path.resolve(filePath);
    }

    /**
     * Checks if a local file path currently has one or more active stream readers.
     *
     * @param {string} filePath
     * @returns {boolean}
     */
    isPathActive(filePath) {
        const norm = this._normalizePath(filePath);
        if (!norm) return false;
        return (this.activeReaders.get(norm) || 0) > 0;
    }

    /**
     * Returns the active reader count for a local file path.
     *
     * @param {string} filePath
     * @returns {number}
     */
    getActiveReaderCount(filePath) {
        const norm = this._normalizePath(filePath);
        if (!norm) return 0;
        return this.activeReaders.get(norm) || 0;
    }

    /**
     * Marks a local file path for pending deletion once active leases reach zero.
     *
     * @param {string} filePath
     */
    markPendingDeletion(filePath) {
        const norm = this._normalizePath(filePath);
        if (norm) {
            this.pendingDeletions.add(norm);
        }
    }

    /**
     * Checks if a local file path is marked for pending deletion.
     *
     * @param {string} filePath
     * @returns {boolean}
     */
    isPendingDeletion(filePath) {
        const norm = this._normalizePath(filePath);
        if (!norm) return false;
        return this.pendingDeletions.has(norm);
    }

    /**
     * Checks if a local file path currently has an active deletion in progress.
     *
     * @param {string} filePath
     * @returns {boolean}
     */
    isDeletionInProgress(filePath) {
        const norm = this._normalizePath(filePath);
        if (!norm) return false;
        return this.deletionsInProgress.has(norm);
    }

    /**
     * Atomically claims a local file path for deletion.
     * If active readers exist on the path, marks the path for deferred deletion
     * and returns false.
     * If deletion is already claimed, returns false.
     * Otherwise registers deletion claim and returns true.
     *
     * @param {string} filePath
     * @returns {boolean} True if deletion claim was granted; false otherwise
     */
    claimDeletion(filePath) {
        const norm = this._normalizePath(filePath);
        if (!norm) return false;

        if (this.isPathActive(norm)) {
            this.pendingDeletions.add(norm);
            return false;
        }

        if (this.deletionsInProgress.has(norm)) {
            return false;
        }

        this.deletionsInProgress.add(norm);
        return true;
    }

    /**
     * Releases an in-progress deletion claim for a local file path.
     *
     * @param {string} filePath
     */
    releaseDeletionClaim(filePath) {
        const norm = this._normalizePath(filePath);
        if (norm) {
            this.deletionsInProgress.delete(norm);
        }
    }

    /**
     * Acquires an active-reader lease for a local file path.
     * Returns an idempotent release callback, or null if the path is invalid
     * or currently claimed for deletion.
     *
     * @param {string} filePath
     * @returns {Function|null} Idempotent release callback or null
     */
    acquireFileLease(filePath) {
        const norm = this._normalizePath(filePath);
        if (!norm) {
            return null;
        }

        if (this.deletionsInProgress.has(norm)) {
            return null;
        }

        const current = this.activeReaders.get(norm) || 0;
        this.activeReaders.set(norm, current + 1);

        let released = false;
        return () => {
            if (released) return;
            released = true;
            this._releaseFileLease(norm);
        };
    }

    /**
     * Releases an active-reader lease for a normalized local file path.
     * Triggers deferred deletion if the reader count reaches zero and
     * deletion was pending.
     *
     * @private
     * @param {string} norm
     */
    _releaseFileLease(norm) {
        if (!norm) return;
        const current = this.activeReaders.get(norm) || 0;
        const next = Math.max(0, current - 1);

        if (next === 0) {
            this.activeReaders.delete(norm);
            if (this.pendingDeletions.has(norm)) {
                this.pendingDeletions.delete(norm);
                this.deletionsInProgress.add(norm);
                try {
                    fs.unlinkSync(norm);
                } catch (_) {
                    // Ignore missing or locked files
                } finally {
                    this.deletionsInProgress.delete(norm);
                }
            }
        } else {
            this.activeReaders.set(norm, next);
        }
    }

    /**
     * Acquires an active-reader lease for a registered media entry by ID.
     * Prevents acquiring a lease on expired or evicted entries.
     *
     * @param {string} id
     * @returns {{ entry: object, release: Function } | null}
     */
    acquireStreamLease(id) {
        const entry = this.getMedia(id);
        if (!entry) return null;

        if (entry.localFilePath) {
            const release = this.acquireFileLease(entry.localFilePath);
            if (!release) return null;
            return { entry, release };
        }

        return { entry, release: () => {} };
    }

    /**
     * Safely unlinks a local file path if present.
     * If the file currently has active readers, unlinking is deferred
     * until all active readers release their leases.
     *
     * @private
     * @param {object} entry
     */
    _cleanupFile(entry) {
        if (entry && entry.localFilePath && typeof entry.localFilePath === "string") {
            const norm = this._normalizePath(entry.localFilePath);
            if (!norm) return;

            if (this.isPathActive(norm)) {
                this.pendingDeletions.add(norm);
            } else {
                this.pendingDeletions.delete(norm);
                this.deletionsInProgress.add(norm);
                try {
                    fs.unlinkSync(norm);
                } catch (_) {
                    // Ignore missing or locked files
                } finally {
                    this.deletionsInProgress.delete(norm);
                }
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

        if (localFilePath) {
            const norm = this._normalizePath(localFilePath);
            if (norm) {
                this.pendingDeletions.delete(norm);
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

        for (const norm of Array.from(this.pendingDeletions)) {
            if (!this.isPathActive(norm)) {
                this.pendingDeletions.delete(norm);
                this.deletionsInProgress.add(norm);
                try {
                    fs.unlinkSync(norm);
                } catch (_) {}
                finally {
                    this.deletionsInProgress.delete(norm);
                }
            }
        }
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
