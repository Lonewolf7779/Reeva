// scripts/verify-staging-platforms.cjs — Comprehensive Platform Verification Harness for Staging
"use strict";

const tls = require("tls");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { extractInstagram } = require("../lib/extraction/adapters/instagram.cjs");
const { extractFacebook } = require("../lib/extraction/adapters/facebook.cjs");
const { extractTikTok } = require("../lib/extraction/adapters/tiktok.cjs");
const { secureFetch } = require("../lib/http-client.cjs");
const { SUPPORTED_MEDIA_DOMAINS } = require("../lib/url-validator.cjs");
const { REEVA_TEMP_DIR, resolveFfmpegPath } = require("../lib/extraction/adapters/youtube.cjs");

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
 * @returns {Promise<{ valid: boolean, errors: string[] }>}
 */
function verifyFfmpegDecode(filePath) {
    return new Promise((resolve) => {
        let ffmpegCmd = "ffmpeg";
        try {
            ffmpegCmd = resolveFfmpegPath();
        } catch (_) {}

        const child = spawn(ffmpegCmd, [
            "-v", "error",
            "-i", filePath,
            "-f", "null",
            "-"
        ], { stdio: ["ignore", "ignore", "pipe"] });

        const errors = [];
        child.stderr.on("data", (chunk) => {
            errors.push(chunk.toString("utf8"));
        });

        child.on("error", (err) => {
            resolve({ valid: false, errors: [err.message] });
        });

        child.on("close", (code) => {
            resolve({ valid: code === 0 && errors.length === 0, errors });
        });
    });
}

/**
 * Runs pre-flight network diagnostics (DNS + TLS with strict certificate verification).
 *
 * @param {string} host
 * @returns {Promise<{ dnsOk: boolean, ipAddresses: string[], tlsOk: boolean, issuer: string, authorized: boolean, error: string|null }>}
 */
async function checkNetworkLayer(host) {
    const report = {
        dnsOk: false,
        ipAddresses: [],
        tlsOk: false,
        issuer: "UNKNOWN",
        authorized: false,
        error: null
    };

    try {
        const addrs = await dns.lookup(host, { all: true });
        report.dnsOk = true;
        report.ipAddresses = addrs.map((a) => a.address);
    } catch (err) {
        report.error = `DNS resolution failed: ${err.message}`;
        return report;
    }

    return new Promise((resolve) => {
        const socket = tls.connect(443, host, {
            servername: host,
            rejectUnauthorized: true // STRICT TLS ENFORCEMENT
        }, () => {
            try {
                const cert = socket.getPeerCertificate();
                report.tlsOk = socket.authorized === true;
                report.authorized = Boolean(socket.authorized);
                if (cert && cert.issuer) {
                    report.issuer = `${cert.issuer.O || "Unknown"} (${cert.issuer.CN || "Unknown"})`;
                }
            } catch (_) {}
            socket.end();
            resolve(report);
        });

        socket.on("error", (err) => {
            report.tlsOk = false;
            report.error = `${err.code || "TLS_ERROR"}: ${err.message}`;
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
            resolve(report);
        });

        socket.setTimeout(8000, () => {
            socket.destroy(new Error("TLS connection timed out after 8000ms"));
        });
    });
}

/**
 * Runs full pipeline verification for a single target platform.
 *
 * @param {object} target
 * @returns {Promise<object>}
 */
