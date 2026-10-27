"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const scriptPath = path.resolve(__dirname, "../scripts/live-video-smoke.cjs");

async function runAgainstMockReeva({ body, contentType, maxBytes = 4096 }) {
    const server = http.createServer((req, res) => {
        if (req.url === "/ready") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "ready" }));
            return;
        }

        if (req.url.startsWith("/api/download/youtube?")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ streamUrl: "/api/media/test-media" }));
            return;
        }

        if (req.url === "/api/media/test-media?download=1") {
            res.writeHead(200, {
                "content-type": contentType,
                "content-length": String(body.length)
            });
            res.end(body);
            return;
        }

        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }));
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    try {
        const address = server.address();
        const result = spawnSync(process.execPath, [scriptPath], {
            encoding: "utf8",
            timeout: 15000,
            env: {
                ...process.env,
                REEVA_BASE_URL: `http://127.0.0.1:${address.port}`,
                REEVA_TEST_PLATFORM: "youtube",
                REEVA_TEST_VIDEO_URL: "https://www.youtube.com/watch?v=authorized-test-fixture",
                REEVA_TEST_MAX_BYTES: String(maxBytes)
            }
        });

        return {
            status: result.status,
            signal: result.signal,
            error: result.error,
            stdout: result.stdout || "",
            stderr: result.stderr || ""
        };
    } finally {
        await new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        });
    }
}

function makeMp4Fixture(size = 2048) {
    const bytes = Buffer.alloc(size);
    bytes.write("ftyp", 4, "ascii");
    bytes.write("isom", 8, "ascii");
    return bytes;
}

test("live-video smoke harness passes for a valid MP4 container over the HTTP pipeline", async () => {
    const result = await runAgainstMockReeva({
        body: makeMp4Fixture(),
        contentType: "video/mp4"
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS: Reeva returned a non-empty video artifact/);
    assert.match(result.stdout, /Bytes downloaded: 2048/);
});

test("live-video smoke harness rejects an HTML challenge response", async () => {
    const result = await runAgainstMockReeva({
        body: Buffer.from("<!doctype html><title>Verify you are human</title>"),
        contentType: "text/html"
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected video, received Content-Type: text\/html/);
});

test("live-video smoke harness enforces its configured download byte ceiling", async () => {
    const result = await runAgainstMockReeva({
        body: makeMp4Fixture(2048),
        contentType: "video/mp4",
        maxBytes: 1024
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeded limit of 1024 bytes/);
});
