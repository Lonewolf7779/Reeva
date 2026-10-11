// lib/config.cjs — Centralized Server Configuration Parsing and Validation
"use strict";

const proxyaddr = require("proxy-addr");

class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConfigError";
    }
}

/**
 * Strictly parses and validates the TRUST_PROXY configuration value.
 *
 * Supported values:
 * - unset / empty / undefined -> false (direct Internet traffic, no proxy trusted)
 * - "false" / false / "0" -> false
 * - "true" / true -> boolean true (trusted reverse proxy where all hops are trusted)
 * - positive integer string (e.g. "1", "2") -> parsed integer (exact number of trusted upstream proxy hops)
 * - valid Express subnet / CIDR / IP string (e.g. 'loopback', '10.0.0.0/8', 'linklocal') -> validated string
 *
 * @param {string|boolean|number|undefined} raw
 * @returns {boolean|number|string} Validated Express trust proxy setting
 * @throws {ConfigError} If an invalid or unparseable proxy configuration is supplied
 */
function parseTrustProxy(raw) {
    if (raw === undefined || raw === null || raw === "") {
        return false;
    }

    if (typeof raw === "boolean") {
        return raw;
    }

    if (typeof raw === "number") {
        if (Number.isInteger(raw) && raw >= 0) {
            return raw === 0 ? false : raw;
        }
        throw new ConfigError(`Invalid TRUST_PROXY numeric value: ${raw}. Must be a non-negative integer.`);
    }

    if (typeof raw !== "string") {
        throw new ConfigError("Invalid TRUST_PROXY configuration: value must be a string, number, or boolean.");
    }

    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();

    if (lower === "false" || lower === "0") {
        return false;
    }

    if (lower === "true") {
        return true;
    }

    // Positive integer string (hop count)
    if (/^\d+$/.test(trimmed)) {
        const hopCount = parseInt(trimmed, 10);
        if (hopCount === 0) return false;
        return hopCount;
    }

    // Subnet name, CIDR, or comma-separated IP/subnet list
    try {
        // proxyaddr.compile will throw if any entry is not a recognized built-in name or valid IP/CIDR
        proxyaddr.compile(trimmed);
        return trimmed;
    } catch (_) {
        throw new ConfigError(
            `Invalid TRUST_PROXY configuration: "${trimmed}". ` +
            `Accepted values are: false, 0, positive integer hop count (e.g. 1, 2), ` +
            `valid subnet/CIDR/IP (e.g. 'loopback', '10.0.0.0/8'), or true.`
        );
    }
}

/**
 * Validates a positive integer configuration value within an optional range.
 *
 * @param {string|undefined} raw
 * @param {number} defaultValue
 * @param {string} paramName
 * @param {number} [min=1]
 * @param {number} [max=Infinity]
 * @returns {number}
 */
function validatePositiveInteger(raw, defaultValue, paramName, min = 1, max = Infinity) {
    if (raw === undefined || raw === null || raw === "") {
        return defaultValue;
    }

    const val = Number(raw);
    if (!Number.isInteger(val) || !Number.isFinite(val) || val < min || val > max) {
        throw new ConfigError(
            `Invalid ${paramName}: "${raw}". Must be an integer between ${min} and ${max === Infinity ? "Infinity" : max}.`
        );
    }

    return val;
}

/**
 * Preflight validation of all server environment configuration.
 * Fails fast with clear operator-facing error messages on invalid input.
 *
 * @param {object} [env=process.env]
 * @returns {object} Validated configuration dictionary
 */
