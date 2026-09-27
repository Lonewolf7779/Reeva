// lib/extraction/types.cjs — Extraction Error Types and Normalized Failure Codes
"use strict";

const EXTRACTION_ERROR_CODES = Object.freeze({
    EXTRACTION_FAILED: "EXTRACTION_FAILED",
    MEDIA_NOT_FOUND: "MEDIA_NOT_FOUND",
    UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
    PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
    UNSUPPORTED_MEDIA: "UNSUPPORTED_MEDIA",
    PLATFORM_CHALLENGE: "PLATFORM_CHALLENGE",
    PRIVATE_CONTENT: "PRIVATE_CONTENT"
});

const DEFAULT_ERROR_MESSAGES = Object.freeze({
    EXTRACTION_FAILED: "We couldn't retrieve media from this link. Make sure it is public and accessible.",
    MEDIA_NOT_FOUND: "No downloadable video or image was found for this link.",
    UPSTREAM_UNAVAILABLE: "The upstream platform is currently unreachable. Please try again shortly.",
    PROVIDER_TIMEOUT: "Extraction timed out while communicating with the upstream platform.",
    UNSUPPORTED_MEDIA: "The media format found on this page is not supported for download.",
    PLATFORM_CHALLENGE: "The upstream platform presented a challenge or login barrier. Please try again later or check if the post is publicly accessible.",
    PRIVATE_CONTENT: "This content is private or requires authentication to view."
});

class ExtractionError extends Error {
    constructor(code, message, details = {}) {
        const finalMessage = message || DEFAULT_ERROR_MESSAGES[code] || "Failed to extract media.";
        super(finalMessage);
        this.name = "ExtractionError";
        this.code = code || EXTRACTION_ERROR_CODES.EXTRACTION_FAILED;
        let defaultStatus = 502;
        if (code === EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND) {
            defaultStatus = 404;
        } else if (code === EXTRACTION_ERROR_CODES.PRIVATE_CONTENT || code === EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE) {
            defaultStatus = 403;
        }
        this.statusCode = details.statusCode || defaultStatus;
        this.details = details;
    }
}

module.exports = {
    EXTRACTION_ERROR_CODES,
    DEFAULT_ERROR_MESSAGES,
    ExtractionError
};
