// lib/media-processor/ffmpeg-runner.cjs — Secure FFmpeg & ffprobe Processing Engine
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ================== RESOURCE & EXECUTION LIMITS ==================
const DEFAULT_EXECUTION_TIMEOUT_MS = parseInt(process.env.MEDIA_PROCESS_TIMEOUT_MS || "120000", 10); // 2 min
const MAX_EXECUTION_TIMEOUT_MS = 300000; // 5 min hard cap
const DEFAULT_PROBE_TIMEOUT_MS = 15000; // 15s for ffprobe
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024; // 4 MB
const DEFAULT_MAX_STDERR_BYTES = 1 * 1024 * 1024; // 1 MB
const DEFAULT_MAX_INPUT_BYTES = parseInt(process.env.MAX_MEDIA_SIZE_BYTES || String(250 * 1024 * 1024), 10); // 250 MB
const DEFAULT_MAX_OUTPUT_BYTES = parseInt(process.env.MAX_PROCESSED_MEDIA_BYTES || String(250 * 1024 * 1024), 10); // 250 MB
const DEFAULT_MAX_DURATION_SECONDS = 1800; // 30 minutes
const DEFAULT_FFMPEG_THREADS = Math.min(4, Math.max(1, parseInt(process.env.FFMPEG_THREADS || "2", 10) || 2));
const DEFAULT_MAX_CONCURRENT_JOBS = Math.max(1, parseInt(process.env.MAX_MEDIA_PROCESSING_CONCURRENCY || "2", 10) || 2);

const MEDIA_PROCESSOR_ERROR_CODES = Object.freeze({
    INVALID_BINARY_PATH: "INVALID_BINARY_PATH",
    BINARY_NOT_FOUND: "BINARY_NOT_FOUND",
    INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
    INVALID_PROFILE: "INVALID_PROFILE",
    PATH_TRAVERSAL: "PATH_TRAVERSAL",
    INPUT_NOT_FOUND: "INPUT_NOT_FOUND",
    INPUT_TOO_LARGE: "INPUT_TOO_LARGE",
    OUTPUT_TOO_LARGE: "OUTPUT_TOO_LARGE",
    EXECUTION_TIMEOUT: "EXECUTION_TIMEOUT",
    PROCESS_ABORTED: "PROCESS_ABORTED",
    PROCESS_FAILED: "PROCESS_FAILED",
    BUFFER_LIMIT_EXCEEDED: "BUFFER_LIMIT_EXCEEDED",
    CONCURRENCY_LIMIT: "CONCURRENCY_LIMIT",
    STORAGE_ERROR: "STORAGE_ERROR"
});

class MediaProcessingError extends Error {
    /**
     * @param {string} code
     * @param {string} publicMessage - Safe message without sensitive filesystem paths
     * @param {object} [options={}]
     */
    constructor(code, publicMessage, options = {}) {
        super(publicMessage);
        this.name = "MediaProcessingError";
        this.code = code;
        this.publicMessage = publicMessage;
        this.statusCode = options.statusCode || 500;
        if (options.exitCode !== undefined) this.exitCode = options.exitCode;
        if (options.signal !== undefined) this.signal = options.signal;
    }
}

// ================== ALLOWLISTED PROCESSING PROFILES ==================
const COMPRESSION_PRESETS = Object.freeze({
    compact: Object.freeze({ crf: "30", preset: "faster", audioBitrate: "96k" }),
    balanced: Object.freeze({ crf: "26", preset: "veryfast", audioBitrate: "128k" }),
    high_quality: Object.freeze({ crf: "22", preset: "medium", audioBitrate: "192k" })
});

const CONVERSION_FORMATS = Object.freeze({
    mp4: Object.freeze({ ext: "mp4", format: "mp4", videoCodec: "libx264", audioCodec: "aac" }),
    webm: Object.freeze({ ext: "webm", format: "webm", videoCodec: "libvpx-vp9", audioCodec: "libopus" }),
    mov: Object.freeze({ ext: "mov", format: "mov", videoCodec: "libx264", audioCodec: "aac" })
});

