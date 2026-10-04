// lib/extraction/index.cjs — Central Media Extraction Orchestrator
"use strict";

const { validatePlatform, validateSourceUrl, ValidationError } = require("../url-validator.cjs");
const { SSRFError } = require("../ssrf-filter.cjs");
const { defaultCache } = require("../cache.cjs");
const { logger } = require("../logger.cjs");
const { EXTRACTION_ERROR_CODES, ExtractionError } = require("./types.cjs");
const { validateExtractionResult } = require("./result-validator.cjs");

const { extractInstagram } = require("./adapters/instagram.cjs");
const { extractFacebook } = require("./adapters/facebook.cjs");
const { extractTwitter } = require("./adapters/twitter.cjs");
const { extractPinterest } = require("./adapters/pinterest.cjs");
const { extractYouTube } = require("./adapters/youtube.cjs");

const DEFAULT_ADAPTERS = Object.freeze({
    instagram: extractInstagram,
    facebook: extractFacebook,
    twitter: extractTwitter,
    x: extractTwitter,
    pinterest: extractPinterest,
    youtube: extractYouTube
});

/**
 * Creates an extraction orchestrator instance with configurable adapters and cache.
 * Enables deterministic testing and dependency isolation.
 */
function createExtractionOrchestrator(customOptions = {}) {
    const adapters = { ...DEFAULT_ADAPTERS, ...(customOptions.adapters || {}) };
    const cache = customOptions.cache || defaultCache;

    async function extractMedia({ platform: rawPlatform, sourceUrl: rawSourceUrl, mode: rawMode, requestId }) {
        const startTime = Date.now();
        let platform = "unknown";

        try {
            platform = validatePlatform(rawPlatform);

            if (!rawSourceUrl || typeof rawSourceUrl !== "string") {
                throw new ValidationError("Please paste a video link first.", "MISSING_URL");
            }

            // Mode validation for YouTube
            let mode = undefined;
            if (platform === "youtube") {
                mode = rawMode ? String(rawMode).trim().toUpperCase() : "VIDEO_AND_AUDIO";
                if (!["VIDEO_ONLY", "AUDIO_ONLY", "VIDEO_AND_AUDIO"].includes(mode)) {
                    throw new ExtractionError(
                        EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                        `Invalid or unsupported media mode '${rawMode}'. Supported modes: VIDEO_ONLY, AUDIO_ONLY, VIDEO_AND_AUDIO.`
                    );
                }
            }

            // Strict validation of source URL before contacting any provider
            const validatedSourceUrl = validateSourceUrl(rawSourceUrl, platform);

            // Check cache (include mode for YouTube so different modes do not collide)
            const cacheKey = (platform === "youtube" && mode)
                ? `${validatedSourceUrl}#mode=${mode}`
                : validatedSourceUrl;

            const cachedResult = cache.get(cacheKey);
            if (cachedResult) {
                return {
                    success: true,
                    media: cachedResult,
                    cached: true
                };
            }

            const adapter = adapters[platform];
            if (!adapter || typeof adapter !== "function") {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                    `No extraction adapter available for platform '${platform}'.`
                );
            }

            // Execute adapter
            const rawResult = await adapter(validatedSourceUrl, { requestId, mode });

            // Validate discovered media against strict security rules
            const validatedResult = validateExtractionResult(rawResult, platform);

            // Store in cache
            cache.set(cacheKey, validatedResult);

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
            if (logger && typeof logger.error === "function") {
                logger.error({
                    requestId,
                    platform,
                    operation: "extract",
                    status: "error",
                    code: err.code || err.name,
                    durationMs: Date.now() - startTime,
                    message: err.message
                });
            }

            // Preserve security errors strictly so callers return 400
            if (err instanceof ValidationError || err instanceof SSRFError) {
                throw err;
            }

            if (err instanceof ExtractionError) {
                throw err;
            }

            // Normalize unknown errors
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Failed to extract media from the requested URL.",
                { originalError: err.message }
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
