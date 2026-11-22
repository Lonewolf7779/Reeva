// lib/media-processor/job-manager.cjs — Single-Instance In-Memory Media Processing Job Manager
"use strict";

/**
 * Architectural Note (Single-Instance Limitation):
 * Job metadata is stored in a process-local in-memory Map and temporary media artifacts
 * are stored in REEVA_TEMP_DIR on the local container filesystem.
 * This Phase 2B foundation is strictly limited to a single application instance (maxReplicas: 1).
 * Multi-replica horizontal scaling requires migrating job state to Redis/Queue and artifacts to Blob Storage.
 */

const crypto = require("crypto");
const {
    MEDIA_PROCESSOR_ERROR_CODES,
    MediaProcessingError,
    validateProcessingProfile,
    processMedia,
    safeUnlink,
    defaultProcessingLimiter
} = require("./ffmpeg-runner.cjs");
const { defaultRegistry } = require("../media-registry.cjs");

const JOB_STATES = Object.freeze({
    QUEUED: "queued",
    PROCESSING: "processing",
    COMPLETED: "completed",
    FAILED: "failed",
    CANCELLED: "cancelled",
    EXPIRED: "expired"
});

const TERMINAL_STATES = new Set([
    JOB_STATES.COMPLETED,
    JOB_STATES.FAILED,
    JOB_STATES.CANCELLED,
    JOB_STATES.EXPIRED
]);

const DEFAULT_MAX_JOBS = 200;
const DEFAULT_RETENTION_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

function timingSafeTokenMatch(expectedToken, suppliedToken) {
    if (typeof expectedToken !== "string" || typeof suppliedToken !== "string") return false;
    if (!expectedToken || expectedToken.length !== suppliedToken.length) return false;
    try {
        return crypto.timingSafeEqual(
            Buffer.from(expectedToken, "utf8"),
            Buffer.from(suppliedToken, "utf8")
        );
    } catch (_) {
        return false;
    }
}

class MediaJobManager {
    constructor(options = {}) {
        this.maxJobs = options.maxJobs || DEFAULT_MAX_JOBS;
        this.retentionMs = options.retentionMs || DEFAULT_RETENTION_MS;
        this.mediaRegistry = options.mediaRegistry || defaultRegistry;
        this.limiter = options.limiter || defaultProcessingLimiter;
        this.processMediaFn = options.processMediaFn || processMedia;
        this.processOptions = options.processOptions || {};
        this.jobs = new Map();
        this.isShuttingDown = false;

        const sweepMs = options.sweepIntervalMs || DEFAULT_SWEEP_INTERVAL_MS;
        this.sweepTimer = setInterval(() => {
            this.sweepExpired().catch(() => {});
        }, sweepMs);
        if (this.sweepTimer.unref) {
            this.sweepTimer.unref();
        }
    }

    /**
     * Authorizes access to a job using constant-time capability token comparison.
     * Always returns uniform 403 error to avoid leaking jobId existence.
     *
     * @private
     */
    _authorizeJob(jobId, token) {
        if (!jobId || typeof jobId !== "string" || !/^job_[a-f0-9]{32}$/.test(jobId)) {
            throw new MediaProcessingError(
                "UNAUTHORIZED_JOB_ACCESS",
                "Unauthorized or invalid media job reference.",
                { statusCode: 403 }
            );
        }

        const job = this.jobs.get(jobId);
        if (!job || !timingSafeTokenMatch(job.token, token)) {
            throw new MediaProcessingError(
                "UNAUTHORIZED_JOB_ACCESS",
                "Unauthorized or invalid media job reference.",
                { statusCode: 403 }
            );
        }

        if (job.expiresAt <= Date.now() && job.status !== JOB_STATES.EXPIRED) {
            this._expireJobSync(job);
        }

        return job;
    }

    _expireJobSync(job) {
        if (!job || job.status === JOB_STATES.EXPIRED) return;
        if (job.abortController && !job.abortController.signal.aborted) {
            job.abortController.abort();
        }
        job.status = JOB_STATES.EXPIRED;
        job.updatedAt = Date.now();
        if (job.mediaId) {
            this.mediaRegistry.deleteMedia(job.mediaId);
            job.mediaId = null;
        }
        if (job.uploadPath) {
            const toDelete = job.uploadPath;
            job.uploadPath = null;
            safeUnlink(toDelete).catch(() => {});
        }
    }

