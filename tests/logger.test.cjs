// tests/logger.test.cjs — Deterministic Tests for Observability, Sanitization, and Error Masking
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const {
    generateRequestId,
    redactUrl,
    sanitizeCode,
    sanitizeIdentifier,
    sanitizeRequestId,
    sanitizeMessage,
    formatLog,
    requestIdMiddleware
} = require("../lib/logger.cjs");

const {
    createExtractionOrchestrator,
    ExtractionError,
    EXTRACTION_ERROR_CODES
} = require("../lib/extraction/index.cjs");

const app = require("../server.cjs");

// =========================================================================
// TASK 6: LOGGER & SANITIZER DETERMINISTIC TESTS
// =========================================================================

test("Logger Test 1: Request ID generation produces expected format and uniqueness", () => {
    const id1 = generateRequestId();
    const id2 = generateRequestId();

    assert.match(id1, /^req_[a-f0-9]{16}$/);
    assert.match(id2, /^req_[a-f0-9]{16}$/);
    assert.notStrictEqual(id1, id2, "Generated request IDs must be distinct");
});

test("Logger Test 2: Valid incoming request ID is preserved by middleware", () => {
    const req = {
        headers: { "x-request-id": "client-trace-1234567890abcdef" }
    };
    const res = {
        headers: {},
        setHeader(name, val) { this.headers[name] = val; }
    };
    let nextCalled = false;

    requestIdMiddleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.id, "client-trace-1234567890abcdef");
    assert.strictEqual(res.headers["X-Request-Id"], "client-trace-1234567890abcdef");
});

test("Logger Test 3: Invalid incoming request ID is replaced with freshly generated ID", () => {
    const invalidIds = [
        "", // empty
        "short", // too short (< 8)
        "a".repeat(70), // too long (> 64)
        "req with spaces", // spaces
        "req\nnewline", // newline injection
        "req\r\nfake: 1", // CRLF injection
        "<script>alert(1)</script>", // XSS / special characters
        null,
        undefined
    ];

    for (const badId of invalidIds) {
        const req = {
            headers: badId !== undefined ? { "x-request-id": badId } : {}
        };
        const res = {
            headers: {},
            setHeader(name, val) { this.headers[name] = val; }
        };

        requestIdMiddleware(req, res, () => {});

        assert.match(req.id, /^req_[a-f0-9]{16}$/, `Invalid ID '${badId}' must be replaced with valid req_<hex>`);
        assert.strictEqual(res.headers["X-Request-Id"], req.id);
    }
});

test("Logger Test 4: URL query redaction strips query parameters and user credentials", () => {
    // Strips query parameters
    const redacted1 = redactUrl("https://www.instagram.com/p/C1234567890/?utm_source=ig_web_copy_link&igsh=SECRET123");
    assert.strictEqual(redacted1, "https://www.instagram.com/p/C1234567890/?[redacted]");

    // Preserves query-less URLs
    const redacted2 = redactUrl("https://www.youtube.com/watch");
    assert.strictEqual(redacted2, "https://www.youtube.com/watch");

    // Strips credentials and hash fragments while preserving port
    const redacted3 = redactUrl("https://admin:super_secret_pass@cdn.example.com:8443/media.mp4?sig=TOKEN123#fragment");
    assert.strictEqual(redacted3, "https://cdn.example.com:8443/media.mp4?[redacted]");
    assert.ok(!redacted3.includes("admin"));
    assert.ok(!redacted3.includes("super_secret_pass"));
    assert.ok(!redacted3.includes("fragment"));
});

test("Logger Test 5: Malformed URL handling returns safe placeholders", () => {
    assert.strictEqual(redactUrl("not-a-url"), "[invalid-url]");
    assert.strictEqual(redactUrl("javascript:alert(1)"), "[invalid-url]");
    assert.strictEqual(redactUrl("file:///etc/passwd"), "[invalid-url]");
    assert.strictEqual(redactUrl("https://example.com/bad\x00control"), "[invalid-url]");
    assert.strictEqual(redactUrl("https://example.com/\nnewline"), "[invalid-url]");
    assert.strictEqual(redactUrl(""), "[none]");
    assert.strictEqual(redactUrl(null), "[none]");
    assert.strictEqual(redactUrl(undefined), "[none]");
    assert.strictEqual(redactUrl(12345), "[none]");
});