const AUDIO_EXTRACTION_FORMATS = Object.freeze({
    mp3: Object.freeze({ ext: "mp3", codec: "libmp3lame", allowedBitrates: Object.freeze(["128k", "192k", "320k"]), defaultBitrate: "192k" }),
    aac: Object.freeze({ ext: "m4a", codec: "aac", allowedBitrates: Object.freeze(["128k", "192k"]), defaultBitrate: "192k" }),
    opus: Object.freeze({ ext: "opus", codec: "libopus", allowedBitrates: Object.freeze(["96k", "128k", "192k"]), defaultBitrate: "128k" }),
    wav: Object.freeze({ ext: "wav", codec: "pcm_s16le", allowedBitrates: Object.freeze([]), defaultBitrate: null })
});

const RESIZE_PRESETS = Object.freeze({
    portrait_1080x1920: Object.freeze({ width: 1080, height: 1920 }),
    square_1080x1080: Object.freeze({ width: 1080, height: 1080 }),
    landscape_1920x1080: Object.freeze({ width: 1920, height: 1080 }),
    hd_1280x720: Object.freeze({ width: 1280, height: 720 }),
    sd_854x480: Object.freeze({ width: 854, height: 480 })
});

const RESIZE_FIT_MODES = Object.freeze(["contain", "cover"]);
const TRIM_MODES = Object.freeze(["fast_copy", "accurate"]);

const PROCESSING_OPERATIONS = Object.freeze([
    "compress",
    "convert",
    "extract_audio",
    "trim",
    "resize"
]);

// ================== PATH & BINARY VALIDATION ==================
function resolveTempRootDir(customBaseDir = null) {
    const raw = customBaseDir || process.env.REEVA_TEMP_DIR || path.join(os.tmpdir(), "reeva_media");
    if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.STORAGE_ERROR,
            "Temporary media storage directory configuration is invalid.",
            { statusCode: 500 }
        );
    }
    return path.resolve(raw.trim());
}

/**
 * Ensures a file path stays strictly inside the designated base directory.
 * Rejects null bytes, relative traversal ('..'), root paths, and symlinks escaping baseDir.
 *
 * @param {string} targetPath
 * @param {string} baseDir
 * @param {object} [options={}]
 * @param {boolean} [options.mustExist=false]
 * @returns {string} Resolved canonical path
 */
function validateContainedPath(targetPath, baseDir, options = {}) {
    if (!targetPath || typeof targetPath !== "string" || !targetPath.trim()) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.PATH_TRAVERSAL,
            "Invalid media file path.",
            { statusCode: 400 }
        );
    }

    if (targetPath.includes("\0") || /[\r\n]/.test(targetPath)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.PATH_TRAVERSAL,
            "Media file path contains forbidden characters.",
            { statusCode: 400 }
        );
    }

    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.isAbsolute(targetPath.trim())
        ? path.resolve(targetPath.trim())
        : path.resolve(resolvedBase, targetPath.trim());

    const rel = path.relative(resolvedBase, resolvedTarget);
    if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.PATH_TRAVERSAL,
            "Media file path escapes permitted temporary storage.",
            { statusCode: 400 }
        );
    }

    const baseReal = fs.existsSync(resolvedBase) ? fs.realpathSync(resolvedBase) : resolvedBase;

    if (options.mustExist) {
        if (!fs.existsSync(resolvedTarget)) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INPUT_NOT_FOUND,
                "Requested input media file was not found.",
                { statusCode: 404 }
            );
        }
        const realTarget = fs.realpathSync(resolvedTarget);
        const realRel = path.relative(baseReal, realTarget);
        if (!realRel || realRel === "." || realRel.startsWith("..") || path.isAbsolute(realRel)) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.PATH_TRAVERSAL,
                "Media file symlink escapes permitted temporary storage.",
                { statusCode: 400 }
            );
        }
        const stat = fs.statSync(realTarget);
        if (!stat.isFile()) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INPUT_NOT_FOUND,
                "Input media path is not a regular file.",
                { statusCode: 400 }
            );
        }
        return realTarget;
    }

    // For output paths, verify existing parent directory does not escape baseReal via symlink
    const parentDir = path.dirname(resolvedTarget);
    if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        const parentRel = path.relative(baseReal, realParent);
        if (parentRel.startsWith("..") || path.isAbsolute(parentRel)) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.PATH_TRAVERSAL,
                "Output directory escapes permitted temporary storage.",
                { statusCode: 400 }
            );
        }
    }

    return resolvedTarget;
}

