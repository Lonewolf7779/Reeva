// lib/media-processor/multipart-upload.cjs — Zero-Dependency Streaming Multipart Media Uploader
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
    MEDIA_PROCESSOR_ERROR_CODES,
    MediaProcessingError,
    DEFAULT_MAX_INPUT_BYTES,
    resolveTempRootDir,
    validateContainedPath,
    safeUnlink,
    probeMediaFile
} = require("./ffmpeg-runner.cjs");

const MAX_FIELD_BYTES = 16 * 1024; // 16 KB max for non-file metadata fields
const MAX_HEADER_BYTES = 8 * 1024; // 8 KB max per part header
const DEFAULT_UPLOAD_IDLE_TIMEOUT_MS = 30 * 1000; // 30s inactivity timeout (Slowloris defense)
const DEFAULT_UPLOAD_TOTAL_TIMEOUT_MS = 120 * 1000; // 2m total upload timeout
const FORBIDDEN_FIELD_NAMES = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));
const SUPPORTED_CONTAINER_SUBSTRINGS = Object.freeze([
    "mp4",
    "mov",
    "m4a",
    "3gp",
    "matroska",
    "webm",
    "avi",
    "mp3",
    "ogg",
    "opus",
    "wav",
    "flac"
]);

/**
 * Extracts and validates the multipart boundary from Content-Type.
 *
 * @param {string|undefined} contentType
 * @returns {string}
 */
function parseMultipartBoundary(contentType) {
    if (!contentType || typeof contentType !== "string") {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
            "Content-Type must be multipart/form-data.",
            { statusCode: 400 }
        );
    }

    const lower = contentType.toLowerCase();
    if (!lower.includes("multipart/form-data")) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
            "Content-Type must be multipart/form-data.",
            { statusCode: 400 }
        );
    }

    const match = contentType.match(/;\s*boundary=(?:"([^"]{1,128})"|([^\s;]{1,128}))/i);
    const boundary = match && (match[1] || match[2]);
    if (!boundary || /[\r\n\0]/.test(boundary)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
            "Missing or malformed multipart boundary.",
            { statusCode: 400 }
        );
    }

    return boundary;
}

/**
 * Parses Content-Disposition header for field name (never trusts filename).
 *
 * @param {string} headerBlock
 * @returns {{ name: string|null, isFile: boolean }}
 */
function parsePartHeaders(headerBlock) {
    const lines = headerBlock.split("\r\n");
    let fieldName = null;
    let isFile = false;
    let dispositionCount = 0;

    for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        if (key === "content-disposition") {
            dispositionCount += 1;
            if (dispositionCount > 1) {
                throw new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                    "Duplicate Content-Disposition headers are not permitted.",
                    { statusCode: 400 }
                );
            }
            const nameMatch = val.match(/;\s*name="([^"]{1,64})"/i);
            if (nameMatch) {
                fieldName = nameMatch[1];
            }
            if (/;\s*filename=/i.test(val)) {
                isFile = true;
            }
        }
    }

    if (fieldName && FORBIDDEN_FIELD_NAMES.has(fieldName)) {
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
            "Forbidden multipart field name.",
            { statusCode: 400 }
        );
    }

    return { name: fieldName, isFile };
}

/**
 * Checks leading magic bytes of an uploaded file against common audio/video containers.
 * Never trusts client-supplied MIME types or file extensions.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function hasSupportedMediaSignature(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(16);
        const bytesRead = fs.readSync(fd, buf, 0, 16, 0);
        if (bytesRead < 4) return false;

        // ISO BMFF (MP4 / MOV / M4A / 3GP): "ftyp" at offset 4
        if (bytesRead >= 8 && buf.subarray(4, 8).toString("ascii") === "ftyp") return true;
        // EBML (WebM / MKV): 1A 45 DF A3
        if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
        // RIFF (WAV / AVI)
        if (buf.subarray(0, 4).toString("ascii") === "RIFF") return true;
        // Ogg / Opus
        if (buf.subarray(0, 4).toString("ascii") === "OggS") return true;
        // FLAC
        if (buf.subarray(0, 4).toString("ascii") === "fLaC") return true;
        // MP3 with ID3 tag
        if (buf.subarray(0, 3).toString("ascii") === "ID3") return true;
        // MP3 raw MPEG frame sync (0xFF 0xE0 mask)
        if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;

        return false;
    } catch (_) {
        return false;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
        }
    }
}

/**
 * Streams a single multipart/form-data media upload directly to REEVA_TEMP_DIR
 * without buffering the file in memory, enforcing strict byte caps and ffprobe validation.
 *
 * @param {import("http").IncomingMessage} req
 * @param {object} [options={}]
 * @returns {Promise<{ uploadPath: string, sizeBytes: number, fields: Record<string, string>, probe: object }>}
 */
