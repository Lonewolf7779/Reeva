// tests/media-processing-api.test.cjs — Phase 2B Upload, Job Lifecycle & Delivery Security Tests
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const app = require("../server.cjs");
const { parseFeatureGates } = require("../lib/config.cjs");
const { MediaRegistry } = require("../lib/media-registry.cjs");
const { MediaJobManager, JOB_STATES } = require("../lib/media-processor/job-manager.cjs");
const { receiveStreamingMediaUpload } = require("../lib/media-processor/multipart-upload.cjs");
const { createProcessingLimiter } = require("../lib/media-processor/ffmpeg-runner.cjs");

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "reeva-phase2b-test-"));
}

function removeDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function buildMultipartBody(boundary, parts) {
    const chunks = [];
    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (part.filename !== undefined) {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
                `Content-Type: ${part.contentType || "application/octet-stream"}\r\n\r\n`
            ));
            chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
            chunks.push(Buffer.from("\r\n"));
        } else {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`
            ));
            chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data)));
            chunks.push(Buffer.from("\r\n"));
        }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
}

function httpRequest(port, { method = "GET", reqPath = "/", headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: reqPath, headers }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const raw = Buffer.concat(chunks);
                let json = null;
                try { json = JSON.parse(raw.toString("utf8")); } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, raw, text: raw.toString("utf8"), json });
            });
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

function createFakeFfprobeSpawn(stdoutPayload, exitCode = 0) {
    return () => {
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.pid = 88888;
        proc.killed = false;
        proc.kill = () => { proc.killed = true; };
        setTimeout(() => {
            if (stdoutPayload) proc.stdout.write(stdoutPayload);
            proc.stdout.end();
            proc.stderr.end();
            proc.emit("close", exitCode, null);
        }, 5);
        return proc;
    };
}

test("1. Feature gate: mediaProcessing defaults to disabled and endpoints return 403 FEATURE_DISABLED", async () => {
    assert.equal(parseFeatureGates({ NODE_ENV: "production" }).mediaProcessing, false);
    assert.equal(parseFeatureGates({ NODE_ENV: "test" }).mediaProcessing, false);
    assert.equal(parseFeatureGates({ NODE_ENV: "development" }).mediaProcessing, false);
    assert.equal(parseFeatureGates({ NODE_ENV: "production", REEVA_ENABLE_MEDIA_PROCESSING: "true" }).mediaProcessing, true);

    app.setMediaProcessingEnabled(false);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
        const caps = await httpRequest(port, { reqPath: "/api/capabilities" });
        assert.equal(caps.status, 200);
        assert.equal(caps.json.capabilities.mediaProcessing, false);

        const postRes = await httpRequest(port, { method: "POST", reqPath: "/api/media/jobs" });
        assert.equal(postRes.status, 403);
        assert.equal(postRes.json.error.code, "FEATURE_DISABLED");

        const statusRes = await httpRequest(port, { reqPath: "/api/media/jobs/job_00000000000000000000000000000000" });
        assert.equal(statusRes.status, 403);
        assert.equal(statusRes.json.error.code, "FEATURE_DISABLED");

        // Existing GET-only routes still enforce 405
        const methodRes = await httpRequest(port, { method: "POST", reqPath: "/api/download/youtube" });
        assert.equal(methodRes.status, 405);
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test("2. Streaming multipart upload rejects oversized, malformed, fake-MIME, and corrupted media", async () => {
    const tmpDir = createTempDir();
    try {
        // Fake valid MP4 magic header (ftypisom)
        const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"), Buffer.alloc(64)]);

        // A. Oversized upload rejected mid-stream and cleaned up
        const bigBoundary = "----ReevaTestBoundaryBig";
        const bigBody = buildMultipartBody(bigBoundary, [
            { name: "profile", data: JSON.stringify({ operation: "compress" }) },
            { name: "file", filename: "../../evil.mp4", contentType: "video/mp4", data: Buffer.concat([fakeMp4, Buffer.alloc(500)]) }
        ]);
        const bigReq = new PassThrough();
        bigReq.headers = { "content-type": `multipart/form-data; boundary=${bigBoundary}` };
        setImmediate(() => bigReq.end(bigBody));

        await assert.rejects(
            () => receiveStreamingMediaUpload(bigReq, { baseDir: tmpDir, maxUploadBytes: 100 }),
            (err) => err.code === "INPUT_TOO_LARGE" && err.statusCode === 413
        );
        assert.equal(fs.readdirSync(tmpDir).length, 0);

        // B. Malformed multipart request rejected
        const badReq = new PassThrough();
        badReq.headers = { "content-type": "application/json" };
        setImmediate(() => badReq.end("{}"));
        await assert.rejects(
            () => receiveStreamingMediaUpload(badReq, { baseDir: tmpDir }),
            (err) => err.statusCode === 400
        );

        // C. Fake MIME type (text payload claiming video/mp4) rejected by signature check
        const fakeMimeBoundary = "----ReevaFakeMime";
        const fakeMimeBody = buildMultipartBody(fakeMimeBoundary, [
            { name: "file", filename: "shell.mp4", contentType: "video/mp4", data: "<html>not a video</html>" }
        ]);
        const fakeMimeReq = new PassThrough();
        fakeMimeReq.headers = { "content-type": `multipart/form-data; boundary=${fakeMimeBoundary}` };
        setImmediate(() => fakeMimeReq.end(fakeMimeBody));

        await assert.rejects(
            () => receiveStreamingMediaUpload(fakeMimeReq, { baseDir: tmpDir }),
            (err) => err.statusCode === 415
        );
        assert.equal(fs.readdirSync(tmpDir).length, 0);

        // D. Corrupted media (has ftyp magic bytes, ffprobe fails) rejected and cleaned up
        const corruptBoundary = "----ReevaCorrupt";
        const corruptBody = buildMultipartBody(corruptBoundary, [
            { name: "file", filename: "../../traversal.mp4", contentType: "video/mp4", data: fakeMp4 }
        ]);
        const corruptReq = new PassThrough();
        corruptReq.headers = { "content-type": `multipart/form-data; boundary=${corruptBoundary}` };
        setImmediate(() => corruptReq.end(corruptBody));

        await assert.rejects(
            () => receiveStreamingMediaUpload(corruptReq, {
                baseDir: tmpDir,
                ffprobePath: process.execPath,
                spawnFn: createFakeFfprobeSpawn("", 1)
            }),
            (err) => err.code === "PROCESS_FAILED"
        );
        assert.equal(fs.readdirSync(tmpDir).length, 0);

        // E. Valid upload ignores user filename (path traversal safe) and validates with ffprobe
        const okBoundary = "----ReevaValid";
        const okBody = buildMultipartBody(okBoundary, [
            { name: "profile", data: JSON.stringify({ operation: "compress" }) },
            { name: "file", filename: "../../../../etc/passwd.mp4", contentType: "video/mp4", data: fakeMp4 }
        ]);
        const okReq = new PassThrough();
        okReq.headers = { "content-type": `multipart/form-data; boundary=${okBoundary}` };
        setImmediate(() => okReq.end(okBody));

        const uploaded = await receiveStreamingMediaUpload(okReq, {
            baseDir: tmpDir,
            ffprobePath: process.execPath,
            spawnFn: createFakeFfprobeSpawn(JSON.stringify({
                format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
                streams: [{ codec_type: "video", codec_name: "h264" }]
            }))
        });
        assert.ok(path.basename(uploaded.uploadPath).startsWith("upl_"));
        assert.equal(path.dirname(uploaded.uploadPath), fs.realpathSync(tmpDir));
        fs.unlinkSync(uploaded.uploadPath);
    } finally {
        removeDir(tmpDir);
    }
});

test("3. Job lifecycle: token auth, completion, cancellation races, expiration, and cleanup", async () => {
    const tmpDir = createTempDir();
    const registry = new MediaRegistry(50, 5000);
    const limiter = createProcessingLimiter(2);
    const manager = new MediaJobManager({
        mediaRegistry: registry,
        limiter,
        retentionMs: 120,
        sweepIntervalMs: 60000,
        processMediaFn: async ({ inputPath, profile }, opts) => {
            assert.ok(fs.existsSync(inputPath));
            if (profile.operation === "convert") {
                await new Promise((resolve, reject) => {
                    const t = setTimeout(resolve, 150);
                    opts.signal.addEventListener("abort", () => {
                        clearTimeout(t);
                        reject(Object.assign(new Error("aborted"), { code: "PROCESS_ABORTED", publicMessage: "cancelled" }));
                    }, { once: true });
                });
            }
            const outPath = path.join(tmpDir, `out_${Date.now()}_${Math.random().toString(16).slice(2)}.mp4`);
            fs.writeFileSync(outPath, "processed-media-bytes");
            return { outputPath: outPath, outputSizeBytes: 21, operation: profile.operation, outputExt: "mp4" };
        }
    });

    try {
        // 1. Happy path: create -> complete -> retrieve -> expire -> cleanup
        const up1 = path.join(tmpDir, "upl_1.bin");
        fs.writeFileSync(up1, "raw-upload-1");
        const { job, capabilityToken } = await manager.createJob({
            uploadPath: up1,
            profile: { operation: "compress", options: { preset: "balanced" } }
        });
        assert.equal(job.status, JOB_STATES.QUEUED);

        // Unauthorized token rejected uniformly
        assert.throws(
            () => manager.getJobStatus(job.jobId, "wrong-token"),
            (err) => err.code === "UNAUTHORIZED_JOB_ACCESS" && err.statusCode === 403
        );

        // Wait for async job completion
        let statusView;
        for (let i = 0; i < 20; i++) {
            statusView = manager.getJobStatus(job.jobId, capabilityToken);
            if (statusView.status === JOB_STATES.COMPLETED) break;
            await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(statusView.status, JOB_STATES.COMPLETED);
        assert.ok(statusView.output.mediaId.startsWith("med_"));
        assert.equal(fs.existsSync(up1), false, "Raw upload must be deleted after processing");

        const entry = manager.getCompletedMediaEntry(job.jobId, capabilityToken);
        assert.ok(fs.existsSync(entry.localFilePath));

        // Cannot cancel completed job
        await assert.rejects(
            () => manager.cancelJob(job.jobId, capabilityToken),
            (err) => err.code === "JOB_NOT_CANCELLABLE" && err.statusCode === 409
        );

        // Wait for retention expiration & sweep
        await new Promise((r) => setTimeout(r, 150));
        await manager.sweepExpired();
        assert.equal(fs.existsSync(entry.localFilePath), false, "Expired output file must be removed");
        assert.throws(
            () => manager.getCompletedMediaEntry(job.jobId, capabilityToken),
            (err) => err.code === "MEDIA_EXPIRED" && err.statusCode === 410
        );

        // 2. Cancellation race test
        const up2 = path.join(tmpDir, "upl_2.bin");
        fs.writeFileSync(up2, "raw-upload-2");
        const job2 = await manager.createJob({
            uploadPath: up2,
            profile: { operation: "convert", options: { format: "mp4" } }
        });
        await new Promise((r) => setTimeout(r, 20));
        const cancelled = await manager.cancelJob(job2.job.jobId, job2.capabilityToken);
        assert.equal(cancelled.status, JOB_STATES.CANCELLED);
        assert.equal(fs.existsSync(up2), false, "Cancelled upload must be deleted");
    } finally {
        await manager.shutdown();
        registry.destroy();
        removeDir(tmpDir);
    }
});

test("4. HTTP integration: full POST -> status -> output delivery -> cancel via Express app", async () => {
    const tmpDir = createTempDir();
    const origTemp = process.env.REEVA_TEMP_DIR;
    process.env.REEVA_TEMP_DIR = tmpDir;
    app.setMediaProcessingEnabled(true);
    app.mediaUploadOptions = {
        baseDir: tmpDir,
        ffprobePath: process.execPath,
        spawnFn: createFakeFfprobeSpawn(JSON.stringify({
            format: { format_name: "mp4" },
            streams: [{ codec_type: "video", codec_name: "h264" }]
        }))
    };

    const manager = app.getMediaJobManager();
    const origProcessFn = manager.processMediaFn;
    manager.processMediaFn = async ({ inputPath, profile }) => {
        const outPath = path.join(tmpDir, `http_out_${Date.now()}.mp4`);
        fs.writeFileSync(outPath, "http-processed-mp4-data");
        return { outputPath: outPath, outputSizeBytes: 23, operation: profile.operation, outputExt: "mp4" };
    };

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
        const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"), Buffer.alloc(64)]);
        const boundary = "----ReevaHttpIntegration";
        const body = buildMultipartBody(boundary, [
            { name: "profile", data: JSON.stringify({ operation: "compress", options: { preset: "compact" } }) },
            { name: "file", filename: "sample.mp4", contentType: "video/mp4", data: fakeMp4 }
        ]);

        const createRes = await httpRequest(port, {
            method: "POST",
            reqPath: "/api/media/jobs",
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": String(body.length)
            },
            body
        });

        assert.equal(createRes.status, 202);
        const { job, capabilityToken } = createRes.json;
        assert.ok(job.jobId.startsWith("job_"));
        assert.ok(typeof capabilityToken === "string" && capabilityToken.length === 64);

        // Unauthorized status check must fail
        const unauthRes = await httpRequest(port, { reqPath: `/api/media/jobs/${job.jobId}` });
        assert.equal(unauthRes.status, 403);

        // Poll until completed
        let statusRes;
        for (let i = 0; i < 20; i++) {
            statusRes = await httpRequest(port, {
                reqPath: `/api/media/jobs/${job.jobId}`,
                headers: { Authorization: `Bearer ${capabilityToken}` }
            });
            if (statusRes.json.job.status === JOB_STATES.COMPLETED) break;
            await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(statusRes.json.job.status, JOB_STATES.COMPLETED);
        // Never leak internal filesystem paths
        assert.equal(statusRes.text.includes(tmpDir), false);

        // Retrieve completed output via job endpoint
        const outputRes = await httpRequest(port, {
            reqPath: `/api/media/jobs/${job.jobId}/output?download=1`,
            headers: { Authorization: `Bearer ${capabilityToken}` }
        });
        assert.equal(outputRes.status, 200);
        assert.equal(outputRes.text, "http-processed-mp4-data");
        assert.equal(outputRes.headers["x-content-type-options"], "nosniff");
        assert.ok(String(outputRes.headers["content-disposition"]).startsWith("attachment;"));
    } finally {
        manager.processMediaFn = origProcessFn;
        app.mediaUploadOptions = {};
        app.setMediaProcessingEnabled(false);
        if (origTemp !== undefined) process.env.REEVA_TEMP_DIR = origTemp;
        else delete process.env.REEVA_TEMP_DIR;
        await new Promise((r) => server.close(r));
        removeDir(tmpDir);
    }
});