    /**
     * Sweeps expired jobs, releasing temporary files and registry entries.
     */
    async sweepExpired() {
        const now = Date.now();
        const pruneAfterMs = this.retentionMs + 5 * 60 * 1000;

        for (const [jobId, job] of this.jobs.entries()) {
            if (job.expiresAt <= now && job.status !== JOB_STATES.EXPIRED) {
                this._expireJobSync(job);
            }
            if (job.status === JOB_STATES.EXPIRED && (now - job.expiresAt) > pruneAfterMs) {
                this.jobs.delete(jobId);
            }
        }
    }

    /**
     * Formats a safe public representation of a job (never exposes paths or capability tokens).
     */
    toPublicView(job) {
        const view = {
            jobId: job.id,
            status: job.status,
            operation: job.operation,
            createdAt: new Date(job.createdAt).toISOString(),
            updatedAt: new Date(job.updatedAt).toISOString(),
            expiresAt: new Date(job.expiresAt).toISOString()
        };

        if (job.status === JOB_STATES.COMPLETED && job.mediaId) {
            view.output = {
                mediaId: job.mediaId,
                streamUrl: `/api/media/${job.mediaId}`,
                downloadUrl: `/api/media/${job.mediaId}?download=1`,
                sizeBytes: job.outputSizeBytes,
                format: job.outputExt
            };
        }

        if (job.status === JOB_STATES.FAILED && job.error) {
            view.error = {
                code: job.error.code,
                message: job.error.message
            };
        }

        return view;
    }

    /**
     * Creates a queued processing job for a validated upload and starts async execution.
     *
     * @param {{ uploadPath: string, profile: object }} params
     * @returns {Promise<{ job: object, capabilityToken: string }>}
     */
    async createJob({ uploadPath, profile }) {
        if (this.isShuttingDown) {
            await safeUnlink(uploadPath);
            throw new MediaProcessingError(
                "SERVICE_UNAVAILABLE",
                "Server is shutting down and cannot accept new processing jobs.",
                { statusCode: 503 }
            );
        }

        let validatedProfile;
        try {
            validatedProfile = validateProcessingProfile(profile);
        } catch (err) {
            await safeUnlink(uploadPath);
            throw err;
        }

        await this.sweepExpired();

        const activeCount = Array.from(this.jobs.values()).filter(
            (j) => j.status === JOB_STATES.QUEUED || j.status === JOB_STATES.PROCESSING
        ).length;

        if (this.jobs.size >= this.maxJobs) {
            // Evict oldest terminal job if at capacity
            let evicted = false;
            for (const [id, existing] of this.jobs.entries()) {
                if (TERMINAL_STATES.has(existing.status)) {
                    this._expireJobSync(existing);
                    this.jobs.delete(id);
                    evicted = true;
                    break;
                }
            }
            if (!evicted || activeCount >= this.maxJobs) {
                await safeUnlink(uploadPath);
                throw new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.CONCURRENCY_LIMIT,
                    "Media job queue is at maximum capacity. Please retry shortly.",
                    { statusCode: 503 }
                );
            }
        }

        const now = Date.now();
        const id = `job_${crypto.randomBytes(16).toString("hex")}`;
        const token = crypto.randomBytes(32).toString("hex");

        const job = {
            id,
            token,
            status: JOB_STATES.QUEUED,
            operation: validatedProfile.operation,
            profile,
            uploadPath,
            mediaId: null,
            outputSizeBytes: null,
            outputExt: validatedProfile.outputExt,
            error: null,
            abortController: new AbortController(),
            createdAt: now,
            updatedAt: now,
            expiresAt: now + this.retentionMs,
            executionPromise: null
        };

        this.jobs.set(id, job);

        // Schedule execution asynchronously on next tick so POST returns 202 immediately
        job.executionPromise = new Promise((resolve) => {
            setImmediate(async () => {
                await this._executeJob(job);
                resolve();
            });
        });