async function receiveStreamingMediaUpload(req, options = {}) {
    const boundary = parseMultipartBoundary(req.headers["content-type"]);
    const maxUploadBytes = options.maxUploadBytes || DEFAULT_MAX_INPUT_BYTES;
    const baseDir = resolveTempRootDir(options.baseDir);

    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    }

    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader !== undefined) {
        const declaredLen = Number(contentLengthHeader);
        if (Number.isFinite(declaredLen) && declaredLen > maxUploadBytes + 64 * 1024) {
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INPUT_TOO_LARGE,
                "Uploaded media exceeds maximum permitted size.",
                { statusCode: 413 }
            );
        }
    }

    const uploadFileName = `upl_${crypto.randomBytes(16).toString("hex")}.bin`;
    const uploadPath = validateContainedPath(uploadFileName, baseDir, { mustExist: false });

    const fields = Object.create(null);
    let fileWriteStream = null;
    let fileBytesWritten = 0;
    let totalFieldBytes = 0;
    let fileCount = 0;

    const idleTimeoutMs = options.uploadIdleTimeoutMs || DEFAULT_UPLOAD_IDLE_TIMEOUT_MS;
    const totalTimeoutMs = options.uploadTimeoutMs || DEFAULT_UPLOAD_TOTAL_TIMEOUT_MS;

    const firstBoundary = Buffer.from(`--${boundary}`);
    const nextBoundary = Buffer.from(`\r\n--${boundary}`);
    const headerSep = Buffer.from("\r\n\r\n");

    await new Promise((resolve, reject) => {
        let settled = false;
        let state = "PREAMBLE"; // PREAMBLE -> PART_HEADERS -> PART_BODY_FILE -> PART_BODY_FIELD -> DONE
        let buffer = Buffer.alloc(0);
        let currentPart = null;
        let currentFieldChunks = [];
        let fileStreamClosed = true;
        let idleTimer = null;
        let totalTimer = null;

        const clearUploadTimers = () => {
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
        };

        const fail = async (err) => {
            if (settled) return;
            settled = true;
            clearUploadTimers();
            req.unpipe?.();
            req.pause();
            if (fileWriteStream && !fileStreamClosed) {
                await new Promise((resClose) => {
                    fileWriteStream.once("close", resClose);
                    try { fileWriteStream.destroy(); } catch (_) { resClose(); }
                });
            }
            await safeUnlink(uploadPath);
            reject(err);
        };

        const resetIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                fail(new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.EXECUTION_TIMEOUT,
                    "Media upload stalled and timed out.",
                    { statusCode: 408 }
                ));
            }, idleTimeoutMs);
        };

        resetIdleTimer();
        totalTimer = setTimeout(() => {
            fail(new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.EXECUTION_TIMEOUT,
                "Media upload exceeded maximum allowed duration.",
                { statusCode: 408 }
            ));
        }, totalTimeoutMs);

        const finishIfReady = () => {
            if (settled) return;
            if (state === "DONE" && fileStreamClosed) {
                settled = true;
                clearUploadTimers();
                resolve();
            }
        };

        const openFileStream = () => {
            fileStreamClosed = false;
            fileWriteStream = fs.createWriteStream(uploadPath, { flags: "wx", mode: 0o600 });
            fileWriteStream.on("error", () => {
                fail(new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.STORAGE_ERROR,
                    "Failed to store uploaded media.",
                    { statusCode: 500 }
                ));
            });
            fileWriteStream.on("close", () => {
                fileStreamClosed = true;
                finishIfReady();
            });
        };

        const writeFileChunk = (chunk) => {
            if (!chunk || chunk.length === 0) return;
            fileBytesWritten += chunk.length;
            if (fileBytesWritten > maxUploadBytes) {
                throw new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.INPUT_TOO_LARGE,
                    "Uploaded media exceeds maximum permitted size.",
                    { statusCode: 413 }
                );
            }
            if (!fileWriteStream.write(chunk)) {
                req.pause();
                fileWriteStream.once("drain", () => {
                    if (!settled) req.resume();
                });
            }
        };

        const processBuffer = () => {
            while (!settled) {
                if (state === "PREAMBLE") {
                    const idx = buffer.indexOf(firstBoundary);
                    if (idx === -1) {
                        if (buffer.length > MAX_HEADER_BYTES) {
                            throw new MediaProcessingError(
                                MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                                "Malformed multipart request preamble.",
                                { statusCode: 400 }
                            );
                        }
                        break;
                    }
                    const after = buffer.subarray(idx + firstBoundary.length);
                    if (after.length < 2) break;
                    if (after[0] === 0x2d && after[1] === 0x2d) {
                        state = "DONE";
                        buffer = Buffer.alloc(0);
                        break;
                    }
                    if (after[0] !== 0x0d || after[1] !== 0x0a) {
                        throw new MediaProcessingError(
                            MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                            "Malformed multipart boundary delimiter.",
                            { statusCode: 400 }
                        );
                    }
                    buffer = after.subarray(2);
                    state = "PART_HEADERS";
                } else if (state === "PART_HEADERS") {
                    const sepIdx = buffer.indexOf(headerSep);
                    if (sepIdx === -1) {
                        if (buffer.length > MAX_HEADER_BYTES) {
                            throw new MediaProcessingError(
                                MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                                "Multipart part headers exceeded maximum size.",
                                { statusCode: 400 }
                            );
                        }
                        break;
                    }
                    const headerText = buffer.subarray(0, sepIdx).toString("utf8");
                    currentPart = parsePartHeaders(headerText);
                    buffer = buffer.subarray(sepIdx + headerSep.length);

                    if (!currentPart.name) {
                        throw new MediaProcessingError(
                            MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                            "Multipart part is missing a valid field name.",
                            { statusCode: 400 }
                        );
                    }

                    if (currentPart.isFile) {
                        fileCount += 1;
                        if (fileCount > 1) {
                            throw new MediaProcessingError(
                                MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                                "Only one media file per upload request is permitted.",
                                { statusCode: 400 }
                            );
                        }
                        openFileStream();
                        state = "PART_BODY_FILE";
                    } else {
                        currentFieldChunks = [];
                        state = "PART_BODY_FIELD";
                    }
                } else if (state === "PART_BODY_FILE" || state === "PART_BODY_FIELD") {
                    const bIdx = buffer.indexOf(nextBoundary);
                    if (bIdx === -1) {
                        // Keep tail bytes that could match a partial boundary across chunks
                        const safeLen = Math.max(0, buffer.length - (nextBoundary.length + 2));
                        if (safeLen === 0) break;

                        const safeSlice = buffer.subarray(0, safeLen);
                        buffer = buffer.subarray(safeLen);

                        if (state === "PART_BODY_FILE") {
                            writeFileChunk(safeSlice);
                        } else {
                            totalFieldBytes += safeSlice.length;
                            if (totalFieldBytes > MAX_FIELD_BYTES) {
                                throw new MediaProcessingError(
                                    MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                                    "Metadata fields exceeded maximum permitted size.",
                                    { statusCode: 400 }
                                );
                            }
                            currentFieldChunks.push(safeSlice);
                        }
                        break;
                    }

                    const bodyTail = buffer.subarray(0, bIdx);
                    const afterBoundary = buffer.subarray(bIdx + nextBoundary.length);
                    if (afterBoundary.length < 2) {
                        // Wait for '--' or '\r\n' right after boundary
                        break;
                    }

                    if (state === "PART_BODY_FILE") {
                        writeFileChunk(bodyTail);
                        fileWriteStream.end();
                    } else {
                        totalFieldBytes += bodyTail.length;
                        if (totalFieldBytes > MAX_FIELD_BYTES) {
                            throw new MediaProcessingError(
                                MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                                "Metadata fields exceeded maximum permitted size.",
                                { statusCode: 400 }
                            );
                        }
                        currentFieldChunks.push(bodyTail);
                        if (Object.prototype.hasOwnProperty.call(fields, currentPart.name)) {
                            throw new MediaProcessingError(
                                MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                                "Duplicate multipart field names are not permitted.",
                                { statusCode: 400 }
                            );
                        }
                        fields[currentPart.name] = Buffer.concat(currentFieldChunks).toString("utf8");
                    }

                    if (afterBoundary[0] === 0x2d && afterBoundary[1] === 0x2d) {
                        state = "DONE";
                        buffer = Buffer.alloc(0);
                        break;
                    }
                    if (afterBoundary[0] !== 0x0d || afterBoundary[1] !== 0x0a) {
                        throw new MediaProcessingError(
                            MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                            "Malformed closing multipart boundary.",
                            { statusCode: 400 }
                        );
                    }
                    buffer = afterBoundary.subarray(2);
                    state = "PART_HEADERS";
                } else {
                    buffer = Buffer.alloc(0);
                    break;
                }
            }
        };

        req.on("data", (chunk) => {
            if (settled) return;
            resetIdleTimer();
            try {
                buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
                processBuffer();
            } catch (err) {
                fail(err);
            }
        });

        req.on("end", () => {
            if (settled) return;
            try {
                processBuffer();
                if (state !== "DONE" || fileCount !== 1) {
                    return fail(new MediaProcessingError(
                        MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                        fileCount === 0 ? "Upload request must include a media file." : "Incomplete or malformed multipart upload.",
                        { statusCode: 400 }
                    ));
                }
                finishIfReady();
            } catch (err) {
                fail(err);
            }
        });

        req.on("aborted", () => {
            fail(new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.PROCESS_ABORTED,
                "Media upload was aborted by client.",
                { statusCode: 499 }
            ));
        });

        req.on("close", () => {
            if (!settled && state !== "DONE") {
                fail(new MediaProcessingError(
                    MEDIA_PROCESSOR_ERROR_CODES.PROCESS_ABORTED,
                    "Media upload connection closed before completion.",
                    { statusCode: 499 }
                ));
            }
        });

        req.on("error", () => {
            fail(new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
                "Failed to read upload stream.",
                { statusCode: 400 }
            ));
        });
    });

    if (fileBytesWritten === 0) {
        await safeUnlink(uploadPath);
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS,
            "Uploaded media file is empty.",
            { statusCode: 400 }
        );
    }

    // Never trust client MIME or filename: verify magic signature + ffprobe streams
    if (!options.skipSignatureCheck && !hasSupportedMediaSignature(uploadPath)) {
        await safeUnlink(uploadPath);
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
            "Uploaded file is not a supported media format.",
            { statusCode: 415 }
        );
    }

    try {
        const probe = await probeMediaFile(uploadPath, {
            baseDir,
            ffprobePath: options.ffprobePath || null,
            maxInputBytes: maxUploadBytes,
            skipExistsCheck: options.skipExistsCheck,
            spawnFn: options.spawnFn
        });

        const streams = Array.isArray(probe.streams) ? probe.streams : [];
        const hasMediaStream = streams.some((s) => s && (s.codec_type === "video" || s.codec_type === "audio"));
        const formatName = String(probe?.format?.format_name || "").toLowerCase();
        const hasSupportedFormat = SUPPORTED_CONTAINER_SUBSTRINGS.some((sub) => formatName.includes(sub));

        if (!hasMediaStream || !hasSupportedFormat) {
            await safeUnlink(uploadPath);
            throw new MediaProcessingError(
                MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE,
                "Uploaded file does not contain a valid supported audio or video stream.",
                { statusCode: 415 }
            );
        }

        return {
            uploadPath,
            sizeBytes: fileBytesWritten,
            fields,
            probe
        };
    } catch (err) {
        await safeUnlink(uploadPath);
        if (err instanceof MediaProcessingError) throw err;
        throw new MediaProcessingError(
            MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED,
            "Uploaded media failed validation.",
            { statusCode: 415 }
        );
    }
}

module.exports = {
    MAX_FIELD_BYTES,
    SUPPORTED_CONTAINER_SUBSTRINGS,
    parseMultipartBoundary,
    parsePartHeaders,
    hasSupportedMediaSignature,
    receiveStreamingMediaUpload
};