test("Logger Test 6: Code formatting sanitizes and bounds code field", () => {
    // Normal string code
    assert.strictEqual(sanitizeCode("EXTRACTION_FAILED"), "EXTRACTION_FAILED");

    // Numeric HTTP status code
    assert.strictEqual(sanitizeCode(404), "404");

    // Error instance
    assert.strictEqual(sanitizeCode(new Error("TestError")), "Error");
    const customErr = new Error("msg");
    customErr.code = "ERR_SSRF_BLOCKED";
    assert.strictEqual(sanitizeCode(customErr), "ERR_SSRF_BLOCKED");

    // Injection attempt in code (newlines, control chars, spaces)
    assert.strictEqual(sanitizeCode("ERR_CODE\r\nFAKE_HEADER: 1"), "ERR_CODE__FAKE_HEADER__1");

    // Arbitrary object should never be serialized
    assert.strictEqual(sanitizeCode({ secret: "data" }), "UNKNOWN_ERROR");

    // Length bounding to 64 chars
    const longCode = "A".repeat(100);
    const sanitized = sanitizeCode(longCode);
    assert.strictEqual(sanitized.length, 64);
});

test("Logger Test 7: Message escaping handles quotes correctly", () => {
    const escaped = sanitizeMessage('Failed to download "sample video" from source');
    assert.strictEqual(escaped, 'Failed to download \\"sample video\\" from source');
});

test("Logger Test 8: Message length bounding truncates long messages", () => {
    const longMsg = "B".repeat(400);
    const bounded = sanitizeMessage(longMsg, 256);
    assert.ok(bounded.length <= 256 + "...[truncated]".length);
    assert.ok(bounded.endsWith("...[truncated]"));
});

test("Logger Test 9: Newline and control-character sanitization prevents log injection", () => {
    const injectionMsg = "Valid message\r\n[ERROR] 2026-10-06T00:00:00Z Injected fake log entry\x00\x1f\tTabs and spaces";
    const sanitized = sanitizeMessage(injectionMsg);

    assert.ok(!sanitized.includes("\r"), "Must not contain carriage returns");
    assert.ok(!sanitized.includes("\n"), "Must not contain newlines");
    assert.ok(!sanitized.includes("\x00"), "Must not contain null bytes");
    assert.ok(!sanitized.includes("\x1f"), "Must not contain control bytes");
    assert.strictEqual(
        sanitized,
        "Valid message [ERROR] 2026-10-06T00:00:00Z Injected fake log entry Tabs and spaces"
    );
});

test("Logger Test 10: Sensitive query values never appear in formatted logs", () => {
    const sensitiveToken = "SUPER_SECRET_TOKEN_XYZ_12345";
    const sensitiveAuth = "BEARER_AUTH_SECRET_67890";

    const logLine = formatLog("INFO", {
        requestId: "req_0123456789abcdef",
        url: `https://instagram.com/reel/xyz?token=${sensitiveToken}`,
        message: `Fetched metadata from https://upstream.provider.com/api?auth=${sensitiveAuth} done`
    });

    assert.ok(!logLine.includes(sensitiveToken), "Sensitive URL token must not appear in formatted log");
    assert.ok(!logLine.includes(sensitiveAuth), "Sensitive message token must not appear in formatted log");
    assert.ok(logLine.includes("?[redacted]"), "Redacted token indicator must be present");
});

test("Logger Test 11: Logger metadata containing unexpected objects does not cause unsafe serialization", () => {
    const cyclicObj = {};
    cyclicObj.self = cyclicObj;

    const logLine = formatLog("INFO", {
        requestId: "req_0123456789abcdef",
        platform: "youtube",
        operation: "extract",
        status: "success",
        // Unexpected / arbitrary properties that should NOT be serialized
        unexpectedObject: { password: "admin", privateKey: "RSA_KEY" },
        buffer: Buffer.from("arbitrary binary"),
        func: () => "evil",
        cyclic: cyclicObj
    });

    assert.ok(!logLine.includes("privateKey"), "Unexpected object keys must not be serialized");
    assert.ok(!logLine.includes("password"), "Unexpected object values must not be serialized");
    assert.ok(!logLine.includes("arbitrary binary"), "Buffers must not be serialized");
    assert.ok(!logLine.includes("[object Object]"), "Blind stringification must be avoided");
});

