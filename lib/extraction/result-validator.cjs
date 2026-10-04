// lib/extraction/result-validator.cjs — Centralized Validation for Extractor Output
"use strict";

const { validateMediaUrl, ValidationError } = require("../url-validator.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("./types.cjs");

const MAX_TITLE_LENGTH = 200;
const SUPPORTED_MEDIA_TYPES = Object.freeze(["video", "image", "audio"]);

/**
 * Validates and normalizes raw output returned by an extraction provider/strategy.
 * Enforces:
 * 1. Result is an object
 * 2. URL exists, is a string, and is within size limits
 * 3. Media type is explicitly supported ('video' or 'image')
 * 4. URL passes strict Reeva media CDN allowlist and protocol validation (validateMediaUrl)
 * 5. Returns a normalized, immutable internal media object
 *
 * @param {object} rawResult - Output returned from an extractor adapter
 * @param {string} platform - The canonical platform identifier
 * @returns {object} Normalized media result: { url, type, platform, title }
 */
function validateExtractionResult(rawResult, platform) {
    if (!rawResult || typeof rawResult !== "object") {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            `No media could be extracted for ${platform}.`
        );
    }

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

    // Media type validation: strictly 'video' or 'image'
    const rawType = typeof rawResult.type === "string" ? rawResult.type.trim().toLowerCase() : "";
    if (!SUPPORTED_MEDIA_TYPES.includes(rawType)) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            `Unsupported media type '${rawResult.type}' returned for ${platform}.`
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

    // Clean title without excessive length
    let title = "Media";
    if (typeof rawResult.title === "string" && rawResult.title.trim()) {
        title = rawResult.title.trim().slice(0, MAX_TITLE_LENGTH);
    }

    const resultObj = {
        url: validatedUrlObject.href,
        type: rawType,
        platform: platform.toLowerCase(),
        title
    };

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
