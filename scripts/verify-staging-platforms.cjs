// scripts/verify-staging-platforms.cjs — Comprehensive Platform Verification Harness for Staging
"use strict";

const net = require("net");
const tls = require("tls");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const { extractInstagram } = require("../lib/extraction/adapters/instagram.cjs");
const { extractFacebook } = require("../lib/extraction/adapters/facebook.cjs");
const { extractTikTok } = require("../lib/extraction/adapters/tiktok.cjs");
const { secureFetch } = require("../lib/http-client.cjs");
const { SUPPORTED_MEDIA_DOMAINS, SUPPORTED_SOURCE_DOMAINS } = require("../lib/url-validator.cjs");
const { REEVA_TEMP_DIR, resolveFfmpegPath, resolveYtDlpCommand } = require("../lib/extraction/adapters/youtube.cjs");

const DEFAULT_TARGETS = [
    {
        platform: "instagram",
        host: "www.instagram.com",
        url: "https://www.instagram.com/reel/C8oP4qNtxZ7/",
        extractor: extractInstagram
    },
    {
        platform: "facebook",
        host: "www.facebook.com",
        url: "https://www.facebook.com/watch/?v=10153231379946729",
        extractor: extractFacebook
    },
    {
        platform: "tiktok",
        host: "www.tiktok.com",
        url: "https://www.tiktok.com/@tiktok/video/7106594312292453678",
        extractor: extractTikTok
    }
];

/**
 * Checks system environment dependencies and pre-flight prerequisites.
 *
 * @returns {object}
 */
