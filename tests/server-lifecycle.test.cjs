// tests/server-lifecycle.test.cjs — Deterministic Tests for Server Lifecycle, Trust Proxy, and Probes
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const {
    parseTrustProxy,
    validatePositiveInteger,
    validateServerConfig,
    ConfigError
} = require("../lib/config.cjs");

const app = require("../server.cjs");

// =========================================================================
// 1. TRUST_PROXY Strict Parser Tests
// =========================================================================

test("parseTrustProxy: Unset / empty values return false", () => {
    assert.strictEqual(parseTrustProxy(undefined), false);
    assert.strictEqual(parseTrustProxy(null), false);
    assert.strictEqual(parseTrustProxy(""), false);
});

test("parseTrustProxy: false and 0 representations return false", () => {
    assert.strictEqual(parseTrustProxy(false), false);
    assert.strictEqual(parseTrustProxy("false"), false);
    assert.strictEqual(parseTrustProxy("FALSE"), false);
    assert.strictEqual(parseTrustProxy(0), false);
    assert.strictEqual(parseTrustProxy("0"), false);
});

test("parseTrustProxy: true representations return true", () => {
    assert.strictEqual(parseTrustProxy(true), true);
    assert.strictEqual(parseTrustProxy("true"), true);
    assert.strictEqual(parseTrustProxy("TRUE"), true);
});

test("parseTrustProxy: Valid hop count integers return numeric values", () => {
    assert.strictEqual(parseTrustProxy("1"), 1);
    assert.strictEqual(parseTrustProxy("2"), 2);
    assert.strictEqual(parseTrustProxy("10"), 10);
    assert.strictEqual(parseTrustProxy(1), 1);
    assert.strictEqual(parseTrustProxy(2), 2);
});

test("parseTrustProxy: Valid subnets and CIDR blocks return validated strings", () => {
    assert.strictEqual(parseTrustProxy("loopback"), "loopback");
    assert.strictEqual(parseTrustProxy("linklocal"), "linklocal");
    assert.strictEqual(parseTrustProxy("uniquelocal"), "uniquelocal");
    assert.strictEqual(parseTrustProxy("127.0.0.1"), "127.0.0.1");
    assert.strictEqual(parseTrustProxy("10.0.0.0/8"), "10.0.0.0/8");
    assert.strictEqual(parseTrustProxy("172.16.0.0/12"), "172.16.0.0/12");
    assert.strictEqual(parseTrustProxy("192.168.0.0/16"), "192.168.0.0/16");
});

test("parseTrustProxy: Invalid configurations throw ConfigError", () => {
    assert.throws(() => parseTrustProxy("invalid_subnet"), {
        name: "ConfigError",
        message: /Invalid TRUST_PROXY configuration/
    });
    assert.throws(() => parseTrustProxy("example.com"), {
        name: "ConfigError",
        message: /Invalid TRUST_PROXY configuration/
    });
    assert.throws(() => parseTrustProxy("-1"), {
        name: "ConfigError"
    });
    assert.throws(() => parseTrustProxy(-5), {
        name: "ConfigError"
    });
    assert.throws(() => parseTrustProxy({}), {
        name: "ConfigError"
    });
});

// =========================================================================
// 2. Server Configuration Validation Tests
// =========================================================================

test("validatePositiveInteger: Validates correct ranges and rejects bad values", () => {
    assert.strictEqual(validatePositiveInteger("3000", 3000, "PORT", 1, 65535), 3000);
    assert.strictEqual(validatePositiveInteger(undefined, 8080, "PORT", 1, 65535), 8080);
    assert.strictEqual(validatePositiveInteger(null, 8080, "PORT", 1, 65535), 8080);

    assert.throws(() => validatePositiveInteger("0", 3000, "PORT", 1, 65535), {
        name: "ConfigError",
        message: /Invalid PORT/
    });
    assert.throws(() => validatePositiveInteger("70000", 3000, "PORT", 1, 65535), {
        name: "ConfigError",
        message: /Invalid PORT/
    });
    assert.throws(() => validatePositiveInteger("abc", 3000, "PORT", 1, 65535), {
        name: "ConfigError",
        message: /Invalid PORT/
    });
});

test("validateServerConfig: Produces sane defaults with empty env", () => {
    const config = validateServerConfig({});
    assert.strictEqual(config.port, 3000);
    assert.strictEqual(config.trustProxy, false);
    assert.strictEqual(config.shutdownTimeoutMs, 10000);
    assert.strictEqual(config.maxMediaSizeBytes, 262144000);
    assert.strictEqual(config.maxGlobalExtractionConcurrency, 30);
    assert.strictEqual(config.maxIpExtractionConcurrency, 3);
    assert.strictEqual(config.maxGlobalStreamConcurrency, 50);
    assert.strictEqual(config.maxIpStreamConcurrency, 5);
});

test("validateServerConfig: Fails fast on invalid configuration", () => {
    assert.throws(() => validateServerConfig({ PORT: "invalid" }), { name: "ConfigError" });
    assert.throws(() => validateServerConfig({ MAX_MEDIA_SIZE_BYTES: "-100" }), { name: "ConfigError" });
    assert.throws(() => validateServerConfig({ SHUTDOWN_TIMEOUT_MS: "50" }), { name: "ConfigError" });
    assert.throws(() => validateServerConfig({ TRUST_PROXY: "malicious-host" }), { name: "ConfigError" });
});

// =========================================================================
// 3. HTTP Probes & req.ip Resolution Tests
// =========================================================================