async function verifyTarget(target) {
    console.log(`\n======================================================`);
    console.log(`VERIFYING TARGET: [${target.platform.toUpperCase()}]`);
    console.log(`URL: ${target.url}`);
    console.log(`Host: ${target.host}`);
    console.log(`======================================================`);

    const result = {
        platform: target.platform,
        url: target.url,
        network: null,
        extraction: { success: false, data: null, error: null },
        stream: { success: false, bytes: 0, contentType: null, disposition: null, error: null },
        mediaValidation: { container: null, ffmpegValid: false, errors: [] },
        overallStatus: "FAILED",
        blockerCategory: "UNKNOWN",
        blockerDetail: ""
    };

    // 1. Network Diagnostics
    result.network = await checkNetworkLayer(target.host);
    console.log(`1. Network Diagnostic:`);
    console.log(`   - DNS: ${result.network.dnsOk ? "OK (" + result.network.ipAddresses.join(", ") + ")" : "FAILED"}`);
    console.log(`   - TLS Verified: ${result.network.tlsOk ? "YES" : "NO"} (Authorized: ${result.network.authorized})`);
    console.log(`   - Issuer: ${result.network.issuer}`);

    if (!result.network.tlsOk) {
        console.log(`   - Network Error: ${result.network.error}`);
        if (result.network.issuer.includes("Sophos") || (result.network.error && result.network.error.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))) {
            result.blockerCategory = "LOCAL_MIDDLEBOX_TLS_INTERCEPTION";
            result.blockerDetail = `Firewall middlebox (${result.network.issuer}) intercepted TLS and re-signed leaf certificate.`;
        } else if (result.network.error && result.network.error.includes("ECONNRESET")) {
            result.blockerCategory = "NETWORK_FIREWALL_TCP_RESET";
            result.blockerDetail = "Network firewall injected TCP RST during ClientHello SNI inspection.";
        } else {
            result.blockerCategory = "NETWORK_CONNECTIVITY_FAILURE";
            result.blockerDetail = result.network.error || "TLS negotiation failed";
        }
    }

    // 2. Extraction Adapter Execution
    console.log(`\n2. Extraction Adapter:`);
    try {
        const extracted = await target.extractor(target.url);
        result.extraction.success = true;
        result.extraction.data = extracted;
        console.log(`   - SUCCESS: Extracted media URL (${extracted.url ? extracted.url.substring(0, 80) + "..." : "N/A"})`);
        console.log(`   - Title: ${extracted.title || "N/A"}`);
        console.log(`   - Type: ${extracted.type || "N/A"}`);
    } catch (err) {
        result.extraction.success = false;
        result.extraction.error = {
            code: err.code || "EXTRACTION_FAILED",
            message: err.message,
            statusCode: err.statusCode || 500
        };
        console.log(`   - FAILED: [${result.extraction.error.code}] ${result.extraction.error.message}`);

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

    // 3. Media Stream & Validation (if extraction returned a valid URL or local file)
    const mediaUrl = result.extraction.data.url;
    const localArtifactPath = result.extraction.data.localFilePath;

    let targetFilePath = localArtifactPath;
    let tempDownloadPath = null;

    if (!targetFilePath && mediaUrl) {
        console.log(`\n3. Media Stream Download:`);
        try {
            if (!fs.existsSync(REEVA_TEMP_DIR)) {
                fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
            }
            tempDownloadPath = path.join(REEVA_TEMP_DIR, `staging_verify_${target.platform}_${Date.now()}.tmp`);
            const handle = await secureFetch(mediaUrl, {
                allowedDomains: SUPPORTED_MEDIA_DOMAINS,
                timeoutMs: 30000
            });

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

            targetFilePath = tempDownloadPath;
            console.log(`   - SUCCESS: Downloaded ${result.stream.bytes} bytes`);
            console.log(`   - Content-Type: ${result.stream.contentType}`);
        } catch (err) {
            result.stream.success = false;
            result.stream.error = err.message;
            console.log(`   - FAILED to stream media: ${err.message}`);
            result.blockerCategory = "MEDIA_STREAM_FAILURE";
            result.blockerDetail = err.message;
            return result;
        }
    }

    // 4. Media Validation (Container Sniffing & FFmpeg Decode)
    if (targetFilePath && fs.existsSync(targetFilePath)) {
        console.log(`\n4. Media Validation:`);
        try {
            const fd = fs.openSync(targetFilePath, "r");
            const headerBuf = Buffer.alloc(32);
            fs.readSync(fd, headerBuf, 0, 32, 0);
            fs.closeSync(fd);

            const container = sniffContainerFormat(headerBuf);
            result.mediaValidation.container = container;
            console.log(`   - Container Magic Bytes: ${container || "UNRECOGNIZED"}`);

            const ffmpegResult = await verifyFfmpegDecode(targetFilePath);
            result.mediaValidation.ffmpegValid = ffmpegResult.valid;
            result.mediaValidation.errors = ffmpegResult.errors;
            console.log(`   - FFmpeg Decode: ${ffmpegResult.valid ? "VALID (0 errors)" : "INVALID (" + ffmpegResult.errors.length + " errors)"}`);

            if (ffmpegResult.valid) {
                result.overallStatus = "PASSED";
                result.blockerCategory = "NONE";
                result.blockerDetail = "Full end-to-end media download and decode succeeded.";
            } else {
                result.blockerCategory = "FFMPEG_DECODE_ERRORS";
                result.blockerDetail = ffmpegResult.errors.join("; ");
            }
        } catch (err) {
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
    console.log("==================================================================");
    console.log("REEVA STAGING & RECOVERY PLATFORM VERIFICATION HARNESS");
    console.log("Preserving TLS verification, SSRF protections, and strict bounds");
    console.log("==================================================================");

    const platformArg = process.argv[2];
    const targets = platformArg
        ? DEFAULT_TARGETS.filter((t) => t.platform === platformArg.toLowerCase())
        : DEFAULT_TARGETS;

    if (targets.length === 0) {
        console.error(`Unknown platform '${platformArg}'. Available: instagram, facebook, tiktok`);
        process.exit(1);
    }

    const summaryTable = [];
    for (const target of targets) {
        const res = await verifyTarget(target);
        summaryTable.push({
            Platform: res.platform,
            DNS: res.network ? (res.network.dnsOk ? "OK" : "FAIL") : "N/A",
            TLS: res.network ? (res.network.tlsOk ? "VERIFIED" : "BLOCKED") : "N/A",
            Extraction: res.extraction.success ? "SUCCESS" : "FAIL",
            MediaBytes: res.stream.bytes || (res.extraction.data && res.extraction.data.localFilePath ? "LOCAL" : 0),
            FFmpegDecode: res.mediaValidation.ffmpegValid ? "VALID" : "N/A",
            Overall: res.overallStatus,
            BlockerCategory: res.blockerCategory,
            BlockerDetail: res.blockerDetail ? res.blockerDetail.substring(0, 60) : "None"
        });
    }

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
    checkNetworkLayer,
    verifyTarget,
    sniffContainerFormat,
    verifyFfmpegDecode,
    DEFAULT_TARGETS
};
