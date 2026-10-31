// lib/extraction/index.cjs — Central Media Extraction Orchestrator
"use strict";

const fs = require("fs");
const { validatePlatform, validateSourceUrl, validateGenericSourceUrl, ValidationError } = require("../url-validator.cjs");
const { SSRFError } = require("../ssrf-filter.cjs");
const { SecurityHTTPError } = require("../http-client.cjs");
const { defaultCache } = require("../cache.cjs");
const { logger } = require("../logger.cjs");
const { EXTRACTION_ERROR_CODES, ExtractionError } = require("./types.cjs");
const { validateExtractionResult } = require("./result-validator.cjs");
const { parseFeatureGates, isPlatformEnabled, isAudioOnlyEnabled } = require("../config.cjs");

const { extractInstagram } = require("./adapters/instagram.cjs");
const { extractFacebook } = require("./adapters/facebook.cjs");
const { extractTwitter } = require("./adapters/twitter.cjs");
const { extractPinterest } = require("./adapters/pinterest.cjs");
const { extractYouTube } = require("./adapters/youtube.cjs");
const { extractGeneric } = require("./adapters/generic.cjs");
const { extractTikTok } = require("./adapters/tiktok.cjs");

const DEFAULT_ADAPTERS = Object.freeze({
    instagram: extractInstagram,
    facebook: extractFacebook,
    twitter: extractTwitter,
    x: extractTwitter,
    pinterest: extractPinterest,
    youtube: extractYouTube,
    tiktok: extractTikTok,
    generic: extractGeneric,
    more_sites: extractGeneric
});

/**
 * Coordinates an in-flight extraction across multiple concurrent subscribers.
 * Ensures:
 * 1. The underlying extraction runs on a dedicated AbortController.
 * 2. An individual caller aborting removes only their subscription and rejects their promise with CLIENT_ABORTED.
 * 3. Other waiting subscribers are NOT cancelled and receive the successful result.
 * 4. If and only if ALL active subscribers abort before completion, the underlying operation is cancelled.
 * 5. Event listeners, registry entries, and memory are cleaned up upon settlement.
 */
class InFlightOperation {
    constructor(cacheKey, registryMap, performExtraction) {
        this.cacheKey = cacheKey;
        this.registryMap = registryMap;
        this.subscribers = new Set();
        this.sharedController = new AbortController();
        this.isDone = false;
        this.result = null;
        this.error = null;

        this.promise = (async () => {
            // Ensure initial subscriber has attached before executing task
            await Promise.resolve();
            if (this.subscribers.size === 0 && !this.isDone) {
                if (this.registryMap.get(this.cacheKey) === this) {
                    this.registryMap.delete(this.cacheKey);
                }
                this.sharedController.abort();
                return;
            }

            try {
                this.result = await performExtraction(this.sharedController.signal);
                this.isDone = true;
                const activeSubs = Array.from(this.subscribers);
                for (const sub of activeSubs) {
                    this._cleanupSubscriber(sub);
                    sub.resolve(this.result);
                }
            } catch (err) {
                this.isDone = true;
                this.error = err;
                const activeSubs = Array.from(this.subscribers);
                for (const sub of activeSubs) {
                    this._cleanupSubscriber(sub);
                    sub.reject(err);
                }
            } finally {
                if (this.registryMap.get(this.cacheKey) === this) {
                    this.registryMap.delete(this.cacheKey);
                }
            }
        })();
    }

