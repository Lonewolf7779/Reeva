// lib/extraction/adapters/youtube.cjs — Hardened YouTube Extraction Adapter using yt-dlp
"use strict";

require("dotenv").config();
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

const YOUTUBE_MODES = Object.freeze(["VIDEO_ONLY", "AUDIO_ONLY", "VIDEO_AND_AUDIO"]);
const DEFAULT_YOUTUBE_MODE = "VIDEO_AND_AUDIO";

// Bounded stream limits for child process stdout and stderr
const MAX_SUBPROCESS_STDOUT_BYTES = parseInt(
    process.env.MAX_SUBPROCESS_STDOUT_BYTES || String(4 * 1024 * 1024),
    10
); // 4 MB

const MAX_SUBPROCESS_STDERR_BYTES = parseInt(
    process.env.MAX_SUBPROCESS_STDERR_BYTES || String(1 * 1024 * 1024),
    10
); // 1 MB

const DEFAULT_METADATA_TIMEOUT_MS = 45000;
const DEFAULT_MERGE_TIMEOUT_MS = 300000; // 5 minutes for downloading and merging

const REEVA_TEMP_DIR = process.env.REEVA_TEMP_DIR
    ? path.resolve(process.env.REEVA_TEMP_DIR.trim())
    : path.join(os.tmpdir(), "reeva_media");

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
 * Resolves the yt-dlp executable path.
 *
 * Production runtime:
 *   Requires an explicit YT_DLP_PATH pointing to a standalone, version-pinned yt-dlp binary.
 *   The path is treated strictly as an executable path (preserving paths with spaces).
 *
 * Development fallback:
 *   If YT_DLP_PATH is not configured and NODE_ENV !== "production", falls back to "python -m yt_dlp".
 *
 * @param {string} [customPath] - Explicit path override (e.g. for testing)
 * @param {boolean} [isMocked=false] - If true, skips filesystem existence check
 * @returns {{ command: string, baseArgs: string[] }}
 */
function resolveYtDlpCommand(customPath = null, isMocked = false) {
    const configured = customPath || process.env.YT_DLP_PATH;

    if (configured && typeof configured === "string") {
        const rawPath = configured.trim();
        if (rawPath) {
            const resolvedPath = path.resolve(rawPath);
            if (!isMocked && !fs.existsSync(resolvedPath)) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
                    `Configured YT_DLP_PATH does not exist: '${rawPath}'.`
                );
            }
            return { command: resolvedPath, baseArgs: [] };
        }
    }

    if (process.env.NODE_ENV === "production") {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
            "YouTube extraction is not configured on this server (YT_DLP_PATH is required in production)."
        );
    }

    // Explicit non-production development fallback
    return { command: "python", baseArgs: ["-m", "yt_dlp"] };
}

/**
 * Resolves and validates the FFmpeg binary path.
 *
 * Checks process.env.FFMPEG_PATH or explicit parameter.
 * Verifies existence on disk.
 * Production does NOT depend on imageio_ffmpeg or python.
 *
 * @param {string} [customPath] - Explicit path override (e.g. for testing)
 * @param {boolean} [isMocked=false] - If true, skips filesystem existence check
 * @returns {string|null} Resolved executable path or null if not configured
 */
function resolveFfmpegPath(customPath = null, isMocked = false) {
    const configured = customPath || process.env.FFMPEG_PATH;
    if (!configured || typeof configured !== "string") {
        return null;
    }

    const rawPath = configured.trim();
    if (!rawPath) return null;

    const resolved = path.resolve(rawPath);

    if (isMocked) {
        return resolved;
    }

    if (!fs.existsSync(resolved)) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
            `Configured FFMPEG_PATH does not exist: '${rawPath}'.`
        );
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
        const binName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
        const candidate = path.join(resolved, binName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        return resolved;
    }

    return resolved;
}

/**
 * Strips URLs with query strings/signatures to prevent leaking sensitive tokens in error messages.
 */
function sanitizeErrorDetail(raw) {
    if (!raw || typeof raw !== "string") return "";
    return raw.replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]");
}

/**
 * Default child process runner using child_process.spawn with bounded buffer limits.
 */
