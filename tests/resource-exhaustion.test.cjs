// tests/resource-exhaustion.test.cjs — Automated Tests for Resource Exhaustion Controls
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { StreamMeter, ResponseTooLargeError } = require("../lib/http-client.cjs");
const { createConcurrencyLimiter } = require("../lib/concurrency-limiter.cjs");
const { BoundedCache } = require("../lib/cache.cjs");

test("Resource Limit: StreamMeter terminates when byte threshold is exceeded", async () => {
    const limitBytes = 1000;
    let limitCallbackCalled = false;

    const meter = new StreamMeter(limitBytes, () => {
        limitCallbackCalled = true;
    });

    const errorPromise = new Promise((resolve) => {
        meter.on("error", (err) => {
            resolve(err);
        });
    });

    // Write safe chunk
    meter.write(Buffer.alloc(500));
    assert.equal(meter.bytesRead, 500);

    // Write chunk that breaches limit
    meter.write(Buffer.alloc(600)); // Total 1100 > 1000

    const err = await errorPromise;
    assert.ok(err instanceof ResponseTooLargeError);
    assert.equal(limitCallbackCalled, true, "Expected abort callback to be executed");
});

test("Concurrency Limiter: Blocks excessive simultaneous requests per IP", () => {
    const limiter = createConcurrencyLimiter({ maxGlobal: 10, maxPerIp: 2 });

    const mockReq = { ip: "198.51.100.5", socket: {} };
    const createMockRes = () => {
        const listeners = {};
        return {
            status: function (code) { this.statusCode = code; return this; },
            json: function (payload) { this.body = payload; return this; },
            on: function (event, fn) { listeners[event] = fn; },
            emit: function (event) { if (listeners[event]) listeners[event](); }
        };
    };

    let nextCalled = 0;
    const next = () => { nextCalled++; };

    const res1 = createMockRes();
    const res2 = createMockRes();
    const res3 = createMockRes();

    // Request 1: should pass
    limiter(mockReq, res1, next);
    assert.equal(nextCalled, 1);
    assert.equal(limiter.getIpActive("198.51.100.5"), 1);

    // Request 2: should pass
    limiter(mockReq, res2, next);
    assert.equal(nextCalled, 2);
    assert.equal(limiter.getIpActive("198.51.100.5"), 2);

    // Request 3: should be rejected with 429
    limiter(mockReq, res3, next);
    assert.equal(nextCalled, 2, "3rd request must not proceed to next()");
    assert.equal(res3.statusCode, 429, "Expected 429 status code for concurrency breach");
    assert.equal(res3.body.error.code, "CONCURRENCY_IP_LIMIT");

    // Finish request 1 -> slot must be freed
    res1.emit("finish");
    assert.equal(limiter.getIpActive("198.51.100.5"), 1, "Slot should be released on finish");

    // Request 4: now should pass
    const res4 = createMockRes();
    limiter(mockReq, res4, next);
    assert.equal(nextCalled, 3);
});

test("Cache Security: Bounded cache enforces maxEntries and evicts LRU entries", () => {
    const cache = new BoundedCache(3, 60000);

    cache.set("https://instagram.com/p/1", { id: 1 });
    cache.set("https://instagram.com/p/2", { id: 2 });
    cache.set("https://instagram.com/p/3", { id: 3 });

    assert.equal(cache.size, 3);
    assert.ok(cache.has("https://instagram.com/p/1"));

    // Access key 1 so key 2 becomes the oldest/least recently used
    cache.get("https://instagram.com/p/1");

    // Add 4th item -> should evict key 2
    cache.set("https://instagram.com/p/4", { id: 4 });

    assert.equal(cache.size, 3, "Cache size must not exceed maxEntries");
    assert.equal(cache.has("https://instagram.com/p/2"), false, "LRU entry 2 must be evicted");
    assert.ok(cache.has("https://instagram.com/p/1"));
    assert.ok(cache.has("https://instagram.com/p/4"));

    cache.destroy();
});

test("Resource Limit (Test D): HTML stream reader terminates when Content-Length is absent", async () => {
    const { Readable } = require("stream");
    const { readStreamWithLimit } = require("../lib/http-client.cjs");

    const limitBytes = 2048; // 2 KB test threshold
    let abortCalled = false;
    let streamDestroyed = false;

    // Create a chunked stream with no Content-Length that generates 5 KB of data
    const chunkCount = 5;
    const chunkSize = 1024;
    let chunksSent = 0;

    const stream = new Readable({
        read() {
            if (chunksSent < chunkCount) {
                chunksSent++;
                this.push(Buffer.alloc(chunkSize, "x"));
            } else {
                this.push(null);
            }
        },
        destroy(err, cb) {
            streamDestroyed = true;
            cb(err);
        }
    });

    const abortFn = () => {
        abortCalled = true;
        stream.destroy();
    };

    let caughtError = null;
    try {
        await readStreamWithLimit(stream, limitBytes, abortFn);
    } catch (err) {
        caughtError = err;
    }

    assert.ok(caughtError, "Expected stream reader to reject when size exceeds limit");
    assert.ok(caughtError instanceof ResponseTooLargeError);
    assert.equal(abortCalled, true, "Upstream abort must be called when limit is exceeded");
    assert.equal(streamDestroyed, true, "Stream must be destroyed");
    assert.ok(chunksSent < chunkCount, "Stream consumption must stop immediately");
});