function checkEnvironment() {
    const envReport = {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        opensslVersion: process.versions.openssl,
        ffmpeg: { available: false, version: "N/A", path: "N/A" },
        ytdlp: { available: false, version: "N/A", command: "N/A" },
        proxyConfigured: Boolean(process.env.REEVA_EGRESS_PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY)
    };

    try {
        const ffmpegCmd = resolveFfmpegPath();
        envReport.ffmpeg.path = ffmpegCmd;
        const ffmpegOutput = execSync(`"${ffmpegCmd}" -version`, { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
        const firstLine = ffmpegOutput.split("\n")[0];
        envReport.ffmpeg.available = true;
        envReport.ffmpeg.version = firstLine.trim();
    } catch (_) {}

    try {
        const ytdlpInfo = resolveYtDlpCommand();
        const cmd = ytdlpInfo.command;
        const args = [...(ytdlpInfo.baseArgs || []), "--version"];
        envReport.ytdlp.command = `${cmd} ${(ytdlpInfo.baseArgs || []).join(" ")}`.trim();
        const ytdlpOutput = execSync(`"${cmd}" ${args.join(" ")}`, { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
        envReport.ytdlp.available = true;
        envReport.ytdlp.version = ytdlpOutput.trim();
    } catch (_) {}

    return envReport;
}

/**
 * Sniffs container magic bytes for supported video formats.
 *
 * @param {Buffer} headerBuffer
 * @returns {string|null} Container format or null
 */
function sniffContainerFormat(headerBuffer) {
    if (!headerBuffer || headerBuffer.length < 8) return null;

    // WebM EBML header: 0x1A 0x45 0xDF 0xA3
    if (
        headerBuffer[0] === 0x1A &&
        headerBuffer[1] === 0x45 &&
        headerBuffer[2] === 0xDF &&
        headerBuffer[3] === 0xA3
    ) {
        return "webm";
    }

    // MP4 box: offset 4 contains 'ftyp'
    const boxType = headerBuffer.subarray(4, 8).toString("latin1");
    if (boxType === "ftyp") {
        return "mp4";
    }

    return null;
}

/**
 * Executes FFmpeg null-mux decode to verify frame integrity.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @returns {Promise<{ valid: boolean, errors: string[] }>}
 */
function verifyFfmpegDecode(filePath, options = {}) {
    return new Promise((resolve) => {
        let ffmpegCmd = "ffmpeg";
        try {
            ffmpegCmd = resolveFfmpegPath();
        } catch (_) {}

        const spawnFn = options.spawnFn || spawn;
        let child;
        try {
            child = spawnFn(ffmpegCmd, [
                "-v", "error",
                "-i", filePath,
                "-f", "null",
                "-"
            ], { stdio: ["ignore", "ignore", "pipe"] });
        } catch (err) {
            return resolve({ valid: false, errors: [err.message] });
        }

        const errors = [];
        if (child.stderr) {
            child.stderr.on("data", (chunk) => {
                errors.push(chunk.toString("utf8"));
            });
        }

        child.on("error", (err) => {
            resolve({ valid: false, errors: [err.message] });
        });

        child.on("close", (code) => {
            resolve({ valid: code === 0 && errors.length === 0, errors });
        });
    });
}

/**
 * Performs an independent TCP port 443 connection test.
 *
 * @param {string} host
 * @param {number} [port=443]
 * @param {number} [timeoutMs=5000]
 * @param {object} [options]
 * @returns {Promise<{ tcpOk: boolean, durationMs: number, error: string|null }>}
 */
function checkTcpConnection(host, port = 443, timeoutMs = 5000, options = {}) {
    return new Promise((resolve) => {
        const netModule = options.netModule || net;
        const startTime = Date.now();
        let settled = false;

        const socket = netModule.connect({ host, port });

        const finish = (result) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_) {}
            resolve(result);
        };

        socket.setTimeout(timeoutMs, () => {
            finish({
                tcpOk: false,
                durationMs: Date.now() - startTime,
                error: `TCP connection timed out after ${timeoutMs}ms`
            });
        });

        socket.on("connect", () => {
            finish({
                tcpOk: true,
                durationMs: Date.now() - startTime,
                error: null
            });
        });

        socket.on("error", (err) => {
            finish({
                tcpOk: false,
                durationMs: Date.now() - startTime,
                error: `${err.code || "TCP_ERROR"}: ${err.message}`
            });
        });
    });
}

/**
 * Performs an independent TLS handshake test with strict certificate verification.
 *
 * @param {string} host
 * @param {number} [port=443]
 * @param {number} [timeoutMs=8000]
 * @param {object} [options]
 * @returns {Promise<{ tlsOk: boolean, issuer: string, authorized: boolean, durationMs: number, error: string|null }>}
 */
function checkTlsHandshake(host, port = 443, timeoutMs = 8000, options = {}) {
    return new Promise((resolve) => {
        const tlsModule = options.tlsModule || tls;
        const startTime = Date.now();
        let settled = false;

        const socket = tlsModule.connect(port, host, {
            servername: host,
            rejectUnauthorized: true // STRICT TLS CERTIFICATE VERIFICATION
        }, () => {
            if (settled) return;
            settled = true;
            const report = {
                tlsOk: socket.authorized === true,
                authorized: Boolean(socket.authorized),
                issuer: "UNKNOWN",
                durationMs: Date.now() - startTime,
                error: null
            };
            try {
                const cert = socket.getPeerCertificate();
                if (cert && cert.issuer) {
                    report.issuer = `${cert.issuer.O || "Unknown"} (${cert.issuer.CN || "Unknown"})`;
                }
            } catch (_) {}
            try { socket.end(); } catch (_) {}
            resolve(report);
        });

        socket.setTimeout(timeoutMs, () => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_) {}
            resolve({
                tlsOk: false,
                authorized: false,
                issuer: "UNKNOWN",
                durationMs: Date.now() - startTime,
                error: `TLS handshake timed out after ${timeoutMs}ms`
            });
        });

        socket.on("error", (err) => {
            if (settled) return;
            settled = true;
            const report = {
                tlsOk: false,
                authorized: false,
                issuer: "UNKNOWN",
                durationMs: Date.now() - startTime,
                error: `${err.code || "TLS_ERROR"}: ${err.message}`
            };
            try {
                if (typeof socket.getPeerX509Certificate === "function") {
                    const x509 = socket.getPeerX509Certificate();
                    if (x509 && x509.issuer) {
                        report.issuer = x509.issuer.replace(/\n/g, ", ");
                    }
                } else {
                    const cert = socket.getPeerCertificate();
                    if (cert && cert.issuer) {
                        report.issuer = `${cert.issuer.O || "Unknown"} (${cert.issuer.CN || "Unknown"})`;
                    }
                }
            } catch (_) {}
            try { socket.destroy(); } catch (_) {}
            resolve(report);
        });
    });
}

