// lib/extraction/adapters/youtube.cjs — YouTube Media Extraction Adapter using yt-dlp
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

const YOUTUBE_MODES = Object.freeze(["VIDEO_ONLY", "AUDIO_ONLY", "VIDEO_AND_AUDIO"]);
const DEFAULT_YOUTUBE_MODE = "VIDEO_AND_AUDIO";

const REEVA_TEMP_DIR = process.env.REEVA_TEMP_DIR || path.join(os.tmpdir(), "reeva_media");

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
 * Resolves the yt-dlp invocation command and arguments.
 */
function resolveYtDlpCommand() {
    if (process.env.YT_DLP_PATH) {
        const custom = process.env.YT_DLP_PATH.trim();
        const parts = custom.split(/\s+/);
        return { command: parts[0], baseArgs: parts.slice(1) };
    }
    return { command: "python", baseArgs: ["-m", "yt_dlp"] };
}

let cachedFfmpegPath = undefined;

/**
 * Resolves FFmpeg binary path if available.
 */
function resolveFfmpegPath() {
    if (process.env.FFMPEG_PATH) {
        return process.env.FFMPEG_PATH.trim();
    }
    if (cachedFfmpegPath !== undefined) {
        return cachedFfmpegPath;
    }
    try {
        const cp = require("child_process");
        const res = cp.spawnSync("python", ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true
        });
        if (res.status === 0 && res.stdout) {
            const p = res.stdout.trim();
            if (p && fs.existsSync(p)) {
                cachedFfmpegPath = p;
                return cachedFfmpegPath;
            }
        }
    } catch (_) {}
    cachedFfmpegPath = null;
    return null;
}

/**
 * Default child process runner using child_process.spawn.
 */
function defaultCommandRunner({ command, args, timeoutMs = 45000 }) {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const proc = spawn(command, args, {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });

        const timer = setTimeout(() => {
            timedOut = true;
            if (process.platform === "win32") {
                try {
                    spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { windowsHide: true });
                } catch (_) {
                    proc.kill();
                }
            } else {
                proc.kill("SIGKILL");
            }
        }, timeoutMs);

        proc.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });

        proc.stderr.on("data", (chunk) => {
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
        { originalError: stderr || err.message }
    );
}

/**
 * Extracts media from a YouTube URL across three explicit modes:
 * - VIDEO_ONLY: Direct video stream without audio
 * - AUDIO_ONLY: Direct audio stream without video
 * - VIDEO_AND_AUDIO: Merged MP4 container with video and audio
 *
 * @param {string} validatedUrl - Pre-validated YouTube source URL
 * @param {object} [options] - Options (mode, timeoutMs, commandRunner/execFn, requestId)
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

    const timeoutMs = options.timeoutMs || (mode === "VIDEO_AND_AUDIO" ? 300000 : 45000);
    const runner = options.commandRunner || options.execFn || defaultCommandRunner;
    const { command, baseArgs } = resolveYtDlpCommand();

    const commonArgs = [
        "--no-playlist",
        "--no-call-home",
        "--ignore-config",
        "--no-cache-dir",
        "--no-cookies"
    ];

    if (mode === "VIDEO_ONLY") {
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

    // Default mode: VIDEO_AND_AUDIO
    const ffmpegPath = resolveFfmpegPath();
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
        "-o", tempFilePath
    ];

    if (ffmpegPath) {
        args.push("--ffmpeg-location", ffmpegPath);
    }

    args.push(validatedUrl);

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
    resolveYtDlpCommand,
    resolveFfmpegPath,
    mapYtDlpError,
    parseYtDlpJson
};