test("Resource Limit (Test E): HTML stream reader terminates when Content-Length lies", async () => {
    const { Readable } = require("stream");
    const { readStreamWithLimit } = require("../lib/http-client.cjs");

    const limitBytes = 1024; // 1 KB
    let abortCalled = false;

    // Simulate an upstream response where header claimed 50 bytes, but stream produces 3000 bytes
    let producedBytes = 0;
    const stream = new Readable({
        read() {
            if (producedBytes < 3000) {
                producedBytes += 600;
                this.push(Buffer.alloc(600, "a"));
            } else {
                this.push(null);
            }
        }
    });

    const abortFn = () => {
        abortCalled = true;
        stream.destroy();
    };

    let caughtError = null;
    try {
        await readStreamWithLimit(stream, limitBytes, abortFn);
    } catch (err) {
        caughtError = err;
    }

    assert.ok(caughtError, "Stream reader must reject even when Content-Length claimed safe size");
    assert.ok(caughtError instanceof ResponseTooLargeError);
    assert.equal(abortCalled, true, "Upstream abort must be called");
});

test("Resource Limit: HTML stream reader succeeds for responses within limit", async () => {
    const { Readable } = require("stream");
    const { readStreamWithLimit } = require("../lib/http-client.cjs");

    const safeHtml = "<html><head><title>Reeva Safe Page</title></head><body>OK</body></html>";
    const stream = Readable.from([Buffer.from(safeHtml)]);

    const result = await readStreamWithLimit(stream, 10000, () => {});
    assert.equal(result, safeHtml);
});

test("Resource Limit: readStreamWithLimit handles errors emitted during/after destruction without unhandled error events", async () => {
    const { Readable } = require("stream");
    const { readStreamWithLimit, ResponseTooLargeError } = require("../lib/http-client.cjs");

    let abortCalled = false;
    let streamDestroyed = false;
    let rejectCount = 0;
    let unhandledErrorOccurred = false;

    const unhandledListener = () => {
        unhandledErrorOccurred = true;
    };
    process.on("uncaughtException", unhandledListener);

    const stream = new Readable({
        read() {
            // Push chunk that exceeds the 500 byte limit
            this.push(Buffer.alloc(600, "b"));
        },
        destroy(err, cb) {
            streamDestroyed = true;
            // Emit an error during destruction
            this.emit("error", new Error("Socket error during destroy"));
            cb(err);
        }
    });

    const abortFn = () => {
        abortCalled = true;
    };

    let caughtError = null;
    try {
        await readStreamWithLimit(stream, 500, abortFn);
    } catch (err) {
        rejectCount++;
        caughtError = err;
    }

    // Also emit an error post-destruction on next tick to verify post-destruction safety
    await new Promise((resolve) => {
        process.nextTick(() => {
            try {
                stream.emit("error", new Error("Late socket reset after destroy"));
            } catch {
                unhandledErrorOccurred = true;
            }
            resolve();
        });
    });

    process.removeListener("uncaughtException", unhandledListener);

    assert.equal(rejectCount, 1, "Function must reject exactly once");
    assert.ok(caughtError instanceof ResponseTooLargeError, "Rejection error must be ResponseTooLargeError");
    assert.equal(abortCalled, true, "Upstream abort must still happen");
    assert.equal(streamDestroyed, true, "Stream destroy must be called");
    assert.equal(unhandledErrorOccurred, false, "No unhandled error event must occur");
});

test("Subprocess Security: defaultCommandRunner aborts on AbortSignal and terminates process", async () => {
    const { defaultCommandRunner } = require("../lib/extraction/adapters/youtube.cjs");
    const { ExtractionError } = require("../lib/extraction/types.cjs");

    const controller = new AbortController();
    const startTime = Date.now();

    // Spawn a long-running node process (30s sleep)
    const runnerPromise = defaultCommandRunner({
        command: "node",
        args: ["-e", "setTimeout(() => {}, 30000);"],
        timeoutMs: 30000,
        signal: controller.signal
    });

    // Abort after 50ms
    setTimeout(() => {
        controller.abort();
    }, 50);

    await assert.rejects(
        () => runnerPromise,
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.ok(err.message.includes("cancelled by client"));
            return true;
        }
    );

    const elapsed = Date.now() - startTime;
    assert.ok(elapsed < 2000, `Process must be terminated immediately upon abort (elapsed: ${elapsed}ms)`);
});