function validateServerConfig(env = process.env) {
    const port = validatePositiveInteger(env.PORT, 3000, "PORT", 1, 65535);
    const maxMediaSizeBytes = validatePositiveInteger(
        env.MAX_MEDIA_SIZE_BYTES,
        262144000, // 250 MB
        "MAX_MEDIA_SIZE_BYTES",
        1024, // 1 KB min
        1073741824 // 1 GB max
    );
    const shutdownTimeoutMs = validatePositiveInteger(
        env.SHUTDOWN_TIMEOUT_MS,
        10000, // 10s
        "SHUTDOWN_TIMEOUT_MS",
        1000, // 1s min
        60000 // 60s max
    );

    const trustProxy = parseTrustProxy(env.TRUST_PROXY);

    const rateLimitGeneralMax = validatePositiveInteger(env.RATE_LIMIT_GENERAL_MAX, 100, "RATE_LIMIT_GENERAL_MAX", 1);
    const rateLimitExtractionMax = validatePositiveInteger(env.RATE_LIMIT_EXTRACTION_MAX, 15, "RATE_LIMIT_EXTRACTION_MAX", 1);
    const rateLimitMediaMax = validatePositiveInteger(env.RATE_LIMIT_MEDIA_MAX, 30, "RATE_LIMIT_MEDIA_MAX", 1);

    const maxGlobalExtractionConcurrency = validatePositiveInteger(
        env.MAX_GLOBAL_EXTRACTION_CONCURRENCY || env.MAX_GLOBAL_CONCURRENCY,
        30,
        "MAX_GLOBAL_EXTRACTION_CONCURRENCY",
        1,
        1000
    );
    const maxIpExtractionConcurrency = validatePositiveInteger(
        env.MAX_IP_EXTRACTION_CONCURRENCY || env.MAX_IP_CONCURRENCY,
        3,
        "MAX_IP_EXTRACTION_CONCURRENCY",
        1,
        100
    );
    const maxGlobalStreamConcurrency = validatePositiveInteger(
        env.MAX_GLOBAL_STREAM_CONCURRENCY,
        50,
        "MAX_GLOBAL_STREAM_CONCURRENCY",
        1,
        1000
    );
    const maxIpStreamConcurrency = validatePositiveInteger(
        env.MAX_IP_STREAM_CONCURRENCY,
        5,
        "MAX_IP_STREAM_CONCURRENCY",
        1,
        100
    );

    return {
        port,
        maxMediaSizeBytes,
        shutdownTimeoutMs,
        trustProxy,
        rateLimitGeneralMax,
        rateLimitExtractionMax,
        rateLimitMediaMax,
        maxGlobalExtractionConcurrency,
        maxIpExtractionConcurrency,
        maxGlobalStreamConcurrency,
        maxIpStreamConcurrency
    };
}

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

/**
 * Runs a bounded subprocess execution with shell: false and bounded output to verify binary version.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} [timeoutMs=5000]
 * @param {number} [maxOutputBytes=65536]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function executeVersionProbe(command, args, timeoutMs = 5000, maxOutputBytes = 65536) {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let limitExceeded = false;

        const sanitizedEnv = { ...process.env };
        delete sanitizedEnv.HTTP_PROXY;
        delete sanitizedEnv.HTTPS_PROXY;
        delete sanitizedEnv.ALL_PROXY;
        delete sanitizedEnv.http_proxy;
        delete sanitizedEnv.https_proxy;
        delete sanitizedEnv.all_proxy;
        delete sanitizedEnv.NO_PROXY;
        delete sanitizedEnv.no_proxy;

        let proc;
        try {
            proc = spawn(command, args, {
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: sanitizedEnv
            });
        } catch (err) {
            return reject(new ConfigError(`Failed to spawn binary '${command}': ${err.message}`));
        }

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
            if (stdoutBytes > maxOutputBytes) {
                limitExceeded = true;
                killProc();
                return;
            }
            stdout += chunk.toString("utf8");
        });

        proc.stderr.on("data", (chunk) => {
            if (limitExceeded) return;
            stderrBytes += chunk.length;
            if (stderrBytes > maxOutputBytes) {
                limitExceeded = true;
                killProc();
                return;
            }
            stderr += chunk.toString("utf8");
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(new ConfigError(`Binary execution failed for '${command}': ${err.message}`));
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) {
                return reject(new ConfigError(`Binary version probe timed out after ${timeoutMs}ms for '${command}'.`));
            }
            if (limitExceeded) {
                return reject(new ConfigError(`Binary version probe exceeded maximum output buffer limit for '${command}'.`));
            }
            resolve({ stdout, stderr, exitCode: code });
        });
    });
}

/**
 * Validates that an executable file exists on disk, is not a directory, and runs its version check.
 *
 * @param {string} configuredPath
 * @param {string} binaryName - Name for error reporting (e.g. 'YT_DLP_PATH', 'FFMPEG_PATH')
 * @param {string[]} [probeArgs=["--version"]]
 * @param {object} [options={}]
 * @returns {Promise<string>} Resolved absolute executable path
 */
async function validateBinaryExecutable(configuredPath, binaryName, probeArgs = ["--version"], options = {}) {
    if (!configuredPath || typeof configuredPath !== "string" || !configuredPath.trim()) {
        throw new ConfigError(`Missing required production binary configuration: ${binaryName}.`);
    }

    const rawPath = configuredPath.trim();
    const resolved = path.resolve(rawPath);

    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch (err) {
        throw new ConfigError(`Configured ${binaryName} does not exist at '${rawPath}'.`);
    }

    let executablePath = resolved;
    if (stat.isDirectory()) {
        if (binaryName === "YT_DLP_PATH") {
            throw new ConfigError(`Configured YT_DLP_PATH is a directory and cannot be used as an executable: '${rawPath}'.`);
        }
        // For FFMPEG_PATH, check for standard executable inside to align with resolveFfmpegPath
        const defaultBin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
        const candidate = path.join(resolved, defaultBin);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            executablePath = candidate;
        } else {
            throw new ConfigError(`Configured ${binaryName} path is a directory and does not contain '${defaultBin}': '${rawPath}'.`);
        }
    } else if (!stat.isFile()) {
        throw new ConfigError(`Configured ${binaryName} is not a valid regular file: '${rawPath}'.`);
    }

    const runner = options.runner || executeVersionProbe;
    let probeRes;
    try {
        probeRes = await runner(executablePath, probeArgs, options.timeoutMs || 5000);
    } catch (err) {
        if (err instanceof ConfigError) throw err;
        throw new ConfigError(`Failed to verify ${binaryName} executable '${executablePath}': ${err.message}`);
    }

    if (probeRes.exitCode !== 0) {
        throw new ConfigError(
            `${binaryName} version probe failed with exit code ${probeRes.exitCode} for '${executablePath}'. Stderr: ${(probeRes.stderr || "").trim().slice(0, 200)}`
        );
    }

    return executablePath;
}