/**
 * Resolves and validates the ffmpeg or ffprobe executable path without leaking filesystem paths.
 *
 * @param {"ffmpeg"|"ffprobe"} binaryKind
 * @param {string|null} [customPath=null]
 * @param {object} [options={}]
 * @param {boolean} [options.skipExistsCheck=false]
 * @returns {string}
 */
function resolveBinaryPath(binaryKind, customPath = null, options = {}) {
    if (binaryKind !== "ffmpeg" && binaryKind !== "ffprobe") {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_BINARY_PATH,
            "Unsupported media binary requested.",
            { statusCode: 500 }
        );
    }

    const binFileName = process.platform === "win32" ? `${binaryKind}.exe` : binaryKind;
    let raw = customPath;

    if (!raw) {
        if (binaryKind === "ffmpeg") {
            raw = process.env.FFMPEG_PATH;
        } else {
            raw = process.env.FFPROBE_PATH;
            // Derive sibling ffprobe from FFMPEG_PATH when FFPROBE_PATH is unset
            if (!raw && process.env.FFMPEG_PATH && typeof process.env.FFMPEG_PATH === "string") {
                const ffmpegResolved = path.resolve(process.env.FFMPEG_PATH.trim());
                const siblingDir = fs.existsSync(ffmpegResolved) && fs.statSync(ffmpegResolved).isDirectory()
                    ? ffmpegResolved
                    : path.dirname(ffmpegResolved);
                raw = path.join(siblingDir, binFileName);
            }
        }
    }

    if (!raw || typeof raw !== "string" || !raw.trim() || raw.includes("\0") || /[\r\n]/.test(raw)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.BINARY_NOT_FOUND,
            `Required ${binaryKind} executable is not configured.`,
            { statusCode: 503 }
        );
    }

    const resolved = path.resolve(raw.trim());
    if (options.skipExistsCheck) {
        return resolved;
    }

    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch (_) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.BINARY_NOT_FOUND,
            `Required ${binaryKind} executable is unavailable.`,
            { statusCode: 503 }
        );
    }

    if (stat.isDirectory()) {
        const candidate = path.join(resolved, binFileName);
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_BINARY_PATH,
                `Configured ${binaryKind} path is a directory without a valid executable.`,
                { statusCode: 503 }
            );
        }
        return candidate;
    }

    if (!stat.isFile()) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_BINARY_PATH,
            `Configured ${binaryKind} path is not a regular executable file.`,
            { statusCode: 503 }
        );
    }

    return resolved;
}