test("Disk Security: cleanStaleTempFiles unlinks old artifacts and preserves recent ones", () => {
    const fs = require("fs");
    const path = require("path");
    const { REEVA_TEMP_DIR, cleanStaleTempFiles } = require("../lib/extraction/adapters/youtube.cjs");

    if (!fs.existsSync(REEVA_TEMP_DIR)) {
        fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    }

    const oldFile = path.join(REEVA_TEMP_DIR, `reeva_mux_old_test_${Date.now()}.mp4`);
    const recentFile = path.join(REEVA_TEMP_DIR, `reeva_mux_recent_test_${Date.now()}.mp4`);

    fs.writeFileSync(oldFile, "old-content");
    fs.writeFileSync(recentFile, "recent-content");

    // Set mtime of oldFile to 1 hour ago
    const oneHourAgo = (Date.now() - 3600 * 1000) / 1000;
    fs.utimesSync(oldFile, oneHourAgo, oneHourAgo);

    const removed = cleanStaleTempFiles(15 * 60 * 1000); // 15 min max age
    assert.ok(removed >= 1, "At least 1 old file should be removed");
    assert.equal(fs.existsSync(oldFile), false, "Old file must be deleted");
    assert.equal(fs.existsSync(recentFile), true, "Recent file must be preserved");

    // Clean up recent test file
    try { fs.unlinkSync(recentFile); } catch (_) {}
});

test("Media Registry: Background sweep timer proactively deletes expired entries and unlinks local files", async () => {
    const fs = require("fs");
    const path = require("path");
    const { MediaRegistry } = require("../lib/media-registry.cjs");
    const { REEVA_TEMP_DIR } = require("../lib/extraction/adapters/youtube.cjs");

    if (!fs.existsSync(REEVA_TEMP_DIR)) {
        fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    }

    // Registry with 50ms TTL
    const registry = new MediaRegistry(10, 50);
    const testFile = path.join(REEVA_TEMP_DIR, `test_reg_sweep_${Date.now()}.mp4`);
    fs.writeFileSync(testFile, "test data");

    const registered = registry.registerMedia({
        upstreamUrl: "https://example.com/video.mp4",
        platform: "youtube",
        localFilePath: testFile
    });

    assert.ok(fs.existsSync(testFile), "File must exist after registration");
    assert.equal(registry.size, 1);

    // Wait 100ms for TTL to expire
    await new Promise(r => setTimeout(r, 100));

    // Run sweep
    registry.sweepExpired();

    assert.equal(registry.size, 0, "Expired entry must be swept");
    assert.equal(fs.existsSync(testFile), false, "Local file must be unlinked on expiry sweep");

    registry.destroy();
});

test("Extraction Orchestrator: In-flight deduplication coalesces concurrent identical requests", async () => {
    const { createExtractionOrchestrator } = require("../lib/extraction/index.cjs");
    const { BoundedCache } = require("../lib/cache.cjs");

    let adapterCalls = 0;
    const mockAdapter = async () => {
        adapterCalls++;
        await new Promise(r => setTimeout(r, 60));
        return {
            url: "https://video.twimg.com/coalesce_test.mp4",
            type: "video",
            title: "Coalesced Video"
        };
    };

    const orchestrator = createExtractionOrchestrator({
        cache: new BoundedCache(50, 60000),
        adapters: {
            twitter: mockAdapter
        }
    });

    const p1 = orchestrator.extractMedia({ platform: "twitter", sourceUrl: "https://x.com/user/status/11223344", requestId: "r1" });
    const p2 = orchestrator.extractMedia({ platform: "twitter", sourceUrl: "https://x.com/user/status/11223344", requestId: "r2" });
    const p3 = orchestrator.extractMedia({ platform: "twitter", sourceUrl: "https://x.com/user/status/11223344", requestId: "r3" });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.equal(adapterCalls, 1, "Only 1 adapter execution must occur for concurrent identical requests");
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.equal(r3.success, true);
    assert.equal(r2.deduplicated, true);
    assert.equal(r3.deduplicated, true);
});

test("Concurrency Limiter: Decoupled extraction and stream limiters prevent streaming starvation", () => {
    const { createConcurrencyLimiter } = require("../lib/concurrency-limiter.cjs");

    const extractionLimiter = createConcurrencyLimiter({ maxGlobal: 2, maxPerIp: 1 });
    const streamLimiter = createConcurrencyLimiter({ maxGlobal: 5, maxPerIp: 2 });

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

    // Saturate extraction limiter (2 active requests from IP1 and IP2)
    const resExt1 = createMockRes();
    const resExt2 = createMockRes();
    extractionLimiter({ ip: "1.1.1.1" }, resExt1, () => {});
    extractionLimiter({ ip: "2.2.2.2" }, resExt2, () => {});
    assert.equal(extractionLimiter.getGlobalActive(), 2);

    // 3rd extraction request must be rejected with 503
    const resExt3 = createMockRes();
    extractionLimiter({ ip: "3.3.3.3" }, resExt3, () => {});
    assert.equal(resExt3.statusCode, 503);

    // BUT streaming requests must NOT be starved because streamLimiter is decoupled!
    const resStream1 = createMockRes();
    let streamNextCalled = false;
    streamLimiter({ ip: "3.3.3.3" }, resStream1, () => { streamNextCalled = true; });
    assert.equal(streamNextCalled, true, "Streaming request must proceed even when extraction slots are full");
    assert.equal(streamLimiter.getGlobalActive(), 1);

    // Teardown
    resExt1.emit("finish");
    resExt2.emit("finish");
    resStream1.emit("finish");
});