function defaultCommandRunner({
    command,
    args,
    timeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
    maxStdoutBytes = MAX_SUBPROCESS_STDOUT_BYTES,
    maxStderrBytes = MAX_SUBPROCESS_STDERR_BYTES
}) {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let limitExceeded = false;
        let limitError = null;
        // Sanitize environment: strip proxy bypass and external proxy environment variables
        // so child processes strictly honor Reeva's designated CLI network flags
        const sanitizedEnv = { ...process.env };
        delete sanitizedEnv.HTTP_PROXY;
        delete sanitizedEnv.HTTPS_PROXY;
        delete sanitizedEnv.ALL_PROXY;
        delete sanitizedEnv.http_proxy;
        delete sanitizedEnv.https_proxy;
        delete sanitizedEnv.all_proxy;
        delete sanitizedEnv.NO_PROXY;
        delete sanitizedEnv.no_proxy;

        const proc = spawn(command, args, {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: sanitizedEnv
        });

        const killProc = () => {
            if (process.platform === "win32") {
                try {
                    spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { windowsHide: true });
                } catch (_) {
                    proc.kill();
                }
            } else {
                proc.kill("SIGKILL");
            }
        };

        const timer = setTimeout(() => {
            timedOut = true;
            killProc();
        }, timeoutMs);

        proc.stdout.on("data", (chunk) => {
            if (limitExceeded) return;
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxStdoutBytes) {
                limitExceeded = true;
                limitError = new ExtractionError(
                    EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                    "Subprocess stdout exceeded maximum buffer limit."
                );
                killProc();
                return;
            }
            stdout += chunk.toString("utf8");
        });

        proc.stderr.on("data", (chunk) => {
            if (limitExceeded) return;
            stderrBytes += chunk.length;
            if (stderrBytes > maxStderrBytes) {
                limitExceeded = true;
                limitError = new ExtractionError(
                    EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                    "Subprocess stderr exceeded maximum buffer limit."
                );
                killProc();
                return;
            }
            stderr += chunk.toString("utf8");
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) {
                return reject(new ExtractionError(
                    EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                    "YouTube extraction timed out."
                ));
            }
            if (limitExceeded && limitError) {
                return reject(limitError);
            }
            resolve({ stdout, stderr, exitCode: code });
        });
    });
}

/**
 * Parses JSON output from yt-dlp stdout.
 */
function parseYtDlpJson(stdout) {
    if (!stdout || typeof stdout !== "string") {
        throw new Error("Empty output from yt-dlp");
    }
    const lines = stdout.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith("{") && line.endsWith("}")) {
            try {
                return JSON.parse(line);
            } catch (_) {}
        }
    }
    return JSON.parse(stdout);
}

/**
 * Maps yt-dlp execution failures to standard Reeva ExtractionErrors.
 */
function mapYtDlpError(err, stderr = "") {
    const combined = `${err && err.message ? err.message : ""} ${stderr}`.toLowerCase();

    if (combined.includes("timed out") || combined.includes("timeout")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
            "YouTube extraction timed out."
        );
    }
    if (combined.includes("private video") || combined.includes("sign in if you've been granted access") || combined.includes("login required")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PRIVATE_CONTENT,
            "This YouTube video is private or requires authentication."
        );
    }
    if (combined.includes("sign in to confirm you're not a bot") || combined.includes("bot") || combined.includes("captcha")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
            "YouTube presented a challenge or bot check."
        );
    }
    if (combined.includes("video unavailable") || combined.includes("does not exist") || combined.includes("not found") || combined.includes("removed")) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "YouTube video was not found or is unavailable."
        );
    }
    if (combined.includes("ffmpeg") && (combined.includes("not found") || combined.includes("not installed"))) {
        return new ExtractionError(
            EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
            "FFmpeg is required for merging YouTube video and audio but is not available."
        );
    }
    return new ExtractionError(
        EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
        "Failed to extract media from YouTube.",
        { originalError: sanitizeErrorDetail(stderr || err.message) }
    );
}

/**
 * Extracts media from a YouTube URL across three explicit modes:
 * - VIDEO_ONLY: Direct video stream without audio
 * - AUDIO_ONLY: Direct audio stream without video
 * - VIDEO_AND_AUDIO: Merged MP4 container with video and audio
 *
 * @param {string} validatedUrl - Pre-validated YouTube source URL
 * @param {object} [options] - Options (mode, timeoutMs, commandRunner/execFn, ytDlpPath, ffmpegPath, requestId)
 * @returns {Promise<{ url: string, type: 'video'|'audio', title: string, mode: string, localFilePath?: string }>}
 */