/**
 * Runs pre-flight network diagnostics (DNS + independent TCP + independent TLS).
 *
 * @param {string} host
 * @param {object} [options]
 * @returns {Promise<{ dnsOk: boolean, ipAddresses: string[], tcp: object, tls: object, error: string|null }>}
 */
async function checkNetworkLayer(host, options = {}) {
    const dnsModule = (options.dns && options.dns.promises) || dns;
    const report = {
        dnsOk: false,
        ipAddresses: [],
        tcp: { tcpOk: false, durationMs: 0, error: null },
        tls: { tlsOk: false, issuer: "UNKNOWN", authorized: false, durationMs: 0, error: null },
        error: null
    };

    // 1. DNS Resolution
    try {
        const addrs = await dnsModule.lookup(host, { all: true });
        report.dnsOk = true;
        report.ipAddresses = addrs.map((a) => a.address);
    } catch (err) {
        report.error = `DNS resolution failed: ${err.message}`;
        return report;
    }

    // 2. Independent TCP Connection
    report.tcp = await checkTcpConnection(host, 443, 5000, options);
    if (!report.tcp.tcpOk) {
        report.error = `TCP connection failed: ${report.tcp.error}`;
        return report;
    }

    // 3. Independent TLS Handshake
    report.tls = await checkTlsHandshake(host, 443, 8000, options);
    if (!report.tls.tlsOk) {
        report.error = `TLS handshake failed: ${report.tls.error}`;
    }

    return report;
}

/**
 * Performs a bounded HTTP diagnostic probe on the target URL.
 * Employs HEAD first; falls back to a bounded GET (Range: bytes=0-2047 or 64KB max)
 * if HEAD returns 405 Method Not Allowed or 501 Not Implemented.
 *
 * @param {string} targetUrl
 * @param {string} platform
 * @param {object} [options]
 * @returns {Promise<{ httpOk: boolean, status: number|null, contentType: string|null, contentLength: string|null, methodUsed: string, finalUrl: string|null, error: string|null }>}
 */
async function checkHttpProbe(targetUrl, platform, options = {}) {
    const fetchFn = options.fetchFn || secureFetch;
    const allowed = (SUPPORTED_SOURCE_DOMAINS && SUPPORTED_SOURCE_DOMAINS[platform]) || [];

    const probeResult = {
        httpOk: false,
        status: null,
        contentType: null,
        contentLength: null,
        methodUsed: "HEAD",
        finalUrl: null,
        error: null
    };

    // Attempt 1: HEAD
    try {
        const handle = await fetchFn(targetUrl, {
            method: "HEAD",
            allowedDomains: allowed,
            timeoutMs: 6000,
            maxRedirects: 3,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            }
        });

        probeResult.status = handle.response.status;
        probeResult.contentType = handle.response.headers.get("content-type");
        probeResult.contentLength = handle.response.headers.get("content-length");
        probeResult.finalUrl = handle.finalUrl;
        handle.abort();

        if (handle.response.ok || [301, 302, 307, 308].includes(handle.response.status)) {
            probeResult.httpOk = true;
            return probeResult;
        }

        // If HEAD was rejected with 405/501 or returned 403, try bounded GET
        if (![405, 501, 403].includes(handle.response.status)) {
            probeResult.error = `HTTP probe returned status ${handle.response.status}`;
            return probeResult;
        }
    } catch (err) {
        // If HEAD failed with network/abort error, keep trying bounded GET if it might be server method restriction
        probeResult.error = err.message;
    }

    // Attempt 2: Bounded GET with Range header
    probeResult.methodUsed = "GET (Range: bytes=0-2047)";
    try {
        const handle = await fetchFn(targetUrl, {
            method: "GET",
            allowedDomains: allowed,
            timeoutMs: 8000,
            maxRedirects: 3,
            maxSizeBytes: 64 * 1024, // 64 KB maximum payload for probe
            headers: {
                "Range": "bytes=0-2047",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            }
        });

        probeResult.status = handle.response.status;
        probeResult.contentType = handle.response.headers.get("content-type");
        probeResult.contentLength = handle.response.headers.get("content-length");
        probeResult.finalUrl = handle.finalUrl;
        handle.abort();

        if (handle.response.ok || handle.response.status === 206 || [301, 302, 307, 308].includes(handle.response.status)) {
            probeResult.httpOk = true;
            probeResult.error = null;
        } else {
            probeResult.httpOk = false;
            probeResult.error = `HTTP probe returned status ${handle.response.status}`;
        }
    } catch (err) {
        probeResult.httpOk = false;
        probeResult.error = err.message;
    }

    return probeResult;
}