/**
 * Validates raw argument arrays before passing to spawn(..., { shell: false }).
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function validateSpawnArgs(args) {
    if (!Array.isArray(args)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
            "Media processor arguments must be an array.",
            { statusCode: 400 }
        );
    }

    const clean = [];
    for (const arg of args) {
        if (typeof arg !== "string" || arg.includes("\0") || /[\r\n]/.test(arg)) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                "Media processor arguments contain invalid values.",
                { statusCode: 400 }
            );
        }
        clean.push(arg);
    }
    return clean;
}

// ================== CHILD PROCESS EXECUTION ==================
function createSanitizedEnv() {
    const sanitizedEnv = { ...process.env };
    delete sanitizedEnv.HTTP_PROXY;
    delete sanitizedEnv.HTTPS_PROXY;
    delete sanitizedEnv.ALL_PROXY;
    delete sanitizedEnv.http_proxy;
    delete sanitizedEnv.https_proxy;
    delete sanitizedEnv.all_proxy;
    delete sanitizedEnv.NO_PROXY;
    delete sanitizedEnv.no_proxy;
    return sanitizedEnv;
}

function terminateChildProcess(proc) {
    if (!proc || proc.killed) return;
    if (process.platform === "win32" && proc.pid) {
        try {
            spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
                shell: false,
                windowsHide: true,
                stdio: "ignore"
            });
            return;
        } catch (_) {
            // Fall back to proc.kill
        }
    }
    try {
        proc.kill("SIGTERM");
        const forceTimer = setTimeout(() => {
            try {
                if (!proc.killed) proc.kill("SIGKILL");
            } catch (_) {}
        }, 1000);
        if (forceTimer.unref) forceTimer.unref();
    } catch (_) {}
}

/**
 * Executes a validated binary (ffmpeg or ffprobe) via child_process.spawn with shell: false.
 * Enforces -nostdin for ffmpeg, bounded stdout/stderr buffers, timeout, and AbortSignal cancellation.
 *
 * @param {object} params
 * @param {"ffmpeg"|"ffprobe"} params.binary
 * @param {string[]} params.args
 * @param {string|null} [params.binaryPath]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.maxStdoutBytes]
 * @param {number} [params.maxStderrBytes]
 * @param {AbortSignal|null} [params.signal]
 * @param {boolean} [params.skipExistsCheck]
 * @param {Function} [params.spawnFn] - Injectable for isolated testing
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function executeBinary({
    binary,
    args,
    binaryPath = null,
    timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
    maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
    signal = null,
    skipExistsCheck = false,
    spawnFn = spawn
}) {
    const executable = resolveBinaryPath(binary, binaryPath, { skipExistsCheck });
    const validatedArgs = validateSpawnArgs(args);

    const finalArgs = binary === "ffmpeg" && !validatedArgs.includes("-nostdin")
        ? ["-nostdin", ...validatedArgs]
        : validatedArgs;

    const effectiveTimeoutMs = Math.min(
        MAX_EXECUTION_TIMEOUT_MS,
        Math.max(100, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_EXECUTION_TIMEOUT_MS)
    );

    if (signal && signal.aborted) {
        return Promise.reject(
            new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.PROCESS_ABORTED,
                "Media processing was cancelled.",
                { statusCode: 499 }
            )
        );
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let bufferExceeded = false;
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timer = null;
        let abortListener = null;

        const finish = (err, result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (signal && abortListener) {
                try {
                    signal.removeEventListener("abort", abortListener);
                } catch (_) {}
            }
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        };

        let proc;
        try {
            proc = spawnFn(executable, finalArgs, {
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: createSanitizedEnv()
            });
        } catch (err) {
            return finish(
                new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED,
                    `Failed to start ${binary} process.`,
                    { statusCode: 500 }
                )
            );
        }

        timer = setTimeout(() => {
            timedOut = true;
            terminateChildProcess(proc);
        }, effectiveTimeoutMs);
        if (timer.unref) timer.unref();

        if (signal) {
            abortListener = () => {
                aborted = true;
                terminateChildProcess(proc);
            };
            signal.addEventListener("abort", abortListener, { once: true });
        }

        if (proc.stdout) {
            proc.stdout.on("data", (chunk) => {
                stdoutBytes += chunk.length;
                if (stdoutBytes > maxStdoutBytes) {
                    bufferExceeded = true;
                    terminateChildProcess(proc);
                    return;
                }
                stdout += chunk.toString("utf8");
            });
        }

        if (proc.stderr) {
            proc.stderr.on("data", (chunk) => {
                stderrBytes += chunk.length;
                if (stderrBytes > maxStderrBytes) {
                    bufferExceeded = true;
                    terminateChildProcess(proc);
                    return;
                }
                stderr += chunk.toString("utf8");
            });
        }

        proc.on("error", (err) => {
            if (err && err.code === "ENOENT") {
                return finish(
                    new MediaProcessingError(
                        MEDIA_PROCESSOR_ERROR_CODES.BINARY_NOT_FOUND,
                        `Required ${binary} executable is unavailable.`,
                        { statusCode: 503 }
                    )
                );
            }
            return finish(
                new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED,
                    `Failed to execute ${binary} process.`,
                    { statusCode: 500 }
                )
            );
        });

        proc.on("close", (code, sig) => {
            if (aborted) {
                return finish(
                    new MediaProcessingError(
                        MEDIA_PROCESSOR_ERROR_CODES.PROCESS_ABORTED,
                        "Media processing was cancelled.",
                        { statusCode: 499, signal: sig || undefined }
                    )
                );
            }
            if (timedOut) {
                return finish(
                    new MediaProcessingError(
                        MEDIA_PROCESSOR_ERROR_CODES.EXECUTION_TIMEOUT,
                        "Media processing timed out.",
                        { statusCode: 504, signal: sig || undefined }
                    )
                );
            }
            if (bufferExceeded) {
                return finish(
                    new MediaProcessingError(
                        MEDIA_PROCESSOR_ERROR_CODES.BUFFER_LIMIT_EXCEEDED,
                        "Media processor output exceeded buffer limits.",
                        { statusCode: 500 }
                    )
                );
            }
            if (code !== 0) {
                return finish(
                    new MediaProcessingError(
                        MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED,
                        `Media processing exited abnormally (code ${code === null ? "signal" : code}).`,
                        { statusCode: 422, exitCode: code, signal: sig || undefined }
                    )
                );
            }

            return finish(null, { stdout, stderr, exitCode: 0 });
        });
    });
}

// ================== PROFILE VALIDATION & ARG BUILDER ==================
function assertNoUnknownKeys(obj, allowedKeys, contextName) {
    for (const key of Object.keys(obj)) {
        if (!allowedKeys.includes(key)) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                `Unsupported option '${key}' for ${contextName}.`,
                { statusCode: 400 }
            );
        }
    }
}

/**
 * Validates a processing profile request and returns normalized server-side parameters + output extension.
 * Rejects arbitrary FFmpeg flags, filter strings, and unallowlisted codecs/formats.
 *
 * @param {object} profileRequest
 * @returns {object} Normalized profile specification
 */