async function extractYouTube(validatedUrl, options = {}) {
    const mode = (options.mode || DEFAULT_YOUTUBE_MODE).toUpperCase();
    if (!YOUTUBE_MODES.includes(mode)) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
            `Unsupported media mode '${options.mode}'. Supported modes: ${YOUTUBE_MODES.join(", ")}.`
        );
    }

    const isMocked = Boolean(options.commandRunner || options.execFn);
    const runner = options.commandRunner || options.execFn || defaultCommandRunner;
    const { command, baseArgs } = resolveYtDlpCommand(options.ytDlpPath, isMocked);

    const commonArgs = [
        "--no-playlist",
        "--no-call-home",
        "--ignore-config",
        "--no-cache-dir",
        "--no-cookies"
    ];

    if (mode === "VIDEO_ONLY") {
        const timeoutMs = options.timeoutMs || DEFAULT_METADATA_TIMEOUT_MS;
        const args = [
            ...baseArgs,
            "-j",
            ...commonArgs,
            "-f", "bv*[height<=720][ext=mp4]/bv*[height<=1080][ext=mp4]/bv*[ext=mp4]/bv*",
            validatedUrl
        ];

        let res;
        try {
            res = await runner({ command, args, timeoutMs });
        } catch (err) {
            if (err instanceof ExtractionError) throw err;
            throw mapYtDlpError(err);
        }

        if (res.exitCode !== 0) {
            throw mapYtDlpError(new Error(`yt-dlp exited with code ${res.exitCode}`), res.stderr);
        }

        let info;
        try {
            info = parseYtDlpJson(res.stdout);
        } catch (_) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Failed to parse YouTube metadata output."
            );
        }

        const streamUrl = info.url || (info.requested_formats && info.requested_formats[0] && info.requested_formats[0].url);
        if (!streamUrl) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                "No video stream URL found for this YouTube video."
            );
        }

        return {
            url: streamUrl,
            type: "video",
            title: info.fulltitle || info.title || "YouTube Video",
            mode: "VIDEO_ONLY"
        };
    }

    if (mode === "AUDIO_ONLY") {
        const timeoutMs = options.timeoutMs || DEFAULT_METADATA_TIMEOUT_MS;
        const args = [
            ...baseArgs,
            "-j",
            ...commonArgs,
            "-f", "ba[ext=m4a]/ba",
            validatedUrl
        ];

        let res;
        try {
            res = await runner({ command, args, timeoutMs });
        } catch (err) {
            if (err instanceof ExtractionError) throw err;
            throw mapYtDlpError(err);
        }

        if (res.exitCode !== 0) {
            throw mapYtDlpError(new Error(`yt-dlp exited with code ${res.exitCode}`), res.stderr);
        }

        let info;
        try {
            info = parseYtDlpJson(res.stdout);
        } catch (_) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Failed to parse YouTube metadata output."
            );
        }

        const streamUrl = info.url || (info.requested_formats && info.requested_formats[0] && info.requested_formats[0].url);
        if (!streamUrl) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                "No audio stream URL found for this YouTube video."
            );
        }

        return {
            url: streamUrl,
            type: "audio",
            title: info.fulltitle || info.title || "YouTube Audio",
            mode: "AUDIO_ONLY"
        };
    }

    // Mode: VIDEO_AND_AUDIO
    // Require explicit FFmpeg path configuration (no implicit python/imageio_ffmpeg fallback)
    const ffmpegPath = resolveFfmpegPath(options.ffmpegPath, isMocked);
    if (!ffmpegPath) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
            "Video and audio merging is temporarily unavailable because FFmpeg is not configured on this server."
        );
    }

    const timeoutMs = options.timeoutMs || DEFAULT_MERGE_TIMEOUT_MS;
    const tempDir = ensureTempDir();
    const tempId = crypto.randomBytes(16).toString("hex");
    const tempFilePath = path.join(tempDir, `reeva_mux_${tempId}.mp4`);

    const args = [
        ...baseArgs,
        "-j",
        "--no-simulate",
        ...commonArgs,
        "--max-filesize", "100M",
        "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", tempFilePath,
        "--ffmpeg-location", ffmpegPath,
        validatedUrl
    ];

    let res;
    try {
        res = await runner({ command, args, timeoutMs });
    } catch (err) {
        try { fs.unlinkSync(tempFilePath); } catch (_) {}
        if (err instanceof ExtractionError) throw err;
        throw mapYtDlpError(err);
    }

    if (res.exitCode !== 0) {
        try { fs.unlinkSync(tempFilePath); } catch (_) {}
        throw mapYtDlpError(new Error(`yt-dlp exited with code ${res.exitCode}`), res.stderr);
    }

    let info;
    try {
        info = parseYtDlpJson(res.stdout);
    } catch (_) {
        try { fs.unlinkSync(tempFilePath); } catch (_) {}
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Failed to parse YouTube metadata output."
        );
    }

    if (!fs.existsSync(tempFilePath)) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Merged media artifact was not generated."
        );
    }

    const upstreamUrl = (info.requested_formats && info.requested_formats[0] && info.requested_formats[0].url) || info.url;
    if (!upstreamUrl) {
        try { fs.unlinkSync(tempFilePath); } catch (_) {}
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "No upstream video format was discovered."
        );
    }

    return {
        url: upstreamUrl,
        localFilePath: tempFilePath,
        type: "video",
        title: info.fulltitle || info.title || "YouTube Video",
        mode: "VIDEO_AND_AUDIO"
    };
}

module.exports = {
    extractYouTube,
    YOUTUBE_MODES,
    DEFAULT_YOUTUBE_MODE,
    REEVA_TEMP_DIR,
    MAX_SUBPROCESS_STDOUT_BYTES,
    MAX_SUBPROCESS_STDERR_BYTES,
    resolveYtDlpCommand,
    resolveFfmpegPath,
    sanitizeErrorDetail,
    mapYtDlpError,
    parseYtDlpJson,
    defaultCommandRunner
};
