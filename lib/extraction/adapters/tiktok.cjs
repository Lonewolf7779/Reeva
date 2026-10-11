// lib/extraction/adapters/tiktok.cjs — Hardened TikTok Public Video Extraction Adapter using yt-dlp
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
const { secureFetch, SecurityHTTPError } = require("../../http-client.cjs");
const { SUPPORTED_SOURCE_DOMAINS, ValidationError } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");

const DEFAULT_METADATA_TIMEOUT_MS = 30000; // 30 seconds for metadata
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000; // 2 minutes for download
const MAX_TIKTOK_MEDIA_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB hard ceiling

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
 * Operates asynchronously to avoid blocking the event loop on failure or cancellation paths.
 *
 * @param {string} tempPrefix
 * @returns {Promise<void>}
 */
async function cleanupTempFiles(tempPrefix) {
    if (!tempPrefix || typeof tempPrefix !== "string") return;
    try {
        const dir = path.dirname(tempPrefix);
        const base = path.basename(tempPrefix);
        let dirHandle;
        try {
            dirHandle = await fs.promises.opendir(dir);
        } catch (_) {
            return;
        }

        try {
            for await (const dirent of dirHandle) {
                if (dirent.name.startsWith(base)) {
                    try {
                        await fs.promises.unlink(path.join(dir, dirent.name));
                    } catch (_) {}
                }
            }
        } catch (_) {}
    } catch (_) {}
}

/**
 * Resolves TikTok short links (vm.tiktok.com, vt.tiktok.com) under Reeva-controlled HTTP boundaries.
 * Enforces TikTok domain allowlist, socket DNS pinning (safeLookup), and max 3 redirects.
 *
 * @param {string} shortUrl
 * @param {object} [options]
 * @returns {Promise<string>} Final resolved destination URL
 */
async function resolveTikTokShortUrl(shortUrl, options = {}) {
    const fetchFn = options.fetchFn || secureFetch;
    const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : 8000;
    const deadlineAt = options.deadlineAt;
    const signal = options.signal;

    if (signal && signal.aborted) {
        throw new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED");
    }

    const { finalUrl, clearTimeout: clearTimer } = await fetchFn(shortUrl, {
        allowedDomains: SUPPORTED_SOURCE_DOMAINS.tiktok,
        maxRedirects: 3,
        timeoutMs,
        deadlineAt,
        signal,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (ReevaBot)"
        }
    });

    if (typeof clearTimer === "function") clearTimer();
    return finalUrl;
}

/**
 * Safely parses newline-separated JSON objects from yt-dlp stdout.
 * Ignores non-JSON diagnostic lines and selects the primary usable media object.
 *
 * @param {string} stdout
 * @returns {object} Selected media metadata object
 */