/**
 * Validates a candidate media HTTP response before streaming to disk.
 * Strictly rejects HTML error/challenge responses, JSON error payloads, and zero-length bodies.
 *
 * @param {object} response - Fetch response object
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateMediaResponseHeaders(response) {
    if (!response) {
        return { valid: false, error: "Missing HTTP response handle" };
    }

    const status = response.status;
    if (status && (status < 200 || status >= 300)) {
        return { valid: false, error: `Invalid media HTTP status ${status}` };
    }

    const contentType = (response.headers && response.headers.get && response.headers.get("content-type")) || "";
    const lowerType = contentType.toLowerCase().trim();

    if (lowerType.startsWith("text/html") || lowerType.includes("html")) {
        return { valid: false, error: `Rejected HTML response masquerading as media stream (${contentType})` };
    }

    if (lowerType.startsWith("application/json") || lowerType.includes("json")) {
        return { valid: false, error: `Rejected JSON error response masquerading as media stream (${contentType})` };
    }

    const contentLength = response.headers && response.headers.get && response.headers.get("content-length");
    if (contentLength !== null && contentLength !== undefined) {
        const lengthNum = parseInt(contentLength, 10);
        if (!isNaN(lengthNum) && lengthNum === 0) {
            return { valid: false, error: "Rejected 0-byte media stream (Content-Length: 0)" };
        }
    }

    return { valid: true, error: null };
}

/**
 * Runs full pipeline verification for a single target platform.
 *
 * @param {object} target
 * @param {boolean} [silent=false]
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
async function verifyTarget(target, silent = false, options = {}) {
    if (!silent) {
        console.log(`\n======================================================`);
        console.log(`VERIFYING TARGET: [${target.platform.toUpperCase()}]`);
        console.log(`URL: ${target.url}`);
        console.log(`Host: ${target.host}`);
        console.log(`======================================================`);
    }

    const result = {
        platform: target.platform,
        url: target.url,
        network: null,
        httpProbe: null,
        extraction: { success: false, data: null, error: null },
        stream: { success: false, bytes: 0, contentType: null, disposition: null, error: null },
        mediaValidation: { container: null, ffmpegValid: false, errors: [] },
        overallStatus: "FAILED",
        blockerCategory: "UNKNOWN",
        blockerDetail: ""
    };

    // 1. Network Diagnostics (DNS + TCP + TLS)
    result.network = await checkNetworkLayer(target.host, options);
    if (!silent) {
        console.log(`1. Network Diagnostics:`);
        console.log(`   - DNS: ${result.network.dnsOk ? "OK (" + result.network.ipAddresses.join(", ") + ")" : "FAILED"}`);
        console.log(`   - TCP (Port 443): ${result.network.tcp.tcpOk ? "CONNECTED (" + result.network.tcp.durationMs + "ms)" : "FAILED (" + result.network.tcp.error + ")"}`);
        console.log(`   - TLS Verified: ${result.network.tls.tlsOk ? "YES (" + result.network.tls.durationMs + "ms)" : "NO"} (Authorized: ${result.network.tls.authorized})`);
        console.log(`   - Issuer: ${result.network.tls.issuer}`);
    }

    if (!result.network.tcp.tcpOk) {
        result.blockerCategory = "TCP_CONNECTION_FAILURE";
        result.blockerDetail = result.network.tcp.error;
    } else if (!result.network.tls.tlsOk) {
        const issuer = result.network.tls.issuer;
        const err = result.network.tls.error || "";
        if (issuer.includes("Sophos") || err.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE")) {
            result.blockerCategory = "LOCAL_MIDDLEBOX_TLS_INTERCEPTION";
            result.blockerDetail = `Firewall middlebox (${issuer}) intercepted TLS and re-signed leaf certificate.`;
        } else if (err.includes("ECONNRESET")) {
            result.blockerCategory = "NETWORK_FIREWALL_TCP_RESET";
            result.blockerDetail = "Network firewall injected TCP RST during ClientHello SNI inspection.";
        } else {
            result.blockerCategory = "TLS_HANDSHAKE_FAILURE";
            result.blockerDetail = err || "TLS negotiation failed";
        }
    }

    // 2. Bounded Independent HTTP Diagnostic Probe
    result.httpProbe = await checkHttpProbe(target.url, target.platform, options);
    if (!silent) {
        console.log(`\n2. HTTP Diagnostic Probe:`);
        console.log(`   - Method: ${result.httpProbe.methodUsed}`);
        console.log(`   - Status: ${result.httpProbe.status !== null ? result.httpProbe.status : "N/A"}`);
        console.log(`   - Content-Type: ${result.httpProbe.contentType || "N/A"}`);
        console.log(`   - Content-Length: ${result.httpProbe.contentLength || "N/A"}`);
        if (result.httpProbe.error) {
            console.log(`   - Probe Notice: ${result.httpProbe.error}`);
        }
    }

    // 3. Extraction Adapter Execution
    if (!silent) console.log(`\n3. Extraction Adapter:`);
    try {
        const extracted = await target.extractor(target.url);
        result.extraction.success = true;
        result.extraction.data = extracted;
        if (!silent) {
            console.log(`   - SUCCESS: Extracted media URL (${extracted.url ? extracted.url.substring(0, 80) + "..." : "N/A"})`);
            console.log(`   - Title: ${extracted.title || "N/A"}`);
            console.log(`   - Type: ${extracted.type || "N/A"}`);
        }
    } catch (err) {
        result.extraction.success = false;
        result.extraction.error = {
            code: err.code || "EXTRACTION_FAILED",
            message: err.message,
            statusCode: err.statusCode || 500
        };
        if (!silent) console.log(`   - FAILED: [${result.extraction.error.code}] ${result.extraction.error.message}`);

        if (!result.blockerCategory || result.blockerCategory === "UNKNOWN") {
            if (result.extraction.error.code === "PLATFORM_CHALLENGE") {
                result.blockerCategory = "PLATFORM_CHALLENGE_OR_GEO_BLOCK";
                result.blockerDetail = "Platform presented bot challenge, CAPTCHA, or regional redirect.";
            } else if (result.extraction.error.code === "UPSTREAM_COMMUNICATION_ERROR") {
                result.blockerCategory = "UPSTREAM_COMMUNICATION_BLOCKED";
                result.blockerDetail = err.message;
            } else {
                result.blockerCategory = "EXTRACTION_FAILURE";
                result.blockerDetail = `[${result.extraction.error.code}] ${err.message}`;
            }
        }
        return result;
    }

    // 4. Media Stream & Validation (with early HTML/JSON/Zero-Byte rejection)
    const mediaUrl = result.extraction.data.url;
    const localArtifactPath = result.extraction.data.localFilePath;

    let targetFilePath = localArtifactPath;
    let tempDownloadPath = null;

    if (!targetFilePath && mediaUrl) {
        if (!silent) console.log(`\n4. Media Stream Download:`);
        try {
            if (!fs.existsSync(REEVA_TEMP_DIR)) {
                fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
            }
            tempDownloadPath = path.join(REEVA_TEMP_DIR, `staging_verify_${target.platform}_${Date.now()}.tmp`);
            const fetchFn = options.fetchFn || secureFetch;
            const handle = await fetchFn(mediaUrl, {
                allowedDomains: SUPPORTED_MEDIA_DOMAINS,
                timeoutMs: 30000
            });

            // Early response validation: Reject HTML challenge, JSON errors, 0-byte headers
            const headerValidation = validateMediaResponseHeaders(handle.response);
            if (!headerValidation.valid) {
                handle.abort();
                throw new Error(headerValidation.error);
            }

            result.stream.contentType = handle.response.headers.get("content-type");
            result.stream.disposition = handle.response.headers.get("content-disposition");

            const outStream = fs.createWriteStream(tempDownloadPath);
            await new Promise((resolve, reject) => {
                let bytes = 0;
                handle.stream.on("data", (chunk) => {
                    bytes += chunk.length;
                    outStream.write(chunk);
                });
                handle.stream.on("end", () => {
                    outStream.end();
                    result.stream.bytes = bytes;
                    result.stream.success = true;
                    resolve();
                });
                handle.stream.on("error", (err) => {
                    outStream.destroy();
                    reject(err);
                });
            });

            if (result.stream.bytes === 0) {
                throw new Error("Received empty 0-byte media stream");
            }

            targetFilePath = tempDownloadPath;
            if (!silent) {
                console.log(`   - SUCCESS: Downloaded ${result.stream.bytes} bytes`);
                console.log(`   - Content-Type: ${result.stream.contentType}`);
            }
        } catch (err) {
            result.stream.success = false;
            result.stream.error = err.message;
            if (!silent) console.log(`   - FAILED to stream media: ${err.message}`);
            result.blockerCategory = "MEDIA_STREAM_FAILURE";
            result.blockerDetail = err.message;
            return result;
        }
    }

    // 5. Media Validation (Container Magic Bytes Sniffing & FFmpeg Null-Mux Decode)
    if (targetFilePath && fs.existsSync(targetFilePath)) {
        if (!silent) console.log(`\n5. Media Validation:`);
        try {
            const fd = fs.openSync(targetFilePath, "r");
            const headerBuf = Buffer.alloc(32);
            fs.readSync(fd, headerBuf, 0, 32, 0);
            fs.closeSync(fd);

            const container = sniffContainerFormat(headerBuf);
            result.mediaValidation.container = container;
            if (!silent) console.log(`   - Container Magic Bytes: ${container || "UNRECOGNIZED"}`);

            if (!container) {
                result.overallStatus = "FAILED";
                result.blockerCategory = "INVALID_CONTAINER_SIGNATURE";
                result.blockerDetail = "File header did not match MP4 (ftyp) or WebM (EBML) magic bytes.";
                return result;
            }

            const ffmpegResult = await verifyFfmpegDecode(targetFilePath, options);
            result.mediaValidation.ffmpegValid = ffmpegResult.valid;
            result.mediaValidation.errors = ffmpegResult.errors;
            if (!silent) console.log(`   - FFmpeg Decode: ${ffmpegResult.valid ? "VALID (0 errors)" : "INVALID (" + ffmpegResult.errors.length + " errors)"}`);

            if (ffmpegResult.valid) {
                result.overallStatus = "PASSED";
                result.blockerCategory = "NONE";
                result.blockerDetail = "Full end-to-end media download and decode succeeded.";
            } else {
                result.overallStatus = "FAILED";
                result.blockerCategory = "FFMPEG_DECODE_ERRORS";
                result.blockerDetail = ffmpegResult.errors.join("; ");
            }
        } catch (err) {
            result.overallStatus = "FAILED";
            result.blockerCategory = "MEDIA_INSPECTION_FAILURE";
            result.blockerDetail = err.message;
        } finally {
            if (tempDownloadPath && fs.existsSync(tempDownloadPath)) {
                try { fs.unlinkSync(tempDownloadPath); } catch (_) {}
            }
        }
    }

    return result;
}

/**
 * Main runner.
 */