        return {
            job: this.toPublicView(job),
            capabilityToken: token
        };
    }

    async _executeJob(job) {
        if (job.status !== JOB_STATES.QUEUED || job.abortController.signal.aborted || this.isShuttingDown) {
            if (job.status === JOB_STATES.QUEUED) {
                job.status = JOB_STATES.CANCELLED;
                job.updatedAt = Date.now();
            }
            if (job.uploadPath) {
                const p = job.uploadPath;
                job.uploadPath = null;
                await safeUnlink(p);
            }
            return;
        }

        job.status = JOB_STATES.PROCESSING;
        job.updatedAt = Date.now();

        try {
            const result = await this.processMediaFn(
                {
                    inputPath: job.uploadPath,
                    profile: job.profile
                },
                {
                    ...this.processOptions,
                    limiter: this.limiter,
                    signal: job.abortController.signal
                }
            );

            // Prevent completion if cancelled/expired right as processMedia returned
            if (job.status !== JOB_STATES.PROCESSING || job.abortController.signal.aborted) {
                await safeUnlink(result.outputPath);
                return;
            }

            const mediaType = job.operation === "extract_audio" ? "audio" : "video";
            const registered = this.mediaRegistry.registerMedia({
                upstreamUrl: `internal://job/${job.id}`,
                platform: "processor",
                type: mediaType,
                title: `Processed ${job.operation}`,
                localFilePath: result.outputPath,
                mode: job.operation
            });

            const rawUpload = job.uploadPath;
            job.uploadPath = null;
            await safeUnlink(rawUpload);

            job.mediaId = registered.id;
            job.outputSizeBytes = result.outputSizeBytes;
            job.outputExt = result.outputExt;
            job.status = JOB_STATES.COMPLETED;
            job.updatedAt = Date.now();
            job.expiresAt = Date.now() + this.retentionMs;
        } catch (err) {
            if (job.status === JOB_STATES.CANCELLED || job.status === JOB_STATES.EXPIRED || job.abortController.signal.aborted) {
                if (job.status === JOB_STATES.PROCESSING) {
                    job.status = JOB_STATES.CANCELLED;
                    job.updatedAt = Date.now();
                }
            } else {
                job.status = JOB_STATES.FAILED;
                job.updatedAt = Date.now();
                job.error = {
                    code: (err && err.code) || MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED,
                    message: (err && err.publicMessage) || "Media processing failed."
                };
            }
        } finally {
            // Raw uploaded input is no longer needed once processing completes/fails/cancels
            if (job.uploadPath) {
                const toDelete = job.uploadPath;
                job.uploadPath = null;
                await safeUnlink(toDelete);
            }
        }
    }

    getJobStatus(jobId, token) {
        const job = this._authorizeJob(jobId, token);
        return this.toPublicView(job);
    }

    async cancelJob(jobId, token) {
        const job = this._authorizeJob(jobId, token);

        if (job.status === JOB_STATES.CANCELLED) {
            return this.toPublicView(job);
        }

        if (job.status === JOB_STATES.COMPLETED || job.status === JOB_STATES.FAILED || job.status === JOB_STATES.EXPIRED) {
            throw new MediaProcessingError(
                "JOB_NOT_CANCELLABLE",
                `Cannot cancel job in '${job.status}' state.`,
                { statusCode: 409 }
            );
        }

        job.status = JOB_STATES.CANCELLED;
        job.updatedAt = Date.now();
        if (!job.abortController.signal.aborted) {
            job.abortController.abort();
        }
        if (job.uploadPath) {
            const toDelete = job.uploadPath;
            job.uploadPath = null;
            await safeUnlink(toDelete);
        }

        return this.toPublicView(job);
    }

    getCompletedMediaEntry(jobId, token) {
        const job = this._authorizeJob(jobId, token);

        if (job.status === JOB_STATES.EXPIRED) {
            throw new MediaProcessingError(
                "MEDIA_EXPIRED",
                "Processed media has expired.",
                { statusCode: 410 }
            );
        }

        if (job.status !== JOB_STATES.COMPLETED || !job.mediaId) {
            throw new MediaProcessingError(
                "JOB_NOT_READY",
                `Processed output is not ready (current status: ${job.status}).`,
                { statusCode: 409 }
            );
        }

        const entry = this.mediaRegistry.getMedia(job.mediaId);
        if (!entry) {
            this._expireJobSync(job);
            throw new MediaProcessingError(
                "MEDIA_EXPIRED",
                "Processed media has expired.",
                { statusCode: 410 }
            );
        }

        return entry;
    }

    async shutdown() {
        this.isShuttingDown = true;
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        const pending = [];
        for (const job of this.jobs.values()) {
            if (!TERMINAL_STATES.has(job.status)) {
                job.status = JOB_STATES.CANCELLED;
                job.updatedAt = Date.now();
                if (!job.abortController.signal.aborted) {
                    job.abortController.abort();
                }
            }
            if (job.executionPromise) {
                pending.push(job.executionPromise.catch(() => {}));
            }
            this._expireJobSync(job);
        }
        await Promise.allSettled(pending);
        this.jobs.clear();
    }
}

module.exports = {
    JOB_STATES,
    TERMINAL_STATES,
    DEFAULT_MAX_JOBS,
    DEFAULT_RETENTION_MS,
    MediaJobManager
};