function parseTikTokMetadata(stdout) {
    if (!stdout || typeof stdout !== "string") {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Empty output from TikTok media extractor."
        );
    }

    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsedObjects = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
                parsedObjects.push(JSON.parse(trimmed));
            } catch (_) {}
        }
    }

    if (parsedObjects.length === 0) {
        try {
            parsedObjects.push(JSON.parse(stdout));
        } catch (_) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Failed to parse TikTok media metadata output."
            );
        }
    }

    for (const item of parsedObjects) {
        if (item && item._type === "playlist") {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                "TikTok user collections and playlists are not supported. Please submit a single video link."
            );
        }
    }

    const primary = parsedObjects.find(item => item && (item.id || item.title || item.formats || item.url));
    if (!primary) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "No downloadable video was discovered on this TikTok page."
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
function mapTikTokYtDlpError(err, stderr = "") {
    const combined = `${err && err.message ? err.message : ""} ${stderr}`.toLowerCase();

    if (combined.includes("timed out") || combined.includes("timeout")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
            "TikTok media extraction timed out."
        );
    }
    if (err && (err.name === "AbortError" || combined.includes("aborted") || combined.includes("cancelled"))) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
            "TikTok extraction was cancelled by client."
        );
    }
    if (combined.includes("max-filesize") || combined.includes("file is larger than max-filesize")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "The requested TikTok media exceeds the maximum permitted size of 100 MB.",
            { statusCode: 413 }
        );
    }
    if (combined.includes("drm protected") || combined.includes("this video is drm protected")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            "This media is DRM-protected and cannot be downloaded."
        );
    }
    if (combined.includes("live event") || combined.includes("is a live stream") || combined.includes("live stream")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            "TikTok live streams are not supported for download."
        );
    }
    if (
        combined.includes("private video") ||
        combined.includes("sign in if you've been granted access") ||
        combined.includes("login required") ||
        combined.includes("account credentials") ||
        combined.includes("video is private")
    ) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PRIVATE_CONTENT,
            "This TikTok video is private or requires authentication."
        );
    }
    if (
        combined.includes("sign in to confirm you're not a bot") ||
        combined.includes("bot") ||
        combined.includes("captcha") ||
        combined.includes("challenge") ||
        combined.includes("waf")
    ) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
            "TikTok presented an authentication challenge or bot check."
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
            "No downloadable video was found for this TikTok link."
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
        "Failed to extract media from this TikTok link.",
        { originalError: sanitizeErrorDetail(stderr || err.message) }
    );
}

/**
 * Extracts and materializes media from validated TikTok URLs into a sandboxed local artifact.
 *
 * @param {string} validatedUrl - Pre-validated TikTok URL
 * @param {object} [options] - Options (runner, ytdlpCommand, signal, metadataTimeoutMs, downloadTimeoutMs, fetchFn)
 * @returns {Promise<{ url: string, localFilePath: string, type: 'video', title: string, platform: 'tiktok' }>}
 */