function validateProcessingProfile(profileRequest) {
    if (!profileRequest || typeof profileRequest !== "object" || Array.isArray(profileRequest)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
            "Processing profile must be a valid object.",
            { statusCode: 400 }
        );
    }

    const operation = typeof profileRequest.operation === "string"
        ? profileRequest.operation.trim().toLowerCase()
        : "";

    if (!PROCESSING_OPERATIONS.includes(operation)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
            `Unsupported media processing operation '${operation || "unknown"}'.`,
            { statusCode: 400 }
        );
    }

    const options = profileRequest.options === undefined ? {} : profileRequest.options;
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
            "Processing profile options must be an object.",
            { statusCode: 400 }
        );
    }

    if (operation === "compress") {
        assertNoUnknownKeys(options, ["preset"], "compress");
        const presetName = typeof options.preset === "string" ? options.preset.trim().toLowerCase() : "balanced";
        const preset = COMPRESSION_PRESETS[presetName];
        if (!preset) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                `Unsupported compression preset '${presetName}'.`,
                { statusCode: 400 }
            );
        }
        return { operation, presetName, preset, outputExt: "mp4" };
    }

    if (operation === "convert") {
        assertNoUnknownKeys(options, ["format", "remux"], "convert");
        const formatName = typeof options.format === "string" ? options.format.trim().toLowerCase() : "";
        const spec = CONVERSION_FORMATS[formatName];
        if (!spec) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                `Unsupported conversion target format '${formatName || "unknown"}'.`,
                { statusCode: 400 }
            );
        }
        const remux = options.remux === true;
        if (options.remux !== undefined && typeof options.remux !== "boolean") {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                "Option 'remux' must be a boolean.",
                { statusCode: 400 }
            );
        }
        return { operation, formatName, spec, remux, outputExt: spec.ext };
    }

    if (operation === "extract_audio") {
        assertNoUnknownKeys(options, ["format", "bitrate", "stripMetadata"], "extract_audio");
        const formatName = typeof options.format === "string" ? options.format.trim().toLowerCase() : "mp3";
        const spec = AUDIO_EXTRACTION_FORMATS[formatName];
        if (!spec) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                `Unsupported audio extraction format '${formatName}'.`,
                { statusCode: 400 }
            );
        }

        let bitrate = spec.defaultBitrate;
        if (options.bitrate !== undefined) {
            const rawBitrate = typeof options.bitrate === "string" ? options.bitrate.trim().toLowerCase() : "";
            if (!spec.allowedBitrates.includes(rawBitrate)) {
                throw new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                    `Unsupported audio bitrate '${rawBitrate}' for ${formatName}.`,
                    { statusCode: 400 }
                );
            }
            bitrate = rawBitrate;
        }

        const stripMetadata = options.stripMetadata !== false;
        return { operation, formatName, spec, bitrate, stripMetadata, outputExt: spec.ext };
    }

    if (operation === "trim") {
        assertNoUnknownKeys(options, ["startSeconds", "endSeconds", "durationSeconds", "mode"], "trim");
        const startSeconds = Number(options.startSeconds ?? 0);
        if (!Number.isFinite(startSeconds) || startSeconds < 0) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                "Trim startSeconds must be a non-negative finite number.",
                { statusCode: 400 }
            );
        }

        let durationSeconds;
        if (options.durationSeconds !== undefined) {
            durationSeconds = Number(options.durationSeconds);
        } else if (options.endSeconds !== undefined) {
            const endSeconds = Number(options.endSeconds);
            if (!Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
                throw new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                    "Trim endSeconds must be greater than startSeconds.",
                    { statusCode: 400 }
                );
            }
            durationSeconds = endSeconds - startSeconds;
        } else {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                "Trim requires either endSeconds or durationSeconds.",
                { statusCode: 400 }
            );
        }

        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > DEFAULT_MAX_DURATION_SECONDS) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                `Trim duration must be between 0 and ${DEFAULT_MAX_DURATION_SECONDS} seconds.`,
                { statusCode: 400 }
            );
        }

        const mode = typeof options.mode === "string" ? options.mode.trim().toLowerCase() : "fast_copy";
        if (!TRIM_MODES.includes(mode)) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                `Unsupported trim mode '${mode}'.`,
                { statusCode: 400 }
            );
        }

        return { operation, startSeconds, durationSeconds, mode, outputExt: "mp4" };
    }

    // operation === "resize"
    assertNoUnknownKeys(options, ["preset", "fit"], "resize");
    const presetName = typeof options.preset === "string" ? options.preset.trim().toLowerCase() : "";
    const dimensions = RESIZE_PRESETS[presetName];
    if (!dimensions) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
            `Unsupported resize preset '${presetName || "unknown"}'.`,
            { statusCode: 400 }
        );
    }

    const fit = typeof options.fit === "string" ? options.fit.trim().toLowerCase() : "contain";
    if (!RESIZE_FIT_MODES.includes(fit)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
            `Unsupported resize fit mode '${fit}'.`,
            { statusCode: 400 }
        );
    }

    return { operation, presetName, dimensions, fit, outputExt: "mp4" };
}

