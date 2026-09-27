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
