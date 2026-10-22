// tests/security-concurrency-hardening.test.cjs — Phase 4.1 Regression Tests
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { createConcurrencyLimiter, normalizeClientIp } = require("../lib/concurrency-limiter.cjs");
const { createExtractionOrchestrator } = require("../lib/extraction/index.cjs");
const { SecurityHTTPError, ResponseTooLargeError } = require("../lib/http-client.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES, DEFAULT_ERROR_MESSAGES } = require("../lib/extraction/types.cjs");
const { ValidationError } = require("../lib/url-validator.cjs");
const { SSRFError } = require("../lib/ssrf-filter.cjs");
const { validateServerConfig } = require("../lib/config.cjs");
const serverApp = require("../server.cjs");

// Helper to close a test HTTP server with a referenced rejection timer
function closeServer(server, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        let closed = false;
        const closeTimeout = setTimeout(() => {
            if (closed) return;
            reject(new Error(`Test server failed to close within ${timeoutMs}ms deadline`));
        }, timeoutMs);

        server.close((err) => {
            if (closed) return;
            closed = true;
            clearTimeout(closeTimeout);
            if (err) reject(err);
            else resolve();
        });
    });
}

// =============================================================================
// 1. Rate Limiting & Concurrency IP Normalization Tests
// =============================================================================

test("IP Normalization: IPv6 addresses in same /56 or /64 subnet share normalized bucket", () => {
    // /56 default mask
    const ip1 = "2001:db8:abcd:0012::1";
    const ip2 = "2001:db8:abcd:0012::2";
    const ipDiff = "2001:db8:abcd:0100::1";

    const key1 = normalizeClientIp(ip1, 56);
    const key2 = normalizeClientIp(ip2, 56);
    const keyDiff = normalizeClientIp(ipDiff, 56);

    assert.strictEqual(key1, key2, "IPv6 addresses in the same /56 subnet must resolve to the same key");
    assert.notStrictEqual(key1, keyDiff, "IPv6 addresses in different /56 subnets must resolve to distinct keys");

    // /64 mask
    const key64_1 = normalizeClientIp(ip1, 64);
    const key64_2 = normalizeClientIp(ip2, 64);
    assert.strictEqual(key64_1, key64_2, "IPv6 addresses in the same /64 subnet must resolve to the same key under /64");
});

test("IP Normalization: Distinct IPv4 addresses remain completely separate", () => {
    const v4_a = "192.0.2.1";
    const v4_b = "192.0.2.2";

    const keyA = normalizeClientIp(v4_a);
    const keyB = normalizeClientIp(v4_b);

    assert.strictEqual(keyA, "192.0.2.1");
    assert.strictEqual(keyB, "192.0.2.2");
    assert.notStrictEqual(keyA, keyB, "Distinct IPv4 clients must never collapse into the same bucket");
});

test("IP Normalization: IPv4-mapped IPv6 addresses resolve to IPv4 without colliding", () => {
    const mapped1 = "::ffff:192.0.2.1";
    const mapped2 = "::ffff:192.0.2.2";
    const direct1 = "192.0.2.1";

    const key1 = normalizeClientIp(mapped1);
    const key2 = normalizeClientIp(mapped2);
    const keyDirect = normalizeClientIp(direct1);

    assert.strictEqual(key1, "192.0.2.1", "IPv4-mapped address must extract underlying IPv4");
    assert.strictEqual(key2, "192.0.2.2", "IPv4-mapped address must extract underlying IPv4");
    assert.strictEqual(key1, keyDirect, "Mapped IPv4 must coalesce with direct IPv4 for same host");
    assert.notStrictEqual(key1, key2, "Different IPv4-mapped addresses must not collapse into a single bucket");
});

test("Concurrency Limiter: Enforces per-IP limits against IPv6 subnet rotation", () => {
    const limiter = createConcurrencyLimiter({ maxGlobal: 10, maxPerIp: 2, ipv6Subnet: 56 });

    const createMockRes = () => {
        const listeners = {};
        return {
            statusCode: 200,
            status: function(code) { this.statusCode = code; return this; },
            json: function(payload) { this.body = payload; return this; },
            on: function(event, fn) { listeners[event] = fn; },
            emit: function(event) { if (listeners[event]) listeners[event](); }
        };
    };

    // Client requests with IP 1 in /56
    const res1 = createMockRes();
    const res2 = createMockRes();
    limiter({ ip: "2001:db8:abcd:0012::1" }, res1, () => {});
    limiter({ ip: "2001:db8:abcd:0012::2" }, res2, () => {});

    assert.strictEqual(limiter.getGlobalActive(), 2);
    assert.strictEqual(limiter.getIpActive("2001:db8:abcd:0012::1"), 2);

    // 3rd request from same subnet using another rotated interface ID must be rejected (429)
    const res3 = createMockRes();
    limiter({ ip: "2001:db8:abcd:0012::ffff" }, res3, () => {});
    assert.strictEqual(res3.statusCode, 429, "Subnet rotation must not bypass per-IP concurrency limiter");

    // But request from another IPv6 subnet proceeds cleanly
    const resOtherSubnet = createMockRes();
    let otherNextCalled = false;
    limiter({ ip: "2001:db8:abcd:0200::1" }, resOtherSubnet, () => { otherNextCalled = true; });
    assert.strictEqual(otherNextCalled, true, "Distinct IPv6 subnet must receive distinct concurrency allocation");

    // Teardown
    res1.emit("finish");
    res2.emit("finish");
    resOtherSubnet.emit("finish");
    assert.strictEqual(limiter.getGlobalActive(), 0);
});

