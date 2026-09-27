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