async function main() {
    const args = process.argv.slice(2);
    const isJson = args.includes("--json");
    let platformArg = null;
    let customUrl = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--platform" && args[i + 1]) {
            platformArg = args[i + 1].toLowerCase();
            i++;
        } else if (args[i] === "--url" && args[i + 1]) {
            customUrl = args[i + 1];
            i++;
        } else if (!args[i].startsWith("--") && !platformArg) {
            platformArg = args[i].toLowerCase();
        }
    }

    if (platformArg === "all") {
        platformArg = null;
    }

    const envInfo = checkEnvironment();

    if (!isJson) {
        console.log("==================================================================");
        console.log("REEVA STAGING & RECOVERY PLATFORM VERIFICATION HARNESS");
        console.log("Preserving TLS verification, SSRF protections, and strict bounds");
        console.log("==================================================================");
        console.log("Runtime Environment:");
        console.log(`- Node.js: ${envInfo.nodeVersion} (${envInfo.platform} ${envInfo.arch})`);
        console.log(`- OpenSSL: ${envInfo.opensslVersion}`);
        console.log(`- FFmpeg:  ${envInfo.ffmpeg.available ? envInfo.ffmpeg.version : "NOT AVAILABLE"}`);
        console.log(`- yt-dlp:  ${envInfo.ytdlp.available ? envInfo.ytdlp.version : "NOT AVAILABLE"}`);
        console.log(`- Egress Proxy Configured: ${envInfo.proxyConfigured}`);
    }

    let targets = platformArg
        ? DEFAULT_TARGETS.filter((t) => t.platform === platformArg)
        : DEFAULT_TARGETS;

    if (targets.length === 0) {
        console.error(`Unknown platform '${platformArg}'. Available: instagram, facebook, tiktok, all`);
        process.exit(1);
    }

    if (customUrl && targets.length === 1) {
        targets = [{
            ...targets[0],
            url: customUrl
        }];
    }

    const summaryResults = [];
    for (const target of targets) {
        const res = await verifyTarget(target, isJson);
        summaryResults.push(res);
    }

    if (isJson) {
        console.log(JSON.stringify({
            environment: envInfo,
            results: summaryResults
        }, null, 2));
        return;
    }

    const summaryTable = summaryResults.map((res) => ({
        Platform: res.platform,
        DNS: res.network ? (res.network.dnsOk ? "OK" : "FAIL") : "N/A",
        TCP: res.network ? (res.network.tcp.tcpOk ? "OK" : "FAIL") : "N/A",
        TLS: res.network ? (res.network.tls.tlsOk ? "VERIFIED" : "BLOCKED") : "N/A",
        HTTP: res.httpProbe ? (res.httpProbe.httpOk ? `HTTP ${res.httpProbe.status}` : (res.httpProbe.status ? `HTTP ${res.httpProbe.status}` : "FAIL")) : "N/A",
        Extraction: res.extraction.success ? "SUCCESS" : "FAIL",
        MediaBytes: res.stream.bytes || (res.extraction.data && res.extraction.data.localFilePath ? "LOCAL" : 0),
        FFmpegDecode: res.mediaValidation.ffmpegValid ? "VALID" : "N/A",
        Overall: res.overallStatus,
        BlockerCategory: res.blockerCategory,
        BlockerDetail: res.blockerDetail ? res.blockerDetail.substring(0, 45) : "None"
    }));

    console.log("\n==================================================================");
    console.log("STAGING VERIFICATION SUMMARY TABLE");
    console.log("==================================================================");
    console.table(summaryTable);
}

if (require.main === module) {
    main().catch((err) => {
        console.error("Verification harness fatal error:", err);
        process.exit(1);
    });
}

module.exports = {
    checkEnvironment,
    checkNetworkLayer,
    checkTcpConnection,
    checkTlsHandshake,
    checkHttpProbe,
    validateMediaResponseHeaders,
    verifyTarget,
    sniffContainerFormat,
    verifyFfmpegDecode,
    DEFAULT_TARGETS
};
