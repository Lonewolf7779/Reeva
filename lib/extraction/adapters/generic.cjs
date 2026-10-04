// lib/extraction/adapters/generic.cjs — Hardened "More Sites" Generic Extraction Adapter using yt-dlp
"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");
const {
    resolveYtDlpCommand,
    resolveFfmpegPath,
    REEVA_TEMP_DIR,
    defaultCommandRunner,
    sanitizeErrorDetail
} = require("./youtube.cjs");
const { ensureEgressProxy } = require("../egress-proxy.cjs");

const GENERIC_MODES = Object.freeze(["VIDEO_ONLY", "AUDIO_ONLY", "VIDEO_AND_AUDIO"]);
const DEFAULT_GENERIC_MODE = "VIDEO_AND_AUDIO";

const DEFAULT_METADATA_TIMEOUT_MS = 30000; // 30 seconds for metadata
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000; // 2 minutes for download/merge
const MAX_GENERIC_MEDIA_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB hard ceiling

/**
 * Ensures the temporary directory exists.
 */
function ensureTempDir() {
    if (!fs.existsSync(REEVA_TEMP_DIR)) {
        fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    }
    return REEVA_TEMP_DIR;
}

/**
 * Safely cleans up all files matching a temp prefix (including partial .part files).
 *
 * @param {string} tempPrefix
 */
function cleanupTempFiles(tempPrefix) {
    if (!tempPrefix || typeof tempPrefix !== "string") return;
    try {
        const dir = path.dirname(tempPrefix);
        const base = path.basename(tempPrefix);
        if (fs.existsSync(dir)) {
            const entries = fs.readdirSync(dir);
            for (const file of entries) {
                if (file.startsWith(base)) {
                    try {
                        fs.unlinkSync(path.join(dir, file));
                    } catch (_) {}
                }
            }
        }
    } catch (_) {}
}

/**
 * Safely parses newline-separated JSON objects from yt-dlp stdout.
 * Ignores non-JSON diagnostic lines and selects the primary usable media object.
 *
 * Selection rule (deterministic):
 * 1. Collect all valid JSON objects from stdout lines.
 * 2. If any object is explicitly a playlist (_type === "playlist"), reject immediately.
 * 3. Return the first object that possesses a valid identifier, title, format list, or url.
 *
 * @param {string} stdout
 * @returns {object} Selected media metadata object
 */
function parseGenericMetadata(stdout) {
    if (!stdout || typeof stdout !== "string") {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Empty output from media extractor."
        );
    }

    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsedObjects = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
                parsedObjects.push(JSON.parse(trimmed));
            } catch (_) {
                // Ignore non-JSON or partial diagnostic line
            }
        }
    }

    if (parsedObjects.length === 0) {
        try {
            parsedObjects.push(JSON.parse(stdout));
        } catch (_) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Failed to parse media metadata output."
            );
        }
    }

    // Check for playlists across parsed objects
    for (const item of parsedObjects) {
        if (item && item._type === "playlist") {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                "Playlists are not supported. Please submit a single video link."
            );
        }
    }

    // Deterministic selection: pick the first object with recognizable media properties
    const primary = parsedObjects.find(item => item && (item.id || item.title || item.formats || item.url));
    if (!primary) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "No downloadable media was discovered on this page."
        );
    }

    return primary;
}

/**
 * Maps yt-dlp execution failures to standard Reeva ExtractionErrors.
 *
 * @param {Error} err
 * @param {string} stderr
 * @returns {ExtractionError}
 */