test("Configuration Security: Insecure TRUST_PROXY='true' is rejected in production", () => {
    assert.throws(() => {
        validateServerConfig({
            NODE_ENV: "production",
            TRUST_PROXY: "true"
        });
    }, {
        name: "ConfigError",
        message: /Insecure TRUST_PROXY configuration: 'true' is overly permissive/
    });

    // Valid configurations in production: explicit hop counts or CIDRs
    const cfg1 = validateServerConfig({ NODE_ENV: "production", TRUST_PROXY: "1" });
    assert.strictEqual(cfg1.trustProxy, 1);

    const cfgLoopback = validateServerConfig({ NODE_ENV: "production", TRUST_PROXY: "loopback" });
    assert.strictEqual(cfgLoopback.trustProxy, "loopback");

    const cfgFalse = validateServerConfig({ NODE_ENV: "production", TRUST_PROXY: "false" });
    assert.strictEqual(cfgFalse.trustProxy, false);
});

// =============================================================================
// 2. Shared Extraction Cancellation Tests
// =============================================================================

test("Shared Extraction: Concurrent identical extractions share work safely", async () => {
    let adapterCalls = 0;
    const orchestrator = createExtractionOrchestrator({
        adapters: {
            instagram: async (url, opts) => {
                adapterCalls++;
                await new Promise((r) => setTimeout(r, 50));
                return { url: "https://scontent.cdninstagram.com/v/test.mp4", platform: "instagram", type: "video" };
            }
        }
    });

    const [res1, res2] = await Promise.all([
        orchestrator.extractMedia({ platform: "instagram", sourceUrl: "https://www.instagram.com/reel/shared123/", requestId: "req1" }),
        orchestrator.extractMedia({ platform: "instagram", sourceUrl: "https://www.instagram.com/reel/shared123/", requestId: "req2" })
    ]);

    assert.strictEqual(adapterCalls, 1, "Underlying adapter must be called exactly once for identical concurrent requests");
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.deduplicated, true, "Second caller must receive deduplicated result");
    assert.strictEqual(res1.media.url, res2.media.url);
});

test("Shared Extraction: Aborting the first caller does not fail the second caller", async () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    let adapterStarted = false;
    let adapterCancelled = false;

    const orchestrator = createExtractionOrchestrator({
        adapters: {
            instagram: async (url, { signal }) => {
                adapterStarted = true;
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        resolve({ url: "https://scontent.cdninstagram.com/v/survived.mp4", platform: "instagram", type: "video" });
                    }, 100);

                    if (signal) {
                        signal.addEventListener("abort", () => {
                            clearTimeout(timer);
                            adapterCancelled = true;
                            reject(new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED"));
                        }, { once: true });
                    }
                });
            }
        }
    });

    const promise1 = orchestrator.extractMedia({
        platform: "instagram",
        sourceUrl: "https://www.instagram.com/reel/abort_first/",
        requestId: "req_first",
        signal: controller1.signal
    });

    const promise2 = orchestrator.extractMedia({
        platform: "instagram",
        sourceUrl: "https://www.instagram.com/reel/abort_first/",
        requestId: "req_second",
        signal: controller2.signal
    });

    // Abort caller 1 shortly after start
    await new Promise((r) => setTimeout(r, 20));
    controller1.abort();

    // Caller 1 must reject with CLIENT_ABORTED
    await assert.rejects(promise1, (err) => {
        assert.strictEqual(err instanceof SecurityHTTPError, true);
        assert.strictEqual(err.statusCode, 499);
        assert.strictEqual(err.code, "CLIENT_ABORTED");
        return true;
    }, "Caller 1 must be rejected with CLIENT_ABORTED");

    // But Caller 2 must SUCCEED because Caller 2 is still active!
    const result2 = await promise2;
    assert.strictEqual(result2.success, true);
    assert.strictEqual(result2.media.url, "https://scontent.cdninstagram.com/v/survived.mp4");
    assert.strictEqual(adapterCancelled, false, "Underlying operation must not be cancelled while another caller waits");
});

test("Shared Extraction: Aborting all callers cancels the underlying operation", async () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    let adapterAborted = false;

    const orchestrator = createExtractionOrchestrator({
        adapters: {
            instagram: async (url, { signal }) => {
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        resolve({ url: "https://scontent.cdninstagram.com/v/never.mp4", platform: "instagram" });
                    }, 200);

                    if (signal) {
                        signal.addEventListener("abort", () => {
                            clearTimeout(timer);
                            adapterAborted = true;
                            reject(new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED"));
                        }, { once: true });
                    }
                });
            }
        }
    });

    const promise1 = orchestrator.extractMedia({
        platform: "instagram",
        sourceUrl: "https://www.instagram.com/reel/abort_all/",
        requestId: "req_all1",
        signal: controller1.signal
    });

    const promise2 = orchestrator.extractMedia({
        platform: "instagram",
        sourceUrl: "https://www.instagram.com/reel/abort_all/",
        requestId: "req_all2",
        signal: controller2.signal
    });

    // Abort both callers
    await new Promise((r) => setTimeout(r, 20));
    controller1.abort();
    controller2.abort();

    await assert.rejects(promise1);
    await assert.rejects(promise2);

    // Wait briefly for event loop turn
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(adapterAborted, true, "Underlying adapter must be aborted when all callers disconnect");
});

test("Shared Extraction: Pre-aborted caller rejects with CLIENT_ABORTED and does not invoke adapter", async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-aborted before invocation

    let adapterInvoked = false;
    const orchestrator = createExtractionOrchestrator({
        adapters: {
            instagram: async () => {
                adapterInvoked = true;
                return { url: "https://scontent.cdninstagram.com/v/sample.mp4", platform: "instagram" };
            }
        }
    });

    await assert.rejects(
        orchestrator.extractMedia({
            platform: "instagram",
            sourceUrl: "https://www.instagram.com/reel/pre_aborted/",
            requestId: "req_pre_aborted",
            signal: controller.signal
        }),
        (err) => {
            assert.ok(err instanceof SecurityHTTPError);
            assert.strictEqual(err.statusCode, 499);
            assert.strictEqual(err.code, "CLIENT_ABORTED");
            assert.strictEqual(err.message, "Request aborted by client.");
            return true;
        }
    );

    assert.strictEqual(adapterInvoked, false, "Adapter must not be invoked for an already-aborted caller");
});