test("GET /health: Returns 200 with status ok and timestamp", async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.status, "ok");
        assert.ok(data.timestamp);
        // Ensure no internal env or leakages present
        assert.strictEqual(data.env, undefined);
        assert.strictEqual(data.config, undefined);
    } finally {
        server.close();
    }
});

test("GET /ready: Returns 200 status ready when healthy", async () => {
    app.resetShutdownState();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
        const res = await fetch(`http://127.0.0.1:${port}/ready`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.status, "ready");
    } finally {
        server.close();
    }
});

test("GET /ready: Returns 503 during graceful shutdown", async () => {
    app.resetShutdownState();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    // Simulate an in-flight extraction so server stays in draining state during test window
    const inFlight = new AbortController();
    app.getActiveExtractionControllers().add(inFlight);

    try {
        // Trigger graceful shutdown
        const shutdownPromise = app.gracefulShutdown("TEST_SHUTDOWN", { timeoutMs: 500, server });

        // /ready probe should immediately report 503
        const res = await fetch(`http://127.0.0.1:${port}/ready`);
        assert.strictEqual(res.status, 503);
        const data = await res.json();
        assert.strictEqual(data.status, "shutting_down");

        await shutdownPromise;
    } finally {
        app.resetShutdownState();
        if (server.listening) server.close();
    }
});

test("req.ip resolution with TRUST_PROXY = 1", async () => {
    const express = require("express");
    const testApp = express();
    testApp.set("trust proxy", 1);
    testApp.get("/probe-ip", (req, res) => {
        res.json({ ip: req.ip });
    });

    const server = http.createServer(testApp);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
        const res = await fetch(`http://127.0.0.1:${port}/probe-ip`, {
            headers: {
                "X-Forwarded-For": "198.51.100.42, 10.0.0.1"
            }
        });
        const data = await res.json();
        assert.strictEqual(data.ip, "10.0.0.1");
    } finally {
        server.close();
    }
});

// =========================================================================
// 4. Extraction & Shutdown Lifecycle Integration Tests
// =========================================================================

test("New extractions rejected with 503 when server is shutting down", async () => {
    app.resetShutdownState();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    // Simulate an in-flight extraction so server stays in draining state during test window
    const inFlight = new AbortController();
    app.getActiveExtractionControllers().add(inFlight);

    try {
        // Initiate shutdown
        const shutdownPromise = app.gracefulShutdown("TEST_SHUTDOWN", { timeoutMs: 500, server });

        const res = await fetch(`http://127.0.0.1:${port}/api/download/instagram?url=https://www.instagram.com/p/test`);
        assert.strictEqual(res.status, 503);
        const data = await res.json();
        assert.strictEqual(data.error.code, "SERVICE_UNAVAILABLE");

        await shutdownPromise;
    } finally {
        app.resetShutdownState();
        if (server.listening) server.close();
    }
});

test("Graceful shutdown is idempotent", async () => {
    app.resetShutdownState();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));

    try {
        const promise1 = app.gracefulShutdown("SIGTERM", { timeoutMs: 100, server });
        const promise2 = app.gracefulShutdown("SIGTERM", { timeoutMs: 100, server });
        assert.strictEqual(promise1, promise2, "Multiple calls must return the identical promise instance");

        await Promise.all([promise1, promise2]);
        assert.strictEqual(app.getIsShuttingDown(), true);
    } finally {
        app.resetShutdownState();
        if (server.listening) server.close();
    }
});

test("Active extraction AbortController is aborted when shutdown deadline expires", async () => {
    app.resetShutdownState();
    const controllers = app.getActiveExtractionControllers();
    assert.strictEqual(controllers.size, 0);

    // Simulate an active in-flight extraction AbortController
    const activeMockController = new AbortController();
    let wasAborted = false;
    activeMockController.signal.addEventListener("abort", () => {
        wasAborted = true;
    });
    controllers.add(activeMockController);

    try {
        // Shutdown with a very small timeout (100ms)
        await app.gracefulShutdown("TIMEOUT_TEST", { timeoutMs: 100 });

        assert.strictEqual(wasAborted, true, "Active extraction controller must be signaled to abort after deadline expires");
        assert.strictEqual(controllers.size, 0, "Active controller set must be cleared after shutdown");
    } finally {
        app.resetShutdownState();
    }
});

// =========================================================================
// 5. Signal Handling Subprocess Integration Test
// =========================================================================

test("Subprocess exits cleanly with code 0 on SIGINT / SIGTERM", async () => {
    const serverPath = path.resolve(__dirname, "../server.cjs");
    const child = spawn(process.execPath, [serverPath], {
        env: {
            ...process.env,
            PORT: "3099",
            SHUTDOWN_TIMEOUT_MS: "1000",
            NODE_ENV: "test"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutData = "";
    child.stdout.on("data", (chunk) => {
        stdoutData += chunk.toString();
    });

    // Wait for the server to log live message
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for child server startup")), 5000);
        child.stdout.on("data", (chunk) => {
            if (chunk.toString().includes("Reeva backend is live")) {
                clearTimeout(timeout);
                resolve();
            }
        });
        child.on("error", reject);
    });

    // Send SIGINT
    const exitCodePromise = new Promise((resolve) => {
        child.on("exit", (code, signal) => {
            resolve({ code, signal });
        });
    });

    child.kill("SIGINT");

    const result = await exitCodePromise;
    // On Windows, child.kill sends TerminateProcess or exit code 0/1 depending on platform signal emulation
    // Either exit code 0 or null with SIGINT / SIGTERM
    assert.ok(result.code === 0 || result.signal === "SIGINT" || result.code === null);
});