/**
 * Builds an explicit, injection-free FFmpeg argument array from a validated profile.
 *
 * @param {object} validatedProfile
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {object} [limits={}]
 * @returns {string[]}
 */
function buildFfmpegArgs(validatedProfile, inputPath, outputPath, limits = {}) {
    const threads = Math.min(4, Math.max(1, parseInt(limits.threads || DEFAULT_FFMPEG_THREADS, 10) || DEFAULT_FFMPEG_THREADS));
    const maxOutputBytes = Math.max(1024, parseInt(limits.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES, 10) || DEFAULT_MAX_OUTPUT_BYTES);
    const maxDurationSeconds = Math.min(
        DEFAULT_MAX_DURATION_SECONDS,
        Math.max(1, parseInt(limits.maxDurationSeconds || DEFAULT_MAX_DURATION_SECONDS, 10) || DEFAULT_MAX_DURATION_SECONDS)
    );

    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];

    if (validatedProfile.operation === "trim") {
        args.push(
            "-ss", String(validatedProfile.startSeconds),
            "-i", inputPath,
            "-t", String(validatedProfile.durationSeconds),
            "-threads", String(threads),
            "-fs", String(maxOutputBytes)
        );
        if (validatedProfile.mode === "fast_copy") {
            args.push("-c", "copy");
        } else {
            args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k");
        }
        args.push("-movflags", "+faststart", "-f", "mp4", outputPath);
        return args;
    }

    args.push("-i", inputPath, "-t", String(maxDurationSeconds), "-threads", String(threads), "-fs", String(maxOutputBytes));

    switch (validatedProfile.operation) {
        case "compress": {
            const { crf, preset, audioBitrate } = validatedProfile.preset;
            args.push(
                "-c:v", "libx264",
                "-preset", preset,
                "-crf", crf,
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", audioBitrate,
                "-movflags", "+faststart",
                "-f", "mp4",
                outputPath
            );
            break;
        }
        case "convert": {
            const { spec, remux } = validatedProfile;
            if (remux && spec.format !== "webm") {
                args.push("-c", "copy");
            } else {
                args.push("-c:v", spec.videoCodec, "-c:a", spec.audioCodec);
                if (spec.videoCodec === "libx264") {
                    args.push("-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
                }
            }
            if (spec.format === "mp4" || spec.format === "mov") {
                args.push("-movflags", "+faststart");
            }
            args.push("-f", spec.format, outputPath);
            break;
        }
        case "extract_audio": {
            const { spec, bitrate, stripMetadata } = validatedProfile;
            args.push("-vn", "-c:a", spec.codec);
            if (bitrate) {
                args.push("-b:a", bitrate);
            }
            if (stripMetadata) {
                args.push("-map_metadata", "-1");
            }
            args.push(outputPath);
            break;
        }
        case "resize": {
            const { width, height } = validatedProfile.dimensions;
            const filter = validatedProfile.fit === "cover"
                ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
                : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
            args.push(
                "-vf", filter,
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "24",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "128k",
                "-movflags", "+faststart",
                "-f", "mp4",
                outputPath
            );
            break;
        }
    }

    return args;
}