async function extractTikTok(validatedUrl, options = {}) {
    const runner = options.runner || defaultCommandRunner;
    const isMocked = typeof options.runner === "function";

    let targetUrl = validatedUrl;

    // Check if short URL (vm.tiktok.com or vt.tiktok.com)
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch (_) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Malformed TikTok source URL."
        );
    }

    if (parsedUrl.hostname === "vm.tiktok.com" || parsedUrl.hostname === "vt.tiktok.com") {
        try {
            targetUrl = await resolveTikTokShortUrl(targetUrl, {
                signal: options.signal,
                fetchFn: options.fetchFn
            });
        } catch (err) {
            if (options.signal && options.signal.aborted) {
                throw new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED");
            }
            if (err instanceof SecurityHTTPError || err instanceof SSRFError || err instanceof ValidationError) {
                throw err;
            }
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Could not resolve TikTok short link."
            );
        }
    }

    const { command, baseArgs } = resolveYtDlpCommand(options.ytdlpCommand, isMocked);
    const proxyUrl = ensureEgressProxy();

    const commonArgs = [
        "--no-playlist",
        "--no-call-home",
        "--ignore-config",
        "--no-cache-dir",
        "--no-cookies",
        "--socket-timeout", "10",
        "--retries", "1"
    ];

    if (proxyUrl) {
        commonArgs.unshift("--proxy", proxyUrl);
    }

    // Step 1: Probe metadata with yt-dlp simulation
    const metadataTimeoutMs = options.metadataTimeoutMs || DEFAULT_METADATA_TIMEOUT_MS;
    const metaArgs = [
        ...baseArgs,
        "-j",
        "--simulate",
        ...commonArgs,
        targetUrl
    ];

    let metaRes;
    try {
        metaRes = await runner({ command, args: metaArgs, timeoutMs: metadataTimeoutMs, signal: options.signal });
    } catch (err) {
        if (err instanceof ExtractionError) throw err;
        throw mapTikTokYtDlpError(err);
    }

    if (metaRes.exitCode !== 0) {
        throw mapTikTokYtDlpError(new Error(`yt-dlp exited with code ${metaRes.exitCode}`), metaRes.stderr);
    }

    const info = parseTikTokMetadata(metaRes.stdout);

    if (info._has_drm || info.is_drm) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            "This TikTok video is DRM-protected and cannot be downloaded."
        );
    }

    // Step 2: Materialize media into sandboxed local artifact in REEVA_TEMP_DIR
    const tempDir = ensureTempDir();
    const tempId = crypto.randomBytes(16).toString("hex");
    const tempPrefix = path.join(tempDir, `reeva_tt_${tempId}`);
    const tempFilePath = `${tempPrefix}.mp4`;

    const downloadTimeoutMs = options.downloadTimeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS;

    // Explicit FFmpeg policy:
    // When FFmpeg is explicitly configured, allow merging separate video+audio streams and pass --ffmpeg-location.
    // When FFmpeg is not configured, select only a single-file MP4 container that does not require merging.
    const ffmpegPath = resolveFfmpegPath(options.ffmpegPath, isMocked);

    let formatSelector;
    if (ffmpegPath) {
        formatSelector = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best";
    } else {
        // Single progressive MP4 file with combined video+audio: format must not require merging
        formatSelector = "b[ext=mp4]/best[ext=mp4]";
    }

    const downloadArgs = [
        ...baseArgs,
        "-j",
        "--no-simulate",
        ...commonArgs,
        "--max-filesize", "100M",
        "-f", formatSelector,
        "-o", tempFilePath
    ];

    if (ffmpegPath) {
        downloadArgs.push("--merge-output-format", "mp4");
        downloadArgs.push("--ffmpeg-location", ffmpegPath);
    }

    downloadArgs.push(targetUrl);

    let downloadRes;
    try {
        downloadRes = await runner({ command, args: downloadArgs, timeoutMs: downloadTimeoutMs, signal: options.signal });
    } catch (err) {
        await cleanupTempFiles(tempPrefix);
        if (err instanceof ExtractionError) throw err;
        throw mapTikTokYtDlpError(err);
    }

    if (downloadRes.exitCode !== 0) {
        await cleanupTempFiles(tempPrefix);
        throw mapTikTokYtDlpError(new Error(`yt-dlp download exited with code ${downloadRes.exitCode}`), downloadRes.stderr);
    }

    // Check if the download was aborted due to exceeding max-filesize
    const combinedStdout = `${downloadRes.stdout || ""} ${downloadRes.stderr || ""}`;
    if (combinedStdout.includes("File is larger than max-filesize") || combinedStdout.includes("max-filesize")) {
        await cleanupTempFiles(tempPrefix);
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "The requested TikTok video exceeds the maximum permitted size of 100 MB.",
            { statusCode: 413 }
        );
    }

    // Verify materialized artifact on disk
    let stat;
    try {
        stat = await fs.promises.stat(tempFilePath);
    } catch (err) {
        try {
            await cleanupTempFiles(tempPrefix);
        } catch (_) {}
        if (err.code === "ENOENT" || err.code === "ENOTDIR") {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "TikTok media artifact was not successfully generated."
            );
        }
        throw err;
    }

    if (stat.size === 0) {
        try {
            await cleanupTempFiles(tempPrefix);
        } catch (_) {}
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "TikTok media artifact was empty."
        );
    }

    if (stat.size > MAX_TIKTOK_MEDIA_SIZE_BYTES) {
        try {
            await cleanupTempFiles(tempPrefix);
        } catch (_) {}
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "The requested TikTok video exceeds the maximum permitted size of 100 MB.",
            { statusCode: 413 }
        );
    }

    const title = info.fulltitle || info.title || "TikTok Video";

    return {
        url: `file://${tempFilePath}`,
        localFilePath: tempFilePath,
        type: "video",
        platform: "tiktok",
        title
    };
}

module.exports = {
    extractTikTok,
    parseTikTokMetadata,
    mapTikTokYtDlpError,
    resolveTikTokShortUrl,
    cleanupTempFiles,
    MAX_TIKTOK_MEDIA_SIZE_BYTES
};