function mapGenericYtDlpError(err, stderr = "") {
    const combined = `${err && err.message ? err.message : ""} ${stderr}`.toLowerCase();

    if (combined.includes("timed out") || combined.includes("timeout")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
            "Media extraction timed out."
        );
    }
    if (combined.includes("max-filesize") || combined.includes("file is larger than max-filesize")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "The requested media exceeds the maximum permitted size of 100 MB.",
            { statusCode: 413 }
        );
    }
    if (combined.includes("drm protected") || combined.includes("this video is drm protected")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            "This media is DRM-protected and cannot be downloaded."
        );
    }
    if (combined.includes("playlist")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            "Playlists are not supported. Please submit a single video link."
        );
    }
    if (combined.includes("live event") || combined.includes("is a live stream") || combined.includes("live stream")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            "Live streams are not supported for download."
        );
    }
    if (
        combined.includes("private video") ||
        combined.includes("sign in if you've been granted access") ||
        combined.includes("login required") ||
        combined.includes("the web client only works when logged-in") ||
        combined.includes("account credentials")
    ) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PRIVATE_CONTENT,
            "This content is private or requires authentication."
        );
    }
    if (
        combined.includes("sign in to confirm you're not a bot") ||
        combined.includes("bot") ||
        combined.includes("captcha") ||
        combined.includes("challenge")
    ) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
            "The platform presented a challenge or bot check."
        );
    }
    if (
        combined.includes("video unavailable") ||
        combined.includes("does not exist") ||
        combined.includes("not found") ||
        combined.includes("removed") ||
        combined.includes("unsupported url") ||
        combined.includes("unable to extract") ||
        combined.includes("no video formats found")
    ) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "No downloadable video was found for this link."
        );
    }
    if (combined.includes("ffmpeg") && (combined.includes("not found") || combined.includes("not installed"))) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
            "FFmpeg is required for processing media but is not available on this server."
        );
    }
    if (
        combined.includes("tunnel connection failed: 403") ||
        combined.includes("egress destination blocked") ||
        combined.includes("destination forbidden") ||
        combined.includes("failed security resolution") ||
        combined.includes("ssrf blocked")
    ) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "The requested media destination was blocked by security policy.",
            { statusCode: 403 }
        );
    }

    return new ExtractionError(
        EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
        "Failed to extract media from this link.",
        { originalError: sanitizeErrorDetail(stderr || err.message) }
    );
}

/**
 * Extracts and materializes media from generic / More Sites URLs into a sandboxed local artifact.
 *
 * Enforces:
 * - Subprocess security (shell: false, stdio isolated, bounded buffers)
 * - Safe metadata inspection (DRM check, playlist check, live stream check)
 * - Local file materialization only (never registers or proxies remote CDN URLs)
 * - Strict 100 MB file size ceiling
 * - Automatic cleanup of partial files on failure
 *
 * @param {string} validatedUrl - Pre-validated source URL (via validateGenericSourceUrl)
 * @param {object} [options] - Options (mode, timeoutMs, commandRunner, ytDlpPath, ffmpegPath, requestId)
 * @returns {Promise<{ url: string, localFilePath: string, type: 'video'|'audio', title: string, mode: string, platform: 'generic' }>}
 */
