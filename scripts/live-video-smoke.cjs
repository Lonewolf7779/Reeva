#!/usr/bin/env node
"use strict";

/**
 * Live end-to-end video smoke test for a running Reeva instance.
 *
 * Required:
 *   REEVA_BASE_URL=http://127.0.0.1:3000
 *   REEVA_TEST_VIDEO_URL=<public video URL you are authorized to access>
 * Optional:
 *   REEVA_TEST_PLATFORM=youtube (default: youtube)
 *   REEVA_TEST_MAX_BYTES=104857600 (default: 100 MiB)
 *
 * This deliberately tests the actual HTTP pipeline, not mocked adapters:
 * source URL -> /api/download/:platform -> /api/media/:id?download=1.
 * It fails if Reeva returns an image, JSON error, HTML challenge page, or empty file.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const BASE_URL = (process.env.REEVA_BASE_URL || "").trim().replace(/\/+$/, "");
const SOURCE_URL = (process.env.REEVA_TEST_VIDEO_URL || "").trim();
const PLATFORM = (process.env.REEVA_TEST_PLATFORM || "youtube").trim().toLowerCase();
const MAX_BYTES = Number.parseInt(process.env.REEVA_TEST_MAX_BYTES || String(100 * 1024 * 1024), 10);
const TIMEOUT_MS = 6 * 60 * 1000;

function fail(message) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
}

function isVideoSignature(buffer) {
    if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") return true; // MP4
    if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return true; // WebM/Matroska
    if (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "FLV") return true;
    if (buffer.length >= 4 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer.toString("ascii", 8, 12) === "AVI ") return true;
    return false;
}

async function main() {
    if (!BASE_URL || !SOURCE_URL) {
        throw new Error("Set REEVA_BASE_URL and REEVA_TEST_VIDEO_URL. Use a public video URL you are authorized to access.");
    }
    if (!/^https?:\/\//i.test(BASE_URL) || !/^https?:\/\//i.test(SOURCE_URL)) {
        throw new Error("Both REEVA_BASE_URL and REEVA_TEST_VIDEO_URL must be HTTP(S) URLs.");
    }
    if (!Number.isSafeInteger(MAX_BYTES) || MAX_BYTES < 1024) {
        throw new Error("REEVA_TEST_MAX_BYTES must be an integer of at least 1024.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    let tempFile;

    try {
        console.log(`[1/4] Checking Reeva readiness at ${BASE_URL}/ready`);
        const ready = await fetch(`${BASE_URL}/ready`, { signal: controller.signal });
        if (!ready.ok) throw new Error(`Reeva is not ready: HTTP ${ready.status}`);
        console.log("[2/4] Requesting media extraction (live provider request)");
        const extractUrl = new URL(`/api/download/${encodeURIComponent(PLATFORM)}`, BASE_URL);
        extractUrl.searchParams.set("url", SOURCE_URL);
        const extractionResponse = await fetch(extractUrl, { signal: controller.signal });
        const extractionBody = await extractionResponse.json().catch(() => null);
        if (!extractionResponse.ok) {
            const code = extractionBody?.error?.code || "UNKNOWN";
            const message = extractionBody?.error?.message || "No structured error returned";
            throw new Error(`Extraction failed: HTTP ${extractionResponse.status} ${code}: ${message}`);
        }
        const streamPath = extractionBody?.downloadUrl || extractionBody?.streamUrl;
        if (typeof streamPath !== "string" || !streamPath.startsWith("/api/media/")) {
            throw new Error("Extraction response did not contain a valid Reeva media URL.");
        }

        console.log("[3/4] Downloading the resulting media through Reeva");
        const mediaUrl = new URL(streamPath, BASE_URL);
        if (mediaUrl.origin !== new URL(BASE_URL).origin) {
            throw new Error("Reeva returned a media URL on a different origin.");
        }
        mediaUrl.searchParams.set("download", "1");
        const mediaResponse = await fetch(mediaUrl, { signal: controller.signal });
        if (!mediaResponse.ok || !mediaResponse.body) {
            throw new Error(`Media download failed: HTTP ${mediaResponse.status}`);
        }
        const contentType = (mediaResponse.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("image/") || contentType.includes("text/html") || contentType.includes("application/json")) {
            throw new Error(`Expected video, received Content-Type: ${contentType || "(missing)"}`);
        }

        tempFile = path.join(os.tmpdir(), `reeva-live-video-smoke-${process.pid}-${Date.now()}.bin`);
        let bytes = 0;
        const limiter = new (require("node:stream").Transform)({
            transform(chunk, encoding, callback) {
                bytes += chunk.length;
                if (bytes > MAX_BYTES) return callback(new Error(`Downloaded media exceeded limit of ${MAX_BYTES} bytes`));
                callback(null, chunk);
            }
        });
        await pipeline(Readable.fromWeb(mediaResponse.body), limiter, fs.createWriteStream(tempFile, { flags: "wx" }));
        if (bytes < 1024) throw new Error(`Downloaded media is suspiciously small (${bytes} bytes)`);

        console.log("[4/4] Verifying the downloaded artifact is a video container");
        const handle = await fs.promises.open(tempFile, "r");
        let header;
        try {
            header = Buffer.alloc(16);
            const result = await handle.read(header, 0, header.length, 0);
            header = header.subarray(0, result.bytesRead);
        } finally {
            await handle.close();
        }
        if (!isVideoSignature(header)) {
            throw new Error(`Downloaded artifact is not a recognized MP4/WebM/FLV/AVI video container (Content-Type: ${contentType || "unknown"}; bytes: ${bytes}).`);
        }

        console.log("PASS: Reeva returned a non-empty video artifact through the real HTTP pipeline.");
        console.log(`Platform: ${PLATFORM}`);
        console.log(`Content-Type: ${contentType || "unknown"}`);
        console.log(`Bytes downloaded: ${bytes}`);
        console.log("Note: this verifies the media container signature, not full playback or every codec.");
    } finally {
        clearTimeout(timer);
        if (tempFile) await fs.promises.unlink(tempFile).catch(() => {});
    }
}

main().catch((error) => {
    fail(error?.name === "AbortError" ? `Timed out after ${TIMEOUT_MS}ms` : (error?.message || "Unknown failure"));
});