// ================== CONCURRENCY & CLEANUP ==================
function createProcessingLimiter(maxConcurrent = DEFAULT_MAX_CONCURRENT_JOBS) {
    const cap = Math.max(1, parseInt(maxConcurrent, 10) || DEFAULT_MAX_CONCURRENT_JOBS);
    let active = 0;

    return {
        acquire() {
            if (active >= cap) {
                throw new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.CONCURRENCY_LIMIT,
                    "Media processor is at maximum concurrent capacity. Please retry shortly.",
                    { statusCode: 429 }
                );
            }
            active += 1;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                active = Math.max(0, active - 1);
            };
        },
        getActiveCount: () => active,
        getMaxConcurrent: () => cap
    };
}

const defaultProcessingLimiter = createProcessingLimiter();

async function safeUnlink(filePath) {
    if (!filePath || typeof filePath !== "string") return;
    try {
        await fs.promises.unlink(filePath);
    } catch (_) {
        // Ignore missing/already-removed files
    }
}

// ================== PUBLIC ENGINE API ==================
/**
 * Probes a contained media file using ffprobe with bounded output and strict JSON parsing.
 */
async function probeMediaFile(inputPath, options = {}) {
    const baseDir = resolveTempRootDir(options.baseDir);
    const safeInput = validateContainedPath(inputPath, baseDir, { mustExist: true });

    const maxInputBytes = options.maxInputBytes || DEFAULT_MAX_INPUT_BYTES;
    const stat = fs.statSync(safeInput);
    if (stat.size > maxInputBytes) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INPUT_TOO_LARGE,
            "Input media file exceeds maximum permitted size.",
            { statusCode: 413 }
        );
    }

    const args = [
        "-v", "error",
        "-show_format",
        "-show_streams",
        "-of", "json",
        safeInput
    ];

    const res = await executeBinary({
        binary: "ffprobe",
        args,
        binaryPath: options.ffprobePath || null,
        timeoutMs: options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS,
        signal: options.signal || null,
        skipExistsCheck: Boolean(options.skipExistsCheck),
        spawnFn: options.spawnFn || spawn
    });

    try {
        return JSON.parse(res.stdout || "{}");
    } catch (_) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED,
            "Failed to parse media probe output.",
            { statusCode: 422 }
        );
    }
}