test("Shared Extraction: Pre-aborted caller during generic extraction rejects and does not invoke adapter", async () => {
    const controller = new AbortController();
    controller.abort();

    let genericAdapterInvoked = false;
    const orchestrator = createExtractionOrchestrator({
        adapters: {
            generic: async () => {
                genericAdapterInvoked = true;
                return { url: "https://example.com/video.mp4", platform: "generic" };
            }
        }
    });

    await assert.rejects(
        orchestrator.extractMedia({
            platform: "generic",
            sourceUrl: "https://example.com/watch?v=pre_aborted",
            requestId: "req_generic_pre_aborted",
            signal: controller.signal
        }),
        (err) => {
            assert.ok(err instanceof SecurityHTTPError);
            assert.strictEqual(err.statusCode, 499);
            assert.strictEqual(err.code, "CLIENT_ABORTED");
            return true;
        }
    );

    assert.strictEqual(genericAdapterInvoked, false, "Generic adapter must not be invoked for pre-aborted caller");
});

// =============================================================================
// 3. Public Error Sanitization Tests
// =============================================================================

test("Public Error Sanitization: Sensitive diagnostic detector recognizes all prohibited patterns", () => {
    const { containsSensitiveDiagnostic } = serverApp;
    assert.strictEqual(typeof containsSensitiveDiagnostic, "function", "containsSensitiveDiagnostic must be exported");

    // 1. POSIX root paths
    assert.strictEqual(containsSensitiveDiagnostic("/root/secret.key"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Failed at /app/config.json"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Cannot read /opt/certs/server.pem"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Error in /workspace/repo/.env"), true);
    assert.strictEqual(containsSensitiveDiagnostic("/etc/shadow read error"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Leak /var/log/syslog"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Temp at /tmp/file.sock"), true);
    assert.strictEqual(containsSensitiveDiagnostic("/usr/local/bin/yt-dlp"), true);
    assert.strictEqual(containsSensitiveDiagnostic("./relative/path/leak"), true);
    assert.strictEqual(containsSensitiveDiagnostic("../parent/secret"), true);

    // 2. Windows drive paths & UNC shares
    assert.strictEqual(containsSensitiveDiagnostic("C:\\Users\\InternalUser\\reeva\\private.key"), true);
    assert.strictEqual(containsSensitiveDiagnostic("D:/secrets/api_key.txt"), true);
    assert.strictEqual(containsSensitiveDiagnostic("\\\\internal-fs\\share\\data.db"), true);

    // 3. Portless & ported IPv4 literals
    assert.strictEqual(containsSensitiveDiagnostic("connect ECONNREFUSED 127.0.0.1:8118"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Upstream host 10.0.0.1 failed"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Proxy 192.168.1.1 timed out"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Private gateway 172.16.50.1 unreachable"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Metadata service 169.254.169.254 denied"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Internal server localhost refused"), true);

    // 4. Portless & ported IPv6 literals
    assert.strictEqual(containsSensitiveDiagnostic("Failed to connect to ::1"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Address fe80::1 timed out"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Unique local fc00::1 unreachable"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Remote [::1]:8080 down"), true);
    assert.strictEqual(containsSensitiveDiagnostic("Host 2001:db8:85a3::8a2e:370:7334 rejected"), true);

    // 5. Signed URLs & URLs with query strings/tokens
    assert.strictEqual(containsSensitiveDiagnostic("https://upstream.cdn.com/stream.mp4?token=secret123&sig=abc"), true);
    assert.strictEqual(containsSensitiveDiagnostic("https://storage.googleapis.com/bucket/obj?X-Amz-Signature=xyz"), true);

    // 6. Node.js / OS system error tokens
    assert.strictEqual(containsSensitiveDiagnostic("ENOENT: no such file or directory"), true);
    assert.strictEqual(containsSensitiveDiagnostic("ECONNREFUSED by peer"), true);
    assert.strictEqual(containsSensitiveDiagnostic("EACCES: permission denied"), true);
    assert.strictEqual(containsSensitiveDiagnostic("EPIPE on stream write"), true);
    assert.strictEqual(containsSensitiveDiagnostic("ETIMEDOUT while connecting"), true);

    // 7. JS Runtime exceptions & stack traces
    assert.strictEqual(containsSensitiveDiagnostic("TypeError: Cannot read properties of undefined (reading 'split')"), true);
    assert.strictEqual(containsSensitiveDiagnostic("ReferenceError: foo is not defined"), true);
    assert.strictEqual(containsSensitiveDiagnostic("at Module._compile (node:internal/modules/cjs/loader:1546:14)"), true);

    // 8. Approved safe validation and extraction messages must NEVER be falsely flagged
    const safeMessages = [
        "Please paste a video link first.",
        "A URL is required.",
        "The URL hostname 'instagram.com' is not a valid twitter link.",
        "The URL hostname 'youtube.com' is not a valid instagram link.",
        "Unsupported platform 'unknown'. Supported platforms: instagram, facebook, twitter, pinterest, youtube, tiktok, generic.",
        "Only secure HTTPS URLs are supported.",
        "Non-standard ports are not allowed.",
        "URLs containing credentials are not permitted.",
        "This URL belongs to YouTube. Please use the dedicated YouTube downloader.",
        "We couldn't retrieve media from this link. Make sure it is public and accessible.",
        "No downloadable video or image was found for this link.",
        "The upstream platform is currently unreachable. Please try again shortly.",
        "Extraction timed out while communicating with the upstream platform.",
        "The media format found on this page is not supported for download.",
        "Destination is not permitted.",
        "Response size exceeds maximum permitted limit.",
        "Request aborted by client.",
        "Request timed out."
    ];

    for (const msg of safeMessages) {
        assert.strictEqual(containsSensitiveDiagnostic(msg), false, `Safe message falsely flagged as sensitive: "${msg}"`);
    }
});

test("Public Error Sanitization: sanitizePublicError applies strict allowlist mapping", () => {
    const { sanitizePublicError, VALIDATION_ERROR_MESSAGES, SECURITY_ERROR_MESSAGES } = serverApp;
    assert.strictEqual(typeof sanitizePublicError, "function", "sanitizePublicError must be exported");
    assert.ok(VALIDATION_ERROR_MESSAGES, "VALIDATION_ERROR_MESSAGES must be exported");

    // Requirement A: Approved validation error codes return their exact approved static message
    for (const [code, expectedMessage] of Object.entries(VALIDATION_ERROR_MESSAGES)) {
        const err = new ValidationError("Any internal message", code);
        const res = sanitizePublicError(err);
        assert.strictEqual(res.statusCode, 400, `Code ${code} must return HTTP 400`);
        assert.strictEqual(res.errorCode, code, `Error code ${code} must be preserved`);
        assert.strictEqual(res.message, expectedMessage, `Code ${code} must map to exact static approved message`);
    }

    // Requirement B: Approved code carrying a fabricated diagnostic message returns the approved static message, not the diagnostic
    const fabricatedDiagnostics = [
        "Internal database connection failed on port 5432",
        "Failed validating /root/internal.conf for instagram",
        "Connection timed out to 10.0.0.1:8080",
        "Leaked secret key at https://internal.dev?token=supersecret",
        "TypeError: Cannot read properties of undefined in validator"
    ];
    for (const diag of fabricatedDiagnostics) {
        const unsafeVal = new ValidationError(diag, "DISALLOWED_DOMAIN");
        const res = sanitizePublicError(unsafeVal);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.errorCode, "DISALLOWED_DOMAIN");
        assert.strictEqual(res.message, VALIDATION_ERROR_MESSAGES.DISALLOWED_DOMAIN);
        assert.strictEqual(JSON.stringify(res).includes(diag), false, "Must not leak diagnostic message");
    }

    // Requirement C: Unknown validation code accompanied by a short, plausible internal message returns the generic fallback
    const unknownVal = new ValidationError("Internal redis cluster auth failed for shard 2", "INTERNAL_REDIS_SHARD_FAIL");
    const resUnknown = sanitizePublicError(unknownVal);
    assert.strictEqual(resUnknown.statusCode, 400);
    assert.strictEqual(resUnknown.errorCode, "VALIDATION_FAILED");
    assert.strictEqual(resUnknown.message, "Invalid request parameters.");

    // Requirement D: Unknown validation code cannot expose signed URL, internal service name, database detail, IP, or arbitrary hostname
    const leakageAttempts = [
        new ValidationError("https://internal-s3.local/dump?token=abc&sig=def", "INVALID_S3_PATH"),
        new ValidationError("auth-vault-02.internal connection rejected", "VAULT_ERROR"),
        new ValidationError("relation user_sessions does not exist", "SQL_ERROR"),
        new ValidationError("Host 10.200.1.5 unreachable", "SUBNET_ERROR"),
        new ValidationError("Hostname attacker-controlled-host.com disallowed", "UNKNOWN_HOST")
    ];
    for (const err of leakageAttempts) {
        const res = sanitizePublicError(err);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.errorCode, "VALIDATION_FAILED");
        assert.strictEqual(res.message, "Invalid request parameters.");
        assert.strictEqual(JSON.stringify(res).includes(err.message), false);
    }

    // Requirement E: Sensitive-looking message that does not match diagnostic detector is nevertheless blocked
    // "Cluster redis-shard-01 auth handshake failed" has no POSIX roots, no Windows drive, no IP, no system error tokens
    const subtleInternalError = new ValidationError("Cluster redis-shard-01 auth handshake failed", "UNKNOWN_CUSTOM_CODE");
    const resSubtle = sanitizePublicError(subtleInternalError);
    assert.strictEqual(resSubtle.errorCode, "VALIDATION_FAILED");
    assert.strictEqual(resSubtle.message, "Invalid request parameters.");
    assert.strictEqual(resSubtle.message.includes("redis-shard-01"), false);

    // URL_TOO_LONG consistency: Source URLs (2048 limit) and Media URLs (4096 limit) produce identical approved message
    const sourceTooLong = new ValidationError("URL exceeds maximum allowed length of 2048 characters.", "URL_TOO_LONG");
    const resSourceTooLong = sanitizePublicError(sourceTooLong);
    assert.strictEqual(resSourceTooLong.statusCode, 400);
    assert.strictEqual(resSourceTooLong.errorCode, "URL_TOO_LONG");
    assert.strictEqual(resSourceTooLong.message, "The supplied URL exceeds the maximum permitted length.");

    const mediaTooLong = new ValidationError("Media URL exceeds maximum allowed length.", "URL_TOO_LONG");
    const resMediaTooLong = sanitizePublicError(mediaTooLong);
    assert.strictEqual(resMediaTooLong.statusCode, 400);
    assert.strictEqual(resMediaTooLong.errorCode, "URL_TOO_LONG");
    assert.strictEqual(resMediaTooLong.message, "The supplied URL exceeds the maximum permitted length.");

    const longFabricated = new ValidationError("Internal overflow at buffer 0xdeadbeef: " + "X".repeat(500), "URL_TOO_LONG");
    const resLongFabricated = sanitizePublicError(longFabricated);
    assert.strictEqual(resLongFabricated.statusCode, 400);
    assert.strictEqual(resLongFabricated.errorCode, "URL_TOO_LONG");
    assert.strictEqual(resLongFabricated.message, "The supplied URL exceeds the maximum permitted length.");
    assert.strictEqual(JSON.stringify(resLongFabricated).includes("0xdeadbeef"), false);

    // Requirement F: SSRFError strictly maps to "Destination is not permitted."
    const ssrfErr = new SSRFError("Host 127.0.0.1 resolved to loopback address", "SSRF_BLOCKED");
    const resSsrf = sanitizePublicError(ssrfErr);
    assert.strictEqual(resSsrf.statusCode, 400);
    assert.strictEqual(resSsrf.errorCode, "SSRF_BLOCKED");
    assert.strictEqual(resSsrf.message, "Destination is not permitted.");

    // SecurityHTTPError maps safe codes
    const largeErr = new ResponseTooLargeError();
    const resLarge = sanitizePublicError(largeErr);
    assert.strictEqual(resLarge.statusCode, 413);
    assert.strictEqual(resLarge.errorCode, "RESPONSE_TOO_LARGE");
    assert.strictEqual(resLarge.message, "Response size exceeds maximum permitted limit.");

    const abortErr = new SecurityHTTPError("Socket was closed by client", 499, "CLIENT_ABORTED");
    const resAbort = sanitizePublicError(abortErr);
    assert.strictEqual(resAbort.statusCode, 499);
    assert.strictEqual(resAbort.errorCode, "CLIENT_ABORTED");
    assert.strictEqual(resAbort.message, "Request aborted by client.");

    const timeoutErr = new SecurityHTTPError("Hop timed out", 504, "TIMEOUT");
    const resTimeout = sanitizePublicError(timeoutErr);
    assert.strictEqual(resTimeout.statusCode, 504);
    assert.strictEqual(resTimeout.errorCode, "TIMEOUT");
    assert.strictEqual(resTimeout.message, "Request timed out.");

    // ExtractionError maps recognized error codes to static DEFAULT_ERROR_MESSAGES
    const extractErr1 = new ExtractionError(
        EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
        "Upstream yt-dlp process timed out after 30000ms at /opt/venv/bin/yt-dlp"
    );
    const resExt1 = sanitizePublicError(extractErr1);
    assert.strictEqual(resExt1.statusCode, 502);
    assert.strictEqual(resExt1.errorCode, "PROVIDER_TIMEOUT");
    assert.strictEqual(resExt1.message, DEFAULT_ERROR_MESSAGES.PROVIDER_TIMEOUT);
    assert.strictEqual(resExt1.message.includes("/opt/"), false);

    const extractErr2 = new ExtractionError(
        EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
        "No stream URL found in /app/cache/meta.json"
    );
    const resExt2 = sanitizePublicError(extractErr2);
    assert.strictEqual(resExt2.statusCode, 404);
    assert.strictEqual(resExt2.errorCode, "MEDIA_NOT_FOUND");
    assert.strictEqual(resExt2.message, DEFAULT_ERROR_MESSAGES.MEDIA_NOT_FOUND);

    // Unknown exceptions, System errors, and TypeErrors discard message and use defaultMessage
    const sysErr = new Error("ENOENT: no such file or directory, open 'C:\\Users\\Admin\\secret.pem'");
    sysErr.code = "ENOENT";
    const resSys = sanitizePublicError(sysErr);
    assert.strictEqual(resSys.statusCode, 502);
    assert.strictEqual(resSys.errorCode, "EXTRACTION_FAILED");
    assert.strictEqual(resSys.message, "We could not retrieve media from this link.");

    const typeErr = new TypeError("Cannot read properties of null (reading 'media')");
    const resType = sanitizePublicError(typeErr);
    assert.strictEqual(resType.statusCode, 502);
    assert.strictEqual(resType.errorCode, "EXTRACTION_FAILED");
    assert.strictEqual(resType.message, "We could not retrieve media from this link.");
});

test("Public Error Sanitization: Unexpected extraction error returns 502 while unexpected streaming error returns 500", () => {
    const { sanitizePublicError } = serverApp;

    // Unexpected extraction failure defaults to 502
    const unexpectedExtractErr = new TypeError("Cannot read properties of undefined");
    const sanitizedExtract = sanitizePublicError(unexpectedExtractErr, "EXTRACTION_FAILED", "We could not retrieve media from this link.", 502);
    assert.strictEqual(sanitizedExtract.statusCode, 502);
    assert.strictEqual(sanitizedExtract.errorCode, "EXTRACTION_FAILED");
    assert.strictEqual(sanitizedExtract.message, "We could not retrieve media from this link.");

    // Unexpected internal streaming failure defaults to 500
    const unexpectedStreamErr = new Error("Stream read pipeline unexpectedly broke");
    const sanitizedStream = sanitizePublicError(unexpectedStreamErr, "STREAM_ERROR", "Failed to retrieve media stream.", 500);
    assert.strictEqual(sanitizedStream.statusCode, 500);
    assert.strictEqual(sanitizedStream.errorCode, "STREAM_ERROR");
    assert.strictEqual(sanitizedStream.message, "Failed to retrieve media stream.");

    // Upstream error with explicit HTTP status preserves that status
    const upstreamNotFound = new Error("Upstream resource not found");
    upstreamNotFound.statusCode = 404;
    const sanitizedUpstream = sanitizePublicError(upstreamNotFound, "STREAM_ERROR", "Failed to retrieve media stream.", 500);
    assert.strictEqual(sanitizedUpstream.statusCode, 404);
});

test("Error Mapping Hardening: Inherited Object prototype properties (toString, constructor, __proto__) receive safe fallbacks", () => {
    const { sanitizePublicError } = serverApp;
    const inheritedCodes = ["toString", "constructor", "__proto__", "valueOf", "isPrototypeOf"];

    for (const code of inheritedCodes) {
        // 1. ValidationError with inherited property as code
        const vErr = new ValidationError("Custom validation error with inherited code", code);
        const resVal = sanitizePublicError(vErr);
        assert.strictEqual(resVal.statusCode, 400);
        assert.strictEqual(resVal.errorCode, "VALIDATION_FAILED", `ValidationError code '${code}' must normalize to VALIDATION_FAILED`);
        assert.strictEqual(resVal.message, "Invalid request parameters.");
        assert.strictEqual(typeof resVal.message, "string");

        // 2. SecurityHTTPError with inherited property as code
        const sErr = new SecurityHTTPError("Security violation with inherited code", 403, code);
        const resSec = sanitizePublicError(sErr);
        assert.strictEqual(resSec.statusCode, 403);
        assert.strictEqual(resSec.errorCode, "SECURITY_ERROR", `SecurityHTTPError code '${code}' must normalize to SECURITY_ERROR`);
        assert.strictEqual(resSec.message, "Security policy violation.");
        assert.strictEqual(typeof resSec.message, "string");

        // 3. ExtractionError with inherited property as code
        const eErr = new ExtractionError(code, "Extraction error with inherited code", 502);
        const resExt = sanitizePublicError(eErr);
        assert.strictEqual(resExt.statusCode, 502);
        assert.strictEqual(resExt.errorCode, "EXTRACTION_FAILED", `ExtractionError code '${code}' must normalize to EXTRACTION_FAILED`);
        assert.strictEqual(resExt.message, "We could not retrieve media from this link.");
        assert.strictEqual(typeof resExt.message, "string");

        // 4. SSRFError with inherited property as code
        const ssrfErr = new SSRFError("Blocked destination with inherited code", 400, code);
        const resSsrf = sanitizePublicError(ssrfErr);
        assert.strictEqual(resSsrf.statusCode, 400);
        assert.strictEqual(resSsrf.errorCode, "VALIDATION_FAILED", `SSRFError code '${code}' must normalize to VALIDATION_FAILED`);
        assert.strictEqual(resSsrf.message, "Destination is not permitted.");
        assert.strictEqual(typeof resSsrf.message, "string");
    }
});

test("Security Error Codes: FORBIDDEN_PROTOCOL and UPSTREAM_COMMUNICATION_ERROR retain stable codes, internal codes normalize", () => {
    const { sanitizePublicError } = serverApp;

    // 1. FORBIDDEN_PROTOCOL preserves status 403, stable code, and approved static message
    const protoErr = new SecurityHTTPError("Protocol 'ftp:' is forbidden. Only HTTPS is permitted.", 403, "FORBIDDEN_PROTOCOL");
    const resProto = sanitizePublicError(protoErr);
    assert.strictEqual(resProto.statusCode, 403);
    assert.strictEqual(resProto.errorCode, "FORBIDDEN_PROTOCOL");
    assert.strictEqual(resProto.message, "Only secure HTTPS URLs are supported.");
    assert.strictEqual(resProto.message.includes("ftp:"), false);

    // 2. UPSTREAM_COMMUNICATION_ERROR preserves status 502, stable code, and approved static message
    const upstreamErr = new SecurityHTTPError("Upstream communication failure.", 502, "UPSTREAM_COMMUNICATION_ERROR");
    const resUpstream = sanitizePublicError(upstreamErr);
    assert.strictEqual(resUpstream.statusCode, 502);
    assert.strictEqual(resUpstream.errorCode, "UPSTREAM_COMMUNICATION_ERROR");
    assert.strictEqual(resUpstream.message, "Upstream communication failure.");

    // 3. Internal-only MISSING_ALLOWLIST normalizes safely to SECURITY_ERROR without leaking configuration
    const allowlistErr = new SecurityHTTPError("Allowed domains must be explicitly defined.", 500, "MISSING_ALLOWLIST");
    const resAllowlist = sanitizePublicError(allowlistErr);
    assert.strictEqual(resAllowlist.statusCode, 500);
    assert.strictEqual(resAllowlist.errorCode, "SECURITY_ERROR");
    assert.strictEqual(resAllowlist.message, "Security policy violation.");
    assert.strictEqual(resAllowlist.message.includes("Allowed domains"), false);
});

test("Public Error Sanitization: HTTP boundary strips internal paths, private proxies, signed URLs, and system codes", async () => {
    const { sanitizePublicError } = serverApp;
    const app = express();
    app.use(express.json());

    const { extractMedia } = createExtractionOrchestrator({
        adapters: {
            instagram: async (url) => {
                if (url.includes("posix_root")) {
                    throw new Error("Failed to load /root/secrets/server.key");
                }
                if (url.includes("posix_app")) {
                    throw new Error("Cannot open /app/config.json");
                }
                if (url.includes("posix_opt")) {
                    throw new Error("Missing cert at /opt/certs/server.pem");
                }
                if (url.includes("posix_workspace")) {
                    throw new Error("Cannot read /workspace/repo/.env");
                }
                if (url.includes("fs_leak")) {
                    throw new Error("ENOENT: no such file or directory, open 'C:\\Users\\SecretUser\\reeva\\artifact.mp4'");
                }
                if (url.includes("socket_leak")) {
                    throw new Error("connect ECONNREFUSED 127.0.0.1:8118");
                }
                if (url.includes("portless_ip")) {
                    throw new Error("Upstream server at 10.0.0.1 responded with error");
                }
                if (url.includes("ipv6_leak")) {
                    throw new Error("Failed to connect to ::1");
                }
                if (url.includes("signed_url")) {
                    throw new Error("Failed to fetch https://upstream.cdn.com/stream.mp4?token=secret123&sig=abc");
                }
                if (url.includes("type_error")) {
                    throw new TypeError("Cannot read properties of undefined (reading 'split')");
                }
                if (url.includes("extract_timeout")) {
                    throw new ExtractionError(
                        EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                        "Subprocess at /usr/local/bin/yt-dlp timed out"
                    );
                }
                if (url.includes("valid_error")) {
                    throw new ValidationError(
                        "The URL hostname 'youtube.com' is not a valid instagram link.",
                        "DISALLOWED_DOMAIN"
                    );
                }
                if (url.includes("fabricated_diag")) {
                    throw new ValidationError(
                        "Leaked diagnostic secret at auth-vault-02",
                        "DISALLOWED_DOMAIN"
                    );
                }
                if (url.includes("unapproved_code")) {
                    throw new ValidationError(
                        "Internal database cluster connection failed",
                        "UNAPPROVED_CUSTOM_CODE"
                    );
                }
                if (url.includes("oversized_source")) {
                    throw new ValidationError(
                        "URL exceeds maximum allowed length of 2048 characters.",
                        "URL_TOO_LONG"
                    );
                }
                if (url.includes("oversized_media")) {
                    throw new ValidationError(
                        "Media URL exceeds maximum allowed length.",
                        "URL_TOO_LONG"
                    );
                }
                return { url: "https://scontent.cdninstagram.com/v/ok.mp4", platform: "instagram" };
            }
        }
    });

    app.get("/api/download/:platform", async (req, res) => {
        try {
            await extractMedia({
                platform: req.params.platform,
                sourceUrl: req.query.url,
                requestId: "req_sanitize_test"
            });
        } catch (err) {
            const sanitized = sanitizePublicError(err);
            return res.status(sanitized.statusCode).json({
                error: {
                    code: sanitized.errorCode,
                    message: sanitized.message
                },
                requestId: "req_sanitize_test"
            });
        }
    });

    // Direct route handlers simulating uncaught errors in route/streaming boundary
    app.get("/api/test-direct-fs", (req, res) => {
        try {
            throw new Error("ENOENT: no such file or directory, open 'C:\\Users\\InternalUser\\reeva\\private.key'");
        } catch (err) {
            const sanitized = sanitizePublicError(err, "STREAM_ERROR", "Failed to retrieve media stream.", 500);
            return res.status(sanitized.statusCode).json({
                error: {
                    code: sanitized.errorCode,
                    message: sanitized.message
                },
                requestId: "req_direct_fs"
            });
        }
    });

    app.get("/api/test-direct-socket", (req, res) => {
        try {
            throw new Error("connect ECONNREFUSED 127.0.0.1:8118");
        } catch (err) {
            const sanitized = sanitizePublicError(err, "STREAM_ERROR", "Failed to retrieve media stream.", 500);
            return res.status(sanitized.statusCode).json({
                error: {
                    code: sanitized.errorCode,
                    message: sanitized.message
                },
                requestId: "req_direct_socket"
            });
        }
    });

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const requestJson = (path) => new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${path}`, (res) => {
            let data = "";
            res.on("data", (c) => data += c);
            res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }).on("error", reject);
    });

    try {
        // 1. POSIX root path leak attempts
        for (const testPath of ["posix_root", "posix_app", "posix_opt", "posix_workspace"]) {
            const res = await requestJson(`/api/download/instagram?url=https://www.instagram.com/reel/${testPath}/`);
            assert.strictEqual(res.status, 502);
            assert.strictEqual(res.body.error.code, "EXTRACTION_FAILED");
            assert.strictEqual(res.body.error.message, DEFAULT_ERROR_MESSAGES.EXTRACTION_FAILED);
            assert.strictEqual(JSON.stringify(res.body).includes("/root"), false);
            assert.strictEqual(JSON.stringify(res.body).includes("/app"), false);
            assert.strictEqual(JSON.stringify(res.body).includes("/opt"), false);
            assert.strictEqual(JSON.stringify(res.body).includes("/workspace"), false);
        }

        // 2. Windows filesystem path leak attempt
        const resFs = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/fs_leak/");
        assert.strictEqual(resFs.status, 502);
        assert.strictEqual(resFs.body.error.code, "EXTRACTION_FAILED");
        assert.strictEqual(resFs.body.error.message, DEFAULT_ERROR_MESSAGES.EXTRACTION_FAILED);
        assert.strictEqual(JSON.stringify(resFs.body).includes("SecretUser"), false);

        // 3. Socket / internal proxy leak attempt
        const resSocket = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/socket_leak/");
        assert.strictEqual(resSocket.status, 502);
        assert.strictEqual(resSocket.body.error.code, "EXTRACTION_FAILED");
        assert.strictEqual(resSocket.body.error.message, DEFAULT_ERROR_MESSAGES.EXTRACTION_FAILED);
        assert.strictEqual(JSON.stringify(resSocket.body).includes("8118"), false);
        assert.strictEqual(JSON.stringify(resSocket.body).includes("127.0.0.1"), false);

        // 4. Portless IPv4 and IPv6 leak attempts
        const resIp = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/portless_ip/");
        assert.strictEqual(resIp.status, 502);
        assert.strictEqual(resIp.body.error.code, "EXTRACTION_FAILED");
        assert.strictEqual(resIp.body.error.message, DEFAULT_ERROR_MESSAGES.EXTRACTION_FAILED);
        assert.strictEqual(JSON.stringify(resIp.body).includes("10.0.0.1"), false);

        const resIpv6 = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/ipv6_leak/");
        assert.strictEqual(resIpv6.status, 502);
        assert.strictEqual(resIpv6.body.error.code, "EXTRACTION_FAILED");
        assert.strictEqual(resIpv6.body.error.message, DEFAULT_ERROR_MESSAGES.EXTRACTION_FAILED);
        assert.strictEqual(JSON.stringify(resIpv6.body).includes("::1"), false);

        // 5. Signed URL leak attempt
        const resSigned = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/signed_url/");
        assert.strictEqual(resSigned.status, 502);
        assert.strictEqual(resSigned.body.error.code, "EXTRACTION_FAILED");
        assert.strictEqual(resSigned.body.error.message, DEFAULT_ERROR_MESSAGES.EXTRACTION_FAILED);
        assert.strictEqual(JSON.stringify(resSigned.body).includes("secret123"), false);

        // 6. Uncaught TypeError attempt
        const resType = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/type_error/");
        assert.strictEqual(resType.status, 502);
        assert.strictEqual(resType.body.error.code, "EXTRACTION_FAILED");
        assert.strictEqual(resType.body.error.message, DEFAULT_ERROR_MESSAGES.EXTRACTION_FAILED);
        assert.strictEqual(JSON.stringify(resType.body).includes("TypeError"), false);

        // 7. ExtractionError timeout mapping
        const resExtractTimeout = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/extract_timeout/");
        assert.strictEqual(resExtractTimeout.status, 502);
        assert.strictEqual(resExtractTimeout.body.error.code, "PROVIDER_TIMEOUT");
        assert.strictEqual(resExtractTimeout.body.error.message, DEFAULT_ERROR_MESSAGES.PROVIDER_TIMEOUT);
        assert.strictEqual(JSON.stringify(resExtractTimeout.body).includes("yt-dlp"), false);

        // 8. Approved ValidationError maps strictly to static approved message without echoing user strings
        const resValid = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/valid_error/");
        assert.strictEqual(resValid.status, 400);
        assert.strictEqual(resValid.body.error.code, "DISALLOWED_DOMAIN");
        assert.strictEqual(resValid.body.error.message, serverApp.VALIDATION_ERROR_MESSAGES.DISALLOWED_DOMAIN);
        assert.strictEqual(resValid.body.requestId, "req_sanitize_test");
        assert.strictEqual(JSON.stringify(resValid.body).includes("youtube.com"), false);

        // 8b. Fabricated diagnostic on approved code maps to static approved message
        const resDiag = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/fabricated_diag/");
        assert.strictEqual(resDiag.status, 400);
        assert.strictEqual(resDiag.body.error.code, "DISALLOWED_DOMAIN");
        assert.strictEqual(resDiag.body.error.message, serverApp.VALIDATION_ERROR_MESSAGES.DISALLOWED_DOMAIN);
        assert.strictEqual(resDiag.body.requestId, "req_sanitize_test");
        assert.strictEqual(JSON.stringify(resDiag.body).includes("auth-vault-02"), false);

        // 8c. Unapproved validation code maps to generic fallback
        const resUnapproved = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/unapproved_code/");
        assert.strictEqual(resUnapproved.status, 400);
        assert.strictEqual(resUnapproved.body.error.code, "VALIDATION_FAILED");
        assert.strictEqual(resUnapproved.body.error.message, "Invalid request parameters.");
        assert.strictEqual(resUnapproved.body.requestId, "req_sanitize_test");
        assert.strictEqual(JSON.stringify(resUnapproved.body).includes("database"), false);

        // 8d. Oversized source URL produces accurate, approved public message
        const resSourceTooLong = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/oversized_source/");
        assert.strictEqual(resSourceTooLong.status, 400);
        assert.strictEqual(resSourceTooLong.body.error.code, "URL_TOO_LONG");
        assert.strictEqual(resSourceTooLong.body.error.message, "The supplied URL exceeds the maximum permitted length.");
        assert.strictEqual(resSourceTooLong.body.requestId, "req_sanitize_test");
        assert.strictEqual(JSON.stringify(resSourceTooLong.body).includes("2048"), false);

        // 8e. Oversized media URL produces the same accurate, approved public message
        const resMediaTooLong = await requestJson("/api/download/instagram?url=https://www.instagram.com/reel/oversized_media/");
        assert.strictEqual(resMediaTooLong.status, 400);
        assert.strictEqual(resMediaTooLong.body.error.code, "URL_TOO_LONG");
        assert.strictEqual(resMediaTooLong.body.error.message, "The supplied URL exceeds the maximum permitted length.");
        assert.strictEqual(resMediaTooLong.body.requestId, "req_sanitize_test");
        assert.strictEqual(JSON.stringify(resMediaTooLong.body).includes("Media URL"), false);

        // 9. Direct boundary filesystem error
        const resDirectFs = await requestJson("/api/test-direct-fs");
        assert.strictEqual(resDirectFs.status, 500);
        assert.strictEqual(resDirectFs.body.error.code, "STREAM_ERROR");
        assert.strictEqual(resDirectFs.body.error.message, "Failed to retrieve media stream.");
        assert.strictEqual(resDirectFs.body.requestId, "req_direct_fs");
        assert.strictEqual(JSON.stringify(resDirectFs.body).includes("InternalUser"), false);

        // 10. Direct boundary proxy socket error
        const resDirectSocket = await requestJson("/api/test-direct-socket");
        assert.strictEqual(resDirectSocket.status, 500);
        assert.strictEqual(resDirectSocket.body.error.code, "STREAM_ERROR");
        assert.strictEqual(resDirectSocket.body.error.message, "Failed to retrieve media stream.");
        assert.strictEqual(resDirectSocket.body.requestId, "req_direct_socket");
        assert.strictEqual(JSON.stringify(resDirectSocket.body).includes("8118"), false);
        assert.strictEqual(JSON.stringify(resDirectSocket.body).includes("127.0.0.1"), false);
    } finally {
        await closeServer(server);
    }
});

test("Production Endpoint: Actual serverApp /api/download/:platform returns approved static message and preserves request ID", async () => {
    const server = http.createServer(serverApp);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
        const testReqId = "req_prod_test_deadbeef01";
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: "127.0.0.1",
                port,
                path: "/api/download/instagram?url=https://disallowed-host.example.com/p/test123",
                method: "GET",
                headers: {
                    "X-Request-Id": testReqId
                }
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => data += chunk);
                res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
            });
            req.on("error", reject);
            req.end();
        });

        // 1. Expected HTTP status and error code are returned
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, "DISALLOWED_DOMAIN");

        // 2. Approved static validation message is returned
        assert.strictEqual(res.body.error.message, serverApp.VALIDATION_ERROR_MESSAGES.DISALLOWED_DOMAIN);

        // 3. Actual request ID is preserved in response body and response header
        assert.strictEqual(res.body.requestId, testReqId);
        assert.strictEqual(res.headers["x-request-id"], testReqId);

        // 4. An unsafe raw validation message is not exposed
        const rawJson = JSON.stringify(res.body);
        assert.strictEqual(rawJson.includes("disallowed-host.example.com"), false);
        assert.strictEqual(rawJson.includes("stack"), false);
        assert.strictEqual(rawJson.includes("ValidationError"), false);
    } finally {
        await closeServer(server);
    }
});

test("Production Endpoint: Actual serverApp rejects insecure HTTP protocol with UNSUPPORTED_PROTOCOL", async () => {
    const server = http.createServer(serverApp);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
        const testReqId = "req_prod_test_proto_check";
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: "127.0.0.1",
                port,
                path: "/api/download/instagram?url=http://www.instagram.com/p/test123",
                method: "GET",
                headers: {
                    "X-Request-Id": testReqId
                }
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => data += chunk);
                res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
            });
            req.on("error", reject);
            req.end();
        });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, "UNSUPPORTED_PROTOCOL");
        assert.strictEqual(res.body.error.message, serverApp.VALIDATION_ERROR_MESSAGES.UNSUPPORTED_PROTOCOL);
        assert.strictEqual(res.body.requestId, testReqId);
        assert.strictEqual(res.headers["x-request-id"], testReqId);
    } finally {
        await closeServer(server);
    }
});