    addSubscriber(signal) {
        if (this.isDone) {
            if (this.error) return Promise.reject(this.error);
            return Promise.resolve(this.result);
        }

        if (signal && signal.aborted) {
            // If no active subscribers remain, cancel the underlying operation
            if (this.subscribers.size === 0 && !this.isDone) {
                if (this.registryMap.get(this.cacheKey) === this) {
                    this.registryMap.delete(this.cacheKey);
                }
                this.sharedController.abort();
            }
            return Promise.reject(new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED"));
        }

        return new Promise((resolve, reject) => {
            const sub = { resolve, reject, signal, onAbort: null };

            if (signal) {
                sub.onAbort = () => {
                    this.subscribers.delete(sub);
                    this._cleanupSubscriber(sub);
                    reject(new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED"));

                    // If no active subscribers remain, cancel underlying shared extraction
                    if (this.subscribers.size === 0 && !this.isDone) {
                        if (this.registryMap.get(this.cacheKey) === this) {
                            this.registryMap.delete(this.cacheKey);
                        }
                        this.sharedController.abort();
                    }
                };
                signal.addEventListener("abort", sub.onAbort, { once: true });
            }

            this.subscribers.add(sub);
        });
    }

    _cleanupSubscriber(sub) {
        if (sub.signal && sub.onAbort) {
            try {
                sub.signal.removeEventListener("abort", sub.onAbort);
            } catch (_) {}
            sub.onAbort = null;
        }
    }
}

/**
 * Creates an extraction orchestrator instance with configurable adapters and cache.
 * Enables deterministic testing and dependency isolation.
 */
function createExtractionOrchestrator(customOptions = {}) {
    const adapters = { ...DEFAULT_ADAPTERS, ...(customOptions.adapters || {}) };
    const cache = customOptions.cache || defaultCache;
    const baseFeatures = customOptions.features || null;
    const inFlightExtractions = new Map();

    async function extractMedia({ platform: rawPlatform, sourceUrl: rawSourceUrl, mode: rawMode, requestId, signal, features }) {
        const startTime = Date.now();
        let platform = "unknown";

        // Pre-check caller signal before initiating extraction work
        if (signal && signal.aborted) {
            throw new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED");
        }

        try {
            platform = validatePlatform(rawPlatform);

            if (!rawSourceUrl || typeof rawSourceUrl !== "string") {
                throw new ValidationError("Please paste a video link first.", "MISSING_URL");
            }

            // Mode validation for YouTube and Generic
            let mode = undefined;
            if (platform === "youtube" || platform === "generic") {
                mode = rawMode ? String(rawMode).trim().toUpperCase() : "VIDEO_AND_AUDIO";
                if (!["VIDEO_ONLY", "AUDIO_ONLY", "VIDEO_AND_AUDIO"].includes(mode)) {
                    throw new ExtractionError(
                        EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                        `Invalid or unsupported media mode '${rawMode}'. Supported modes: VIDEO_ONLY, AUDIO_ONLY, VIDEO_AND_AUDIO.`
                    );
                }
            }

            // Strict validation of source URL before contacting any provider
            const validatedSourceUrl = (platform === "generic")
                ? await validateGenericSourceUrl(rawSourceUrl)
                : validateSourceUrl(rawSourceUrl, platform);

            // Recheck signal after asynchronous URL/SSRF validation
            if (signal && signal.aborted) {
                throw new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED");
            }

            // Enforce production platform feature gates before cache, deduplication, or adapter execution
            const activeGates = features || baseFeatures || parseFeatureGates(process.env);
            if (!isPlatformEnabled(platform, activeGates)) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.PLATFORM_DISABLED,
                    "This platform integration is currently disabled.",
                    { statusCode: 503, platform }
                );
            }

            if (mode === "AUDIO_ONLY" && !isAudioOnlyEnabled(activeGates)) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.MODE_DISABLED,
                    "Audio-only extraction is currently disabled.",
                    { statusCode: 503, mode }
                );
            }

            // Check cache (include mode for YouTube/Generic so different modes do not collide)
            const cacheKey = ((platform === "youtube" || platform === "generic") && mode)
                ? `${validatedSourceUrl}#mode=${mode}`
                : validatedSourceUrl;

            const cachedResult = cache.get(cacheKey);
            if (cachedResult) {
                // If a cached entry contains a local file, ensure the file still exists on disk
                if (cachedResult.localFilePath && !fs.existsSync(cachedResult.localFilePath)) {
                    cache.delete(cacheKey);
                } else {
                    return {
                        success: true,
                        media: cachedResult,
                        cached: true
                    };
                }
            }

