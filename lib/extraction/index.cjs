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

const { extractInstagram } = require("./adapters/instagram.cjs");
const { extractFacebook } = require("./adapters/facebook.cjs");
const { extractTwitter } = require("./adapters/twitter.cjs");
const { extractPinterest } = require("./adapters/pinterest.cjs");
const { extractYouTube } = require("./adapters/youtube.cjs");
const { extractGeneric } = require("./adapters/generic.cjs");

const DEFAULT_ADAPTERS = Object.freeze({
    instagram: extractInstagram,
    facebook: extractFacebook,
    twitter: extractTwitter,
    x: extractTwitter,
    pinterest: extractPinterest,
    youtube: extractYouTube,
    generic: extractGeneric,
    more_sites: extractGeneric
});

/**
 * Creates an extraction orchestrator instance with configurable adapters and cache.
 * Enables deterministic testing and dependency isolation.
 */
function createExtractionOrchestrator(customOptions = {}) {
    const adapters = { ...DEFAULT_ADAPTERS, ...(customOptions.adapters || {}) };
    const cache = customOptions.cache || defaultCache;
    const inFlightExtractions = new Map();

    async function extractMedia({ platform: rawPlatform, sourceUrl: rawSourceUrl, mode: rawMode, requestId, signal }) {
        const startTime = Date.now();
        let platform = "unknown";

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
            if (inFlightExtractions.has(cacheKey)) {
                const inFlightResult = await inFlightExtractions.get(cacheKey);
                return {
                    success: true,
                    media: inFlightResult,
                    deduplicated: true
                };
            }

            const adapter = adapters[platform];
            if (!adapter || typeof adapter !== "function") {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                    `No extraction adapter available for platform '${platform}'.`
                );
            }

            // Execute adapter with in-flight tracking
            const extractionPromise = (async () => {
                const rawResult = await adapter(validatedSourceUrl, { requestId, mode, signal });
                const validated = validateExtractionResult(rawResult, platform);
                // Store in cache only if the result is remote (do not cache local transient file artifacts)
                if (!validated.localFilePath) {
                    cache.set(cacheKey, validated);
                }
                return validated;
            })();

            // Only coalesce in-flight for modes without single-owner local files
            const isLocalArtifactMode = (platform === "youtube" && mode === "VIDEO_AND_AUDIO") || (platform === "generic") || (platform === "more_sites");
            if (!isLocalArtifactMode) {
                inFlightExtractions.set(cacheKey, extractionPromise);
            }

            let validatedResult;
            try {
                validatedResult = await extractionPromise;
            } finally {
                inFlightExtractions.delete(cacheKey);
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
                    err.code === "RESPONSE_TOO_LARGE"
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