async function extractGeneric(validatedUrl, options = {}) {
    const mode = (options.mode || DEFAULT_GENERIC_MODE).toUpperCase();
    if (!GENERIC_MODES.includes(mode)) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            `Unsupported media mode '${options.mode}'. Supported modes: ${GENERIC_MODES.join(", ")}.`
        );
    }

    const isMocked = Boolean(options.commandRunner || options.execFn);
    const runner = options.commandRunner || options.execFn || defaultCommandRunner;
    const { command, baseArgs } = resolveYtDlpCommand(options.ytDlpPath, isMocked);

    // Resolve controlled loopback egress proxy for network isolation
    let proxyUrl = options.proxyUrl;
    if (!proxyUrl && process.env.REEVA_EGRESS_PROXY_URL) {
        proxyUrl = process.env.REEVA_EGRESS_PROXY_URL.trim();
    }
    if (!proxyUrl && process.env.REEVA_DISABLE_EGRESS_PROXY !== "true") {
        proxyUrl = await ensureEgressProxy();
    }

    // Hardened CLI flags: No config, no cookies, no cache, no playlist, 20s socket timeout
    // Egress proxy enforces outbound SSRF, private network, and redirect protection
    const commonArgs = [
        "--no-playlist",
        "--ignore-config",
        "--no-cache-dir",
        "--no-cookies",
        "--socket-timeout", "20"
    ];

    if (proxyUrl) {
        commonArgs.unshift("--proxy", proxyUrl);
    }

    // Step 1: Probe metadata to verify stream validity, DRM status, and media types
    const metaTimeoutMs = options.metadataTimeoutMs || DEFAULT_METADATA_TIMEOUT_MS;
    const metaArgs = [
        ...baseArgs,
        "-j",
        "--skip-download",
        ...commonArgs,
        validatedUrl
    ];

    let metaRes;
    try {
        metaRes = await runner({ command, args: metaArgs, timeoutMs: metaTimeoutMs });
    } catch (err) {
        if (err instanceof ExtractionError) throw err;
        throw mapGenericYtDlpError(err);
    }

    if (metaRes.exitCode !== 0) {
        throw mapGenericYtDlpError(new Error(`yt-dlp exited with code ${metaRes.exitCode}`), metaRes.stderr);
    }

    const info = parseGenericMetadata(metaRes.stdout);

    // Check for live streams
    if (info.is_live) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            "Live streams are not supported for download."
        );
    }

    // Check for DRM protection
    if (info._has_drm === true || (Array.isArray(info.formats) && info.formats.length > 0 && info.formats.every(f => f.has_drm))) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            "This media is DRM-protected and cannot be downloaded."
        );
    }

    // Step 2: Materialize media into sandboxed local artifact in REEVA_TEMP_DIR
    const tempDir = ensureTempDir();
    const tempId = crypto.randomBytes(16).toString("hex");
    const ext = mode === "AUDIO_ONLY" ? "m4a" : "mp4";
    const tempPrefix = path.join(tempDir, `reeva_gen_${tempId}`);
    const tempFilePath = `${tempPrefix}.${ext}`;

    const ffmpegPath = resolveFfmpegPath(options.ffmpegPath, isMocked);
    const downloadTimeoutMs = options.downloadTimeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS;

    let downloadFormatArgs = [];
    if (mode === "VIDEO_ONLY") {
        downloadFormatArgs = [
            "-f", "bv*[height<=720][ext=mp4]/bv*[height<=720][ext=webm]/bv*[height<=720]/b[height<=720][ext=mp4]/best[height<=720]/best",
            "-o", tempFilePath
        ];
    } else if (mode === "AUDIO_ONLY") {
        if (!ffmpegPath && !isMocked) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
                "Audio extraction is temporarily unavailable because FFmpeg is not configured on this server."
            );
        }
        downloadFormatArgs = [
            "-f", "ba[ext=m4a]/ba[ext=mp3]/ba[ext=webm]/ba/b[height<=720]/best[height<=720]/best",
            "-x",
            "--audio-format", "m4a",
            "-o", tempFilePath,
            "--ffmpeg-location", ffmpegPath
        ];
    } else {
        // VIDEO_AND_AUDIO (requires FFmpeg)
        if (!ffmpegPath && !isMocked) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
                "Video and audio merging is temporarily unavailable because FFmpeg is not configured on this server."
            );
        }
        downloadFormatArgs = [
            "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720][ext=mp4]/best[height<=720]/best",
            "--merge-output-format", "mp4",
            "-o", tempFilePath
        ];
        if (ffmpegPath) {
            downloadFormatArgs.push("--ffmpeg-location", ffmpegPath);
        }
    }

    const downloadArgs = [
        ...baseArgs,
        "-j",
        "--no-simulate",
        ...commonArgs,
        "--max-filesize", "100M",
        ...downloadFormatArgs,
        validatedUrl
    ];

    let downloadRes;
    try {
        downloadRes = await runner({ command, args: downloadArgs, timeoutMs: downloadTimeoutMs });
    } catch (err) {
        cleanupTempFiles(tempPrefix);
        if (err instanceof ExtractionError) throw err;
        throw mapGenericYtDlpError(err);
    }

    if (downloadRes.exitCode !== 0) {
        cleanupTempFiles(tempPrefix);
        throw mapGenericYtDlpError(new Error(`yt-dlp download exited with code ${downloadRes.exitCode}`), downloadRes.stderr);
    }

    // Check if the download was aborted due to exceeding max-filesize
    const combinedStdout = `${downloadRes.stdout || ""} ${downloadRes.stderr || ""}`;
    if (combinedStdout.includes("File is larger than max-filesize") || combinedStdout.includes("max-filesize")) {
        cleanupTempFiles(tempPrefix);
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "The requested media exceeds the maximum permitted size of 100 MB.",
            { statusCode: 413 }
        );
    }

    // Verify materialized artifact on disk
    if (!fs.existsSync(tempFilePath)) {
        cleanupTempFiles(tempPrefix);
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Media artifact was not successfully generated."
        );
    }

    const stat = fs.statSync(tempFilePath);
    if (stat.size === 0) {
        cleanupTempFiles(tempPrefix);
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Media artifact was empty."
        );
    }

    if (stat.size > MAX_GENERIC_MEDIA_SIZE_BYTES) {
        cleanupTempFiles(tempPrefix);
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "The requested media exceeds the maximum permitted size of 100 MB.",
            { statusCode: 413 }
        );
    }

    const title = info.fulltitle || info.title || "Media";

    return {
        url: `file://${tempFilePath}`,
        localFilePath: tempFilePath,
        type: mode === "AUDIO_ONLY" ? "audio" : "video",
        title,
        mode,
        platform: "generic"
    };
}

module.exports = {
    extractGeneric,
    GENERIC_MODES,
    DEFAULT_GENERIC_MODE,
    MAX_GENERIC_MEDIA_SIZE_BYTES,
    parseGenericMetadata,
    mapGenericYtDlpError,
    cleanupTempFiles
};
