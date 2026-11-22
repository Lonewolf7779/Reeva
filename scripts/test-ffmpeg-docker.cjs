// scripts/test-ffmpeg-docker.cjs — Real FFmpeg & ffprobe Integration Tests (Linux Docker)
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
    MEDIA_PROCESSOR_ERROR_CODES,
    executeBinary,
    probeMediaFile,
    processMedia,
    createProcessingLimiter,
    safeUnlink
} = require("../lib/media-processor/ffmpeg-runner.cjs");

async function runRealDockerIntegrationTests() {
    const baseDir = process.env.REEVA_TEMP_DIR || "/var/reeva/media";
    const runId = crypto.randomBytes(6).toString("hex");
    const inputPath = path.join(baseDir, `synth_input_${runId}.mp4`);
    const corruptPath = path.join(baseDir, `corrupt_${runId}.mp4`);
    const generatedOutputs = [];

    console.log(`Starting real FFmpeg integration tests in '${baseDir}' (runId=${runId})...`);

    try {
        // 1. Generate synthetic 3s 640x360 H.264 + AAC test video
        await executeBinary({
            binary: "ffmpeg",
            timeoutMs: 30000,
            args: [
                "-y",
                "-f", "lavfi", "-i", "testsrc=duration=3:size=640x360:rate=24",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k",
                "-shortest",
                inputPath
            ]
        });

        const inputProbe = await probeMediaFile(inputPath, { baseDir });
        assert.ok(parseFloat(inputProbe.format.duration) >= 2.5, "Synthetic input should be ~3s");

        // 2. Test Video Compression
        const compressed = await processMedia(
            { inputPath, profile: { operation: "compress", options: { preset: "compact" } } },
            { baseDir }
        );
        generatedOutputs.push(compressed.outputPath);
        const compProbe = await probeMediaFile(compressed.outputPath, { baseDir });
        assert.ok(compProbe.format.format_name.includes("mp4"));
        assert.equal(compProbe.streams.find((s) => s.codec_type === "video").codec_name, "h264");
        console.log(`PASS [1/5] compress: ${compressed.outputSizeBytes} bytes`);

        // 3. Test Video Conversion (WebM VP9 + Opus)
        const converted = await processMedia(
            { inputPath, profile: { operation: "convert", options: { format: "webm" } } },
            { baseDir }
        );
        generatedOutputs.push(converted.outputPath);
        const convProbe = await probeMediaFile(converted.outputPath, { baseDir });
        assert.ok(convProbe.format.format_name.includes("webm"));
        assert.equal(convProbe.streams.find((s) => s.codec_type === "video").codec_name, "vp9");
        assert.equal(convProbe.streams.find((s) => s.codec_type === "audio").codec_name, "opus");
        console.log(`PASS [2/5] convert (webm): ${converted.outputSizeBytes} bytes`);

        // 4. Test Audio Extraction (MP3)
        const audio = await processMedia(
            { inputPath, profile: { operation: "extract_audio", options: { format: "mp3", bitrate: "128k" } } },
            { baseDir }
        );
        generatedOutputs.push(audio.outputPath);
        const audioProbe = await probeMediaFile(audio.outputPath, { baseDir });
        assert.equal(audioProbe.streams.filter((s) => s.codec_type === "video").length, 0);
        assert.equal(audioProbe.streams.find((s) => s.codec_type === "audio").codec_name, "mp3");
        console.log(`PASS [3/5] extract_audio (mp3): ${audio.outputSizeBytes} bytes`);

        // 5. Test Video Trimming (0.5s -> 2.0s = ~1.5s)
        const trimmed = await processMedia(
            { inputPath, profile: { operation: "trim", options: { startSeconds: 0.5, endSeconds: 2.0, mode: "accurate" } } },
            { baseDir }
        );
        generatedOutputs.push(trimmed.outputPath);
        const trimProbe = await probeMediaFile(trimmed.outputPath, { baseDir });
        const trimDur = parseFloat(trimProbe.format.duration);
        assert.ok(trimDur >= 1.2 && trimDur <= 1.8, `Expected ~1.5s trimmed duration, got ${trimDur}`);
        console.log(`PASS [4/5] trim: duration=${trimDur}s`);

        // 6. Test Video Resizing (portrait 1080x1920)
        const resized = await processMedia(
            { inputPath, profile: { operation: "resize", options: { preset: "portrait_1080x1920", fit: "contain" } } },
            { baseDir }
        );
        generatedOutputs.push(resized.outputPath);
        const resizeProbe = await probeMediaFile(resized.outputPath, { baseDir });
        const videoStream = resizeProbe.streams.find((s) => s.codec_type === "video");
        assert.equal(videoStream.width, 1080);
        assert.equal(videoStream.height, 1920);
        console.log(`PASS [5/5] resize: ${videoStream.width}x${videoStream.height}`);

        // 7. Test Corrupted Input Rejection & Cleanup
        fs.writeFileSync(corruptPath, crypto.randomBytes(512));
        const corruptOutName = `corrupt_out_${runId}.mp4`;
        await assert.rejects(
            () => processMedia(
                { inputPath: corruptPath, outputFileName: corruptOutName, profile: { operation: "compress" } },
                { baseDir }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED
        );
        assert.equal(fs.existsSync(path.join(baseDir, corruptOutName)), false);
        console.log("PASS [6/7] corrupted input rejected and partial output cleaned up");

        // 8. Test Real Process Cancellation & Concurrency Slot Release
        const limiter = createProcessingLimiter(1);
        const controller = new AbortController();
        const cancelOutName = `cancel_out_${runId}.mp4`;
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(
            () => processMedia(
                { inputPath, outputFileName: cancelOutName, profile: { operation: "convert", options: { format: "webm" } } },
                { baseDir, limiter, signal: controller.signal }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.PROCESS_ABORTED
        );
        assert.equal(fs.existsSync(path.join(baseDir, cancelOutName)), false);
        assert.equal(limiter.getActiveCount(), 0);
        console.log("PASS [7/7] real FFmpeg cancellation cleaned up file and released slot");

        console.log("ALL REAL FFMPEG DOCKER INTEGRATION TESTS PASSED (7/7).");
    } finally {
        await safeUnlink(inputPath);
        await safeUnlink(corruptPath);
        for (const p of generatedOutputs) {
            await safeUnlink(p);
        }
    }
}

runRealDockerIntegrationTests().catch((err) => {
    console.error("REAL FFMPEG DOCKER INTEGRATION TEST FAILED:", err);
    process.exit(1);
});
