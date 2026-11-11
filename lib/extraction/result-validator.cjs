// lib/extraction/result-validator.cjs — Centralized Validation for Extractor Output
"use strict";

const fs = require("fs");
const path = require("path");
const { validateMediaUrl, ValidationError } = require("../url-validator.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("./types.cjs");
const { REEVA_TEMP_DIR } = require("./adapters/youtube.cjs");

const MAX_TITLE_LENGTH = 200;
const SUPPORTED_MEDIA_TYPES = Object.freeze(["video", "image", "audio", "carousel"]);
const MAX_GENERIC_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

/**
 * Validates and normalizes raw output returned by an extraction provider/strategy.
 * Enforces:
 * 1. Result is an object
 * 2. URL or localFilePath exists and is valid
 * 3. Media type is explicitly supported ('video', 'image', or 'audio')
 * 4. For remote platforms: URL passes strict Reeva media CDN allowlist (validateMediaUrl)
 * 5. For generic platform: strictly verifies localFilePath inside REEVA_TEMP_DIR, file existence, and <= 100 MB
 * 6. Returns a normalized, immutable internal media object
 *
 * @param {object} rawResult - Output returned from an extractor adapter
 * @param {string} platform - The canonical platform identifier
 * @returns {object} Normalized media result: { url, type, platform, title, localFilePath?, mode? }
 */
async function validateExtractionResult(rawResult, platform) {
    if (!rawResult || typeof rawResult !== "object") {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            `No media could be extracted for ${platform}.`
        );
    }

    const normPlatform = (platform || "").toLowerCase().trim();

    // Clean title without excessive length
    let title = "Media";
    if (typeof rawResult.title === "string" && rawResult.title.trim()) {
        title = rawResult.title.trim().slice(0, MAX_TITLE_LENGTH);
    }

    // Media type validation: strictly 'video', 'image', or 'audio'
    const rawType = typeof rawResult.type === "string" ? rawResult.type.trim().toLowerCase() : "";
    if (!SUPPORTED_MEDIA_TYPES.includes(rawType)) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            `Unsupported media type '${rawResult.type}' returned for ${platform}.`
        );
    }

    // Special validation path for generic "More Sites" and TikTok extraction
    // Must be materialized into REEVA_TEMP_DIR; never allowed as arbitrary remote CDN stream
    if (normPlatform === "generic" || normPlatform === "more_sites" || normPlatform === "tiktok") {
        if (rawType === "image" && (normPlatform === "generic" || normPlatform === "more_sites")) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                "Standalone images are not supported in More Sites generic extraction."
            );
        }

        if (normPlatform === "tiktok" && rawType !== "video") {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                "Only video media is supported for TikTok extraction."
            );
        }

        if (!rawResult.localFilePath || typeof rawResult.localFilePath !== "string") {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                `${normPlatform === "tiktok" ? "TikTok" : "Generic"} extraction must produce a local media artifact.`
            );
        }

        const resolvedTempDir = path.resolve(process.env.REEVA_TEMP_DIR || REEVA_TEMP_DIR);
        const resolvedFilePath = path.resolve(rawResult.localFilePath);

        if (!resolvedFilePath.startsWith(resolvedTempDir + path.sep)) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Media artifact path is outside permitted temporary directory."
            );
        }

        let stat;
        try {
            stat = await fs.promises.stat(resolvedFilePath);
        } catch (err) {
            if (err.code === "ENOENT" || err.code === "ENOTDIR") {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                    "Local media artifact does not exist on disk."
                );
            }
            throw err;
        }

        if (stat.size === 0) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Generated media artifact was empty."
            );
        }

        if (stat.size > MAX_GENERIC_FILE_SIZE) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Media artifact exceeds the maximum permitted size of 100 MB.",
                { statusCode: 413 }
            );
        }

        const materializedResult = {
            url: `file://${resolvedFilePath}`,
            localFilePath: resolvedFilePath,
            type: rawType,
            platform: normPlatform === "tiktok" ? "tiktok" : "generic",
            title
        };

        if (rawResult.mode && typeof rawResult.mode === "string") {
            materializedResult.mode = rawResult.mode;
        }

        return Object.freeze(materializedResult);
    }

    // Specialized platforms (instagram, facebook, twitter, pinterest, youtube)
    if (!rawResult.url || typeof rawResult.url !== "string") {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            `No valid media stream URL was found for this ${platform} content.`
        );
    }

    const trimmedUrl = rawResult.url.trim();
    if (!trimmedUrl) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "Extracted media URL was empty."
        );
    }

    // Crucial: Provider output must pass Reeva's strict security validation.
    // If provider returned an unapproved host or non-HTTPS URL, this throws ValidationError.
    let validatedUrlObject;
    try {
        validatedUrlObject = validateMediaUrl(trimmedUrl);
    } catch (err) {
        if (err instanceof ValidationError) {
            throw err;
        }
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Extracted media URL failed security validation."
        );
    }

    // Validate carousel items collection if present
    let validatedItems = undefined;
    if (Array.isArray(rawResult.items) && rawResult.items.length > 0) {
        validatedItems = [];
        const MAX_CAROUSEL_ITEMS = 30;
        const boundedItems = rawResult.items.slice(0, MAX_CAROUSEL_ITEMS);

        for (let i = 0; i < boundedItems.length; i++) {
            const item = boundedItems[i];
            if (!item || typeof item !== "object") continue;

            const itemType = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
            if (itemType !== "video" && itemType !== "image") continue;

            if (!item.url || typeof item.url !== "string") continue;
            const trimmedItemUrl = item.url.trim();
            if (!trimmedItemUrl) continue;

            let validatedItemUrl;
            try {
                validatedItemUrl = validateMediaUrl(trimmedItemUrl);
            } catch (_) {
                // Skip malformed or unapproved URLs safely
                continue;
            }

            let validatedThumbUrl = null;
            if (item.thumbnailUrl && typeof item.thumbnailUrl === "string") {
                const trimmedThumb = item.thumbnailUrl.trim();
                if (trimmedThumb) {
                    try {
                        validatedThumbUrl = validateMediaUrl(trimmedThumb).href;
                    } catch (_) {
                        validatedThumbUrl = null;
                    }
                }
            }

            validatedItems.push(Object.freeze({
                index: typeof item.index === "number" ? item.index : validatedItems.length,
                type: itemType,
                url: validatedItemUrl.href,
                thumbnailUrl: validatedThumbUrl,
                width: typeof item.width === "number" && item.width > 0 ? item.width : null,
                height: typeof item.height === "number" && item.height > 0 ? item.height : null
            }));
        }

        if (validatedItems.length > 0) {
            Object.freeze(validatedItems);
        } else {
            validatedItems = undefined;
        }
    }

    const resultObj = {
        url: validatedUrlObject.href,
        type: rawType,
        platform: normPlatform,
        title
    };

    if (validatedItems && validatedItems.length > 0) {
        resultObj.items = validatedItems;
    }

    if (rawResult.localFilePath && typeof rawResult.localFilePath === "string") {
        resultObj.localFilePath = rawResult.localFilePath;
    }

    if (rawResult.mode && typeof rawResult.mode === "string") {
        resultObj.mode = rawResult.mode;
    }

    return Object.freeze(resultObj);
}

module.exports = {
    validateExtractionResult,
    SUPPORTED_MEDIA_TYPES
};