test("Logger Test 12: Normal log output remains structured and human-readable", () => {
    const logLine = formatLog("INFO", {
        requestId: "req_0123456789abcdef",
        platform: "instagram",
        operation: "extract",
        status: "success",
        code: "OK",
        durationMs: 142,
        message: "Extraction completed successfully."
    });

    assert.match(logLine, /^\[INFO\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z requestId=req_0123456789abcdef platform=instagram operation=extract status=success code=OK durationMs=142 message="Extraction completed successfully\."$/);
});

// =========================================================================
// TASK 7: ERROR RESPONSE & SENSITIVE DATA LEAKAGE PREVENTION TESTS
// =========================================================================

test("Error Response Test 1: Extraction error normalizes internal errors and suppresses system paths & stack traces", async () => {
    // Create an orchestrator with a failing adapter that throws internal details
    const secretPath = "C:\\Windows\\System32\\drivers\\etc\\hosts";
    const mockFailingAdapter = async () => {
        const err = new Error(`Command failed: yt-dlp --dump-json --output ${secretPath} https://private.upstream.com?token=SECRET_123`);
        err.stack = `Error: at /app/internal/extractor.js:42:15\n    at runProcess (/app/bin/exec.js:10:5)`;
        throw err;
    };

    const orchestrator = createExtractionOrchestrator({
        adapters: {
            youtube: mockFailingAdapter
        }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            requestId: "req_0123456789abcdef"
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.strictEqual(err.code, EXTRACTION_ERROR_CODES.EXTRACTION_FAILED);
            // Public message is strictly sanitized
            assert.strictEqual(err.message, "Failed to extract media from the requested URL.");
            // Internal details, filesystem paths, tokens, commands must not be exposed on err.message
            assert.ok(!err.message.includes(secretPath));
            assert.ok(!err.message.includes("yt-dlp"));
            assert.ok(!err.message.includes("SECRET_123"));
            assert.ok(!err.message.includes("/app/internal"));
            return true;
        }
    );
});

test("Error Response Test 2: HTTP /api/download/:platform returns sanitized public error without stack or internal paths", async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
        // Request invalid platform URL (triggering validation error)
        const res = await fetch(`http://127.0.0.1:${port}/api/download/instagram?url=https://invalid-host.com/not-instagram`);
        assert.strictEqual(res.status, 400);

        const data = await res.json();
        assert.ok(data.error);
        assert.strictEqual(typeof data.error.code, "string");
        assert.strictEqual(typeof data.error.message, "string");
        assert.match(data.requestId, /^req_[a-f0-9]{16}$/);

        // Verify zero leakage of stack traces, filesystem paths, or runtime environments
        const serialized = JSON.stringify(data);
        assert.ok(!serialized.includes("stack"));
        assert.ok(!serialized.includes("node_modules"));
        assert.ok(!serialized.includes(".cjs"));
        assert.ok(!serialized.includes("server.cjs"));
    } finally {
        if (server.listening) server.close();
    }
});