/**
 * Validates that the temporary media storage directory exists and is writable.
 * Uses a uniquely named probe file that is immediately removed.
 *
 * @param {string} tempDirPath
 * @returns {string} Resolved directory path
 */
function validateStorageDirectory(tempDirPath) {
    if (!tempDirPath || typeof tempDirPath !== "string" || !tempDirPath.trim()) {
        throw new ConfigError("Invalid temporary storage directory path.");
    }

    const resolved = path.resolve(tempDirPath.trim());

    if (!fs.existsSync(resolved)) {
        try {
            fs.mkdirSync(resolved, { recursive: true });
        } catch (err) {
            throw new ConfigError(`Failed to create temporary media storage directory '${resolved}': ${err.message}`);
        }
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
        throw new ConfigError(`Temporary storage path '${resolved}' exists but is not a directory.`);
    }

    // Write probe to verify actual write permissions
    const probeFile = path.join(resolved, `.reeva_probe_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
        fs.writeFileSync(probeFile, "probe", { flag: "wx" });
    } catch (err) {
        throw new ConfigError(`Temporary storage directory '${resolved}' is not writable: ${err.message}`);
    } finally {
        if (fs.existsSync(probeFile)) {
            try {
                fs.unlinkSync(probeFile);
            } catch (_) {}
        }
    }

    return resolved;
}

/**
 * Production preflight: validates required binaries and writable temporary storage before accepting traffic.
 *
 * Requirements:
 * - If in production (NODE_ENV === "production" or options.forceProduction):
 *   1. Requires and verifies YT_DLP_PATH via bounded execution check (regular file, not directory).
 *   2. Requires and verifies FFMPEG_PATH via bounded execution check (required for default VIDEO_AND_AUDIO).
 *   3. Verifies REEVA_TEMP_DIR exists and is writable.
 *
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {Promise<{ ytDlpPath: string|null, ffmpegPath: string|null, tempDir: string }>}
 */
async function validateProductionPreflight(env = process.env, options = {}) {
    const isProduction = options.forceProduction || env.NODE_ENV === "production";
    const tempDirRaw = env.REEVA_TEMP_DIR ? env.REEVA_TEMP_DIR.trim() : path.join(os.tmpdir(), "reeva_media");

    // Storage check runs in all modes when preflight is called
    const tempDir = validateStorageDirectory(tempDirRaw);

    let ytDlpPath = null;
    let ffmpegPath = null;

    if (isProduction) {
        // 1. YT-DLP is mandatory in production
        ytDlpPath = await validateBinaryExecutable(
            env.YT_DLP_PATH,
            "YT_DLP_PATH",
            ["--version"],
            options
        );

        // 2. FFmpeg is mandatory in production for default VIDEO_AND_AUDIO pipeline
        ffmpegPath = await validateBinaryExecutable(
            env.FFMPEG_PATH,
            "FFMPEG_PATH",
            ["-version"],
            options
        );
    } else {
        // Non-production: validate if explicitly configured
        if (env.YT_DLP_PATH && env.YT_DLP_PATH.trim()) {
            ytDlpPath = await validateBinaryExecutable(
                env.YT_DLP_PATH,
                "YT_DLP_PATH",
                ["--version"],
                options
            );
        }
        if (env.FFMPEG_PATH && env.FFMPEG_PATH.trim()) {
            ffmpegPath = await validateBinaryExecutable(
                env.FFMPEG_PATH,
                "FFMPEG_PATH",
                ["-version"],
                options
            );
        }
    }

    return {
        ytDlpPath,
        ffmpegPath,
        tempDir
    };
}

module.exports = {
    ConfigError,
    parseTrustProxy,
    validatePositiveInteger,
    validateServerConfig,
    executeVersionProbe,
    validateBinaryExecutable,
    validateStorageDirectory,
    validateProductionPreflight
};