            // In-flight deduplication for concurrent identical requests
            // Prevents thundering herd on upstream APIs
            const inFlightOp = inFlightExtractions.get(cacheKey);
            if (inFlightOp) {
                const inFlightResult = await inFlightOp.addSubscriber(signal);
                return {
                    success: true,
                    media: inFlightResult,
                    deduplicated: true
                };
            }

            // Recheck signal before starting adapter invocation or in-flight operation
            if (signal && signal.aborted) {
                throw new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED");
            }

            const adapter = adapters[platform];
            if (!adapter || typeof adapter !== "function") {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                    `No extraction adapter available for platform '${platform}'.`
                );
            }

            // Only coalesce in-flight for modes without single-owner local files
            const isLocalArtifactMode = (platform === "youtube" && mode === "VIDEO_AND_AUDIO") || (platform === "generic") || (platform === "more_sites") || (platform === "tiktok");

            let validatedResult;
            if (isLocalArtifactMode) {
                const rawResult = await adapter(validatedSourceUrl, { requestId, mode, signal });
                validatedResult = await validateExtractionResult(rawResult, platform);
            } else {
                const op = new InFlightOperation(cacheKey, inFlightExtractions, async (sharedSignal) => {
                    const rawResult = await adapter(validatedSourceUrl, { requestId, mode, signal: sharedSignal });
                    const validated = await validateExtractionResult(rawResult, platform);
                    if (!validated.localFilePath) {
                        cache.set(cacheKey, validated);
                    }
                    return validated;
                });
                inFlightExtractions.set(cacheKey, op);
                validatedResult = await op.addSubscriber(signal);
            }

            if (logger && typeof logger.info === "function") {
                logger.info({
                    requestId,
                    platform,
                    operation: "extract",
                    status: "success",
                    durationMs: Date.now() - startTime
                });
            }

            return {
                success: true,
                media: validatedResult
            };

        } catch (err) {
            const durationMs = Date.now() - startTime;
            const isKnownSafeError = (
                err instanceof ValidationError ||
                err instanceof SSRFError ||
                err instanceof SecurityHTTPError ||
                err instanceof ExtractionError
            );

            // Normalized error code
            const errorCode = isKnownSafeError
                ? (err.code || err.name || "EXTRACTION_FAILED")
                : "INTERNAL_ERROR";

            // Safe diagnostic message for logger:
            // Do NOT log raw user URLs, cookies, authorization headers, or provider response bodies
            const safeLogMessage = isKnownSafeError
                ? err.message
                : "Internal extraction failure";

            if (logger && typeof logger.error === "function") {
                logger.error({
                    requestId,
                    platform,
                    operation: "extract",
                    status: "error",
                    code: errorCode,
                    durationMs,
                    message: safeLogMessage
                });
            }

            // Preserve security errors strictly so callers return appropriate HTTP codes
            if (
                err instanceof ValidationError ||
                err instanceof SSRFError ||
                (err instanceof SecurityHTTPError && (
                    err.code === "DISALLOWED_DESTINATION" ||
                    err.code === "FORBIDDEN_PROTOCOL" ||
                    err.code === "CREDENTIALS_FORBIDDEN" ||
                    err.code === "FORBIDDEN_PORT" ||
                    err.code === "MALFORMED_URL" ||
                    err.code === "TOO_MANY_REDIRECTS" ||
                    err.code === "RESPONSE_TOO_LARGE" ||
                    err.code === "CLIENT_ABORTED" ||
                    err.code === "TIMEOUT"
                ))
            ) {
                throw err;
            }

            if (err instanceof ExtractionError) {
                throw err;
            }

            // Normalize unknown errors
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Failed to extract media from the requested URL."
            );
        }
    }

    return {
        extractMedia,
        adapters
    };
}

const defaultOrchestrator = createExtractionOrchestrator();

module.exports = {
    extractMedia: defaultOrchestrator.extractMedia,
    createExtractionOrchestrator,
    DEFAULT_ADAPTERS,
    ...require("./types.cjs"),
    ...require("./result-validator.cjs"),
    ...require("./strategies.cjs")
};