/**
 * Processes a contained input media file using an allowlisted server-side profile.
 * Enforces input/output bounds, concurrency limits, timeouts, cancellation, and temp cleanup on failure.
 */
async function processMedia({ inputPath, outputFileName = null, profile }, options = {}) {
    const validatedProfile = validateProcessingProfile(profile);
    const baseDir = resolveTempRootDir(options.baseDir);
    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
    }

    const safeInput = validateContainedPath(inputPath, baseDir, { mustExist: true });
    const maxInputBytes = options.maxInputBytes || DEFAULT_MAX_INPUT_BYTES;
    const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;

    const inputStat = fs.statSync(safeInput);
    if (inputStat.size > maxInputBytes) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INPUT_TOO_LARGE,
            "Input media file exceeds maximum permitted size.",
            { statusCode: 413 }
        );
    }

    const targetName = outputFileName || `proc_${crypto.randomBytes(12).toString("hex")}.${validatedProfile.outputExt}`;
    const safeOutput = validateContainedPath(targetName, baseDir, { mustExist: false });

    const limiter = options.limiter || defaultProcessingLimiter;
    const release = limiter.acquire();

    try {
        const args = buildFfmpegArgs(validatedProfile, safeInput, safeOutput, {
            threads: options.threads,
            maxOutputBytes,
            maxDurationSeconds: options.maxDurationSeconds
        });

        await executeBinary({
            binary: "ffmpeg",
            args,
            binaryPath: options.ffmpegPath || null,
            timeoutMs: options.timeoutMs || DEFAULT_EXECUTION_TIMEOUT_MS,
            signal: options.signal || null,
            skipExistsCheck: Boolean(options.skipExistsCheck),
            spawnFn: options.spawnFn || spawn
        });

        if (!fs.existsSync(safeOutput)) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED,
                "Media processing did not produce an output file.",
                { statusCode: 500 }
            );
        }

        const outStat = fs.statSync(safeOutput);
        if (outStat.size > maxOutputBytes) {
            await safeUnlink(safeOutput);
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.OUTPUT_TOO_LARGE,
                "Processed media output exceeded maximum permitted size.",
                { statusCode: 413 }
            );
        }

        return {
            outputPath: safeOutput,
            outputSizeBytes: outStat.size,
            operation: validatedProfile.operation,
            outputExt: validatedProfile.outputExt
        };
    } catch (err) {
        await safeUnlink(safeOutput);
        throw err;
    } finally {
        release();
    }
}

module.exports = {
    MEDIA_PROCESSOR_ERROR_CODES,
    MediaProcessingError,
    COMPRESSION_PRESETS,
    CONVERSION_FORMATS,
    AUDIO_EXTRACTION_FORMATS,
    RESIZE_PRESETS,
    RESIZE_FIT_MODES,
    TRIM_MODES,
    PROCESSING_OPERATIONS,
    DEFAULT_EXECUTION_TIMEOUT_MS,
    MAX_EXECUTION_TIMEOUT_MS,
    DEFAULT_MAX_INPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_CONCURRENT_JOBS,
    resolveTempRootDir,
    validateContainedPath,
    resolveBinaryPath,
    validateSpawnArgs,
    executeBinary,
    validateProcessingProfile,
    buildFfmpegArgs,
    createProcessingLimiter,
    defaultProcessingLimiter,
    safeUnlink,
    probeMediaFile,
    processMedia
};