test("Error Response Test 3: HTTP /api/media/:mediaId non-existent media returns clean 404 without paths", async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/media/med_nonexistent1234`);
        assert.strictEqual(res.status, 404);

        const data = await res.json();
        assert.strictEqual(data.error.code, "MEDIA_NOT_FOUND");
        assert.strictEqual(data.error.message, "The requested media link has expired or does not exist. Please extract again.");
        assert.match(data.requestId, /^req_[a-f0-9]{16}$/);

        const serialized = JSON.stringify(data);
        assert.ok(!serialized.includes("REEVA_TEMP_DIR"));
        assert.ok(!serialized.includes("stack"));
    } finally {
        if (server.listening) server.close();
    }
});

test("Error Response Test 4: Global error handler returns sanitized 500 without leaking stack trace or file paths", async () => {
    // Test the global error handler middleware directly
    const req = {
        id: "req_0123456789abcdef",
        headers: {}
    };

    let responseStatus = 0;
    let responseBody = null;

    const res = {
        status(code) {
            responseStatus = code;
            return this;
        },
        json(body) {
            responseBody = body;
            return this;
        }
    };

    const simulatedInternalError = new Error("Database connection to /var/secrets/db.sock failed with password=MY_SECRET_DB_PASSWORD");
    simulatedInternalError.stack = "Error at Object.<anonymous> (/var/app/db.js:10:5)";

    // Find the global error handler on app._router.stack
    const globalErrorHandlerLayer = app._router.stack.find((layer) => layer.handle && layer.handle.length === 4);
    assert.ok(globalErrorHandlerLayer, "Global error handler layer must exist on Express router");

    globalErrorHandlerLayer.handle(simulatedInternalError, req, res, () => {});

    assert.strictEqual(responseStatus, 500);
    assert.deepStrictEqual(responseBody, {
        error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "An internal server error occurred."
        },
        requestId: "req_0123456789abcdef"
    });

    const serialized = JSON.stringify(responseBody);
    assert.ok(!serialized.includes("MY_SECRET_DB_PASSWORD"));
    assert.ok(!serialized.includes("/var/secrets"));
    assert.ok(!serialized.includes("stack"));
});

test("Error Response Test 5: Streaming lifecycle logs start, success, and error events with safe metadata", async () => {
    const { logger } = require("../lib/logger.cjs");
    const { defaultRegistry } = require("../lib/media-registry.cjs");
    const { REEVA_TEMP_DIR } = require("../lib/extraction/adapters/youtube.cjs");
    const fs = require("fs");
    const path = require("path");

    const originalInfo = logger.info;
    const originalError = logger.error;
    const capturedLogs = [];

    logger.info = (meta) => {
        capturedLogs.push({ level: "INFO", meta: { ...meta } });
        return originalInfo(meta);
    };
    logger.error = (meta) => {
        capturedLogs.push({ level: "ERROR", meta: { ...meta } });
        return originalError(meta);
    };

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const testFile = path.join(REEVA_TEMP_DIR, `test_obs_${Date.now()}.mp4`);
    fs.writeFileSync(testFile, Buffer.alloc(1024, "X"));

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://www.instagram.com/p/test_obs",
        platform: "instagram",
        type: "video",
        title: "Observability Test Video",
        localFilePath: testFile
    });

    try {
        // Successful stream
        const res = await fetch(`http://127.0.0.1:${port}/api/media/${reg.id}`);
        assert.strictEqual(res.status, 200);
        await res.arrayBuffer();

        // Allow microtask tick for finish event
        await new Promise((r) => setTimeout(r, 50));

        const streamStartLog = capturedLogs.find((l) => l.meta.operation === "stream" && l.meta.status === "start");
        assert.ok(streamStartLog, "Stream start log must be emitted");
        assert.strictEqual(streamStartLog.meta.platform, "instagram");
        assert.match(streamStartLog.meta.requestId, /^req_[a-f0-9]{16}$/);
        assert.strictEqual(streamStartLog.meta.mediaId, undefined, "mediaId must not be logged");
        assert.strictEqual(streamStartLog.meta.url, undefined, "raw upstream url must not be logged");

        const streamSuccessLog = capturedLogs.find((l) => l.meta.operation === "stream" && l.meta.status === "success");
        assert.ok(streamSuccessLog, "Stream success log must be emitted");
        assert.strictEqual(streamSuccessLog.meta.platform, "instagram");
        assert.strictEqual(typeof streamSuccessLog.meta.durationMs, "number");

        // Error stream: Access denied on forbidden file
        capturedLogs.length = 0;
        const badReg = defaultRegistry.registerMedia({
            upstreamUrl: "https://www.instagram.com/p/test_bad",
            platform: "instagram",
            type: "video",
            title: "Bad File",
            localFilePath: path.resolve("../outside.mp4")
        });

        const resBad = await fetch(`http://127.0.0.1:${port}/api/media/${badReg.id}`);
        assert.strictEqual(resBad.status, 403);
        await new Promise((r) => setTimeout(r, 50));

        const streamErrorLog = capturedLogs.find((l) => l.meta.operation === "stream" && l.meta.status === "error");
        assert.ok(streamErrorLog, "Stream error log must be emitted");
        assert.strictEqual(streamErrorLog.meta.code, "ACCESS_DENIED");
        assert.strictEqual(typeof streamErrorLog.meta.durationMs, "number");

    } finally {
        logger.info = originalInfo;
        logger.error = originalError;
        if (server.listening) server.close();
        if (fs.existsSync(testFile)) {
            try { fs.unlinkSync(testFile); } catch (_) {}
        }
    }
});
