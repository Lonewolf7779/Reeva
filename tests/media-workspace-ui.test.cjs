// tests/media-workspace-ui.test.cjs — Phase 3 Media Workspace Frontend Tests
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const api = require("../public/js/api.js");
const { createWorkspaceController } = require("../public/js/workspace.js");

function createFakeElement(tag = "div", id = "") {
    const listeners = {};
    const attrs = {};
    const classes = new Set();
    return {
        tagName: tag.toUpperCase(),
        id,
        value: "",
        checked: false,
        disabled: false,
        files: [],
        textContent: "",
        href: "",
        download: "",
        rel: "",
        clicked: false,
        removed: false,
        classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            contains: (c) => classes.has(c)
        },
        setAttribute: (k, v) => { attrs[k] = String(v); },
        getAttribute: (k) => attrs[k] ?? null,
        addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
        dispatchEvent: (ev) => { (listeners[ev.type] || []).forEach((fn) => fn(ev)); },
        click: function () { this.clicked = true; },
        remove: function () { this.removed = true; }
    };
}

function createFakeDocument() {
    const ids = [
        "media-workspace", "workspace-availability", "workspace-form",
        "workspace-file", "workspace-file-meta", "workspace-operation",
        "workspace-compress-preset", "workspace-opt-compress",
        "workspace-convert-format", "workspace-convert-remux", "workspace-opt-convert",
        "workspace-audio-format", "workspace-audio-bitrate", "workspace-opt-audio",
        "workspace-trim-start", "workspace-trim-end", "workspace-trim-mode", "workspace-opt-trim",
        "workspace-resize-preset", "workspace-resize-fit", "workspace-opt-resize",
        "workspace-submit", "workspace-cancel", "workspace-download",
        "workspace-progress-wrap", "workspace-progress", "workspace-status"
    ];
    const map = {};
    for (const id of ids) map[id] = createFakeElement("div", id);
    map["workspace-operation"].value = "compress";
    map["workspace-compress-preset"].value = "balanced";

    const createdAnchors = [];
    return {
        elements: map,
        createdAnchors,
        body: {
            appendChild: (node) => createdAnchors.push(node)
        },
        getElementById: (id) => map[id] || null,
        createElement: (tag) => createFakeElement(tag)
    };
}

test("1. buildMediaProfile validates all 5 allowlisted operations and rejects invalid inputs", () => {
    assert.equal(api.buildMediaProfile("compress", { preset: "compact" }).ok, true);
    assert.equal(api.buildMediaProfile("convert", { format: "webm", remux: false }).ok, true);
    assert.equal(api.buildMediaProfile("extract_audio", { format: "mp3", bitrate: "192k" }).ok, true);
    assert.equal(api.buildMediaProfile("trim", { startSeconds: 1, endSeconds: 10, mode: "accurate" }).ok, true);
    assert.equal(api.buildMediaProfile("resize", { preset: "portrait_1080x1920", fit: "cover" }).ok, true);

    assert.equal(api.buildMediaProfile("unknown", {}).ok, false);
    assert.equal(api.buildMediaProfile("trim", { startSeconds: 10, endSeconds: 5 }).ok, false);
    assert.equal(api.buildMediaProfile("resize", { preset: "9999x9999" }).ok, false);
});

test("2. Feature disabled keeps workspace locked and blocks job submission", async () => {
    const doc = createFakeDocument();
    let fetchCalled = false;
    const ctrl = createWorkspaceController(doc, {
        api,
        fetchFn: async () => { fetchCalled = true; }
    });

    assert.equal(ctrl.getIsEnabled(), false);
    assert.equal(doc.elements["workspace-submit"].disabled, true);
    assert.ok(doc.elements["workspace-availability"].textContent.includes("disabled"));

    doc.elements["workspace-file"].files = [{ name: "a.mp4", size: 100 }];
    await ctrl.handleSubmit();
    assert.equal(fetchCalled, false);
});

test("3. Upload validation rejects missing, empty, and oversized files", async () => {
    const doc = createFakeDocument();
    let fetchCalled = false;
    const ctrl = createWorkspaceController(doc, {
        api,
        maxUploadBytes: 50,
        fetchFn: async () => { fetchCalled = true; }
    });
    ctrl.setAvailability(true, 50);

    // Missing file
    await ctrl.handleSubmit();
    assert.ok(doc.elements["workspace-status"].textContent.includes("choose"));

    // Empty file
    doc.elements["workspace-file"].files = [{ name: "empty.mp4", size: 0 }];
    await ctrl.handleSubmit();
    assert.ok(doc.elements["workspace-status"].textContent.includes("empty"));

    // Oversized file
    doc.elements["workspace-file"].files = [{ name: "big.mp4", size: 100 }];
    await ctrl.handleSubmit();
    assert.ok(doc.elements["workspace-status"].textContent.includes("exceeds"));
    assert.equal(fetchCalled, false);
});

test("4. Full lifecycle: submit -> status polling -> secure Blob download & objectURL revocation", async () => {
    const doc = createFakeDocument();
    const jobId = "job_0123456789abcdef0123456789abcdef";
    const token = "a".repeat(64);
    const revokedUrls = [];
    let pollCount = 0;

    const fakeWin = {
        URL: {
            createObjectURL: () => "blob:reeva-temp-url",
            revokeObjectURL: (u) => revokedUrls.push(u)
        }
    };

    const fetchFn = async (url, opts = {}) => {
        if (url === "/api/media/jobs" && opts.method === "POST") {
            return {
                ok: true,
                status: 202,
                json: async () => ({
                    job: { jobId, status: "queued", operation: "compress" },
                    capabilityToken: token
                })
            };
        }
        if (url === `/api/media/jobs/${jobId}`) {
            assert.equal(opts.headers.Authorization, `Bearer ${token}`);
            pollCount += 1;
            const status = pollCount >= 2 ? "completed" : "processing";
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    job: {
                        jobId,
                        status,
                        output: status === "completed" ? { mediaId: "med_12345678", sizeBytes: 2048 } : undefined
                    }
                })
            };
        }
        if (url === `/api/media/jobs/${jobId}/output?download=1`) {
            assert.equal(opts.headers.Authorization, `Bearer ${token}`);
            return {
                ok: true,
                status: 200,
                headers: { get: () => 'attachment; filename="reeva_compressed.mp4"' },
                blob: async () => new Blob(["video-bytes"])
            };
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    const ctrl = createWorkspaceController(doc, {
        api,
        window: fakeWin,
        fetchFn,
        pollIntervalMs: 5,
        maxPolls: 10,
        revokeDelayMs: 0
    });
    ctrl.setAvailability(true);
    doc.elements["workspace-file"].files = [{ name: "clip.mp4", size: 1024 }];

    await ctrl.handleSubmit();
    for (let i = 0; i < 15 && doc.elements["workspace-download"].disabled; i++) {
        await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(doc.elements["workspace-download"].disabled, false);
    assert.ok(doc.elements["workspace-status"].textContent.includes("complete"));

    await ctrl.handleDownload();
    assert.equal(doc.createdAnchors.length, 1);
    assert.equal(doc.createdAnchors[0].download, "reeva_compressed.mp4");
    assert.equal(doc.createdAnchors[0].clicked, true);
    assert.deepEqual(revokedUrls, ["blob:reeva-temp-url"]);
});

test("5. Cancellation and expired job (410) clear credentials and handle errors gracefully", async () => {
    const doc = createFakeDocument();
    const jobId = "job_fedcba9876543210fedcba9876543210";
    const token = "b".repeat(64);
    let cancelCalled = false;
    let returnExpiredOnDownload = false;

    const fetchFn = async (url, opts = {}) => {
        if (url === "/api/media/jobs" && opts.method === "POST") {
            return {
                ok: true,
                status: 202,
                json: async () => ({ job: { jobId, status: "queued" }, capabilityToken: token })
            };
        }
        if (url === `/api/media/jobs/${jobId}`) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ job: { jobId, status: returnExpiredOnDownload ? "completed" : "processing" } })
            };
        }
        if (url === `/api/media/jobs/${jobId}/cancel` && opts.method === "POST") {
            cancelCalled = true;
            assert.equal(opts.headers.Authorization, `Bearer ${token}`);
            return { ok: true, status: 200, json: async () => ({ job: { jobId, status: "cancelled" } }) };
        }
        if (url === `/api/media/jobs/${jobId}/output?download=1`) {
            return {
                ok: false,
                status: 410,
                json: async () => ({ error: { code: "MEDIA_EXPIRED", message: "Processed media has expired." } })
            };
        }
        return { ok: false, status: 500, json: async () => ({ error: { message: "Server error" } }) };
    };

    const ctrl = createWorkspaceController(doc, {
        api,
        fetchFn,
        pollIntervalMs: 30,
        maxPolls: 10
    });
    ctrl.setAvailability(true);
    doc.elements["workspace-file"].files = [{ name: "clip.mp4", size: 512 }];

    const p = ctrl.handleSubmit();
    await new Promise((r) => setTimeout(r, 10));
    await ctrl.handleCancel();
    await p;
    assert.equal(cancelCalled, true);
    assert.equal(ctrl.hasActiveCredentials(), false);

    // Expired job handling
    returnExpiredOnDownload = true;
    await ctrl.handleSubmit();
    await ctrl.handleDownload();
    assert.equal(ctrl.hasActiveCredentials(), false);
    assert.ok(doc.elements["workspace-status"].textContent.includes("expired"));
});

test("6. Security audit: no localStorage token storage, no unsafe DOM sinks, mobile CSS present", () => {
    const workspaceJs = fs.readFileSync(path.resolve(__dirname, "../public/js/workspace.js"), "utf8");
    const apiJs = fs.readFileSync(path.resolve(__dirname, "../public/js/api.js"), "utf8");
    const html = fs.readFileSync(path.resolve(__dirname, "../public/index.html"), "utf8");
    const css = fs.readFileSync(path.resolve(__dirname, "../public/styles.css"), "utf8");

    assert.equal(workspaceJs.includes("localStorage"), false);
    assert.equal(workspaceJs.includes("sessionStorage"), false);
    assert.equal(workspaceJs.includes("console.log"), false);
    assert.equal(apiJs.includes("localStorage"), false);
    assert.equal(/\.innerHTML\s*=/.test(workspaceJs), false);
    assert.ok(html.includes('id="media-workspace"'));
    assert.ok(css.includes("@media (max-width: 768px)"));
});

test("7. Phase 3.1: audio bitrate contract, bounded download size, and deferred objectURL revocation", async () => {
    // Contract parity: 320k is MP3-only (rejected for aac/opus)
    assert.equal(api.buildMediaProfile("extract_audio", { format: "aac", bitrate: "320k" }).ok, false);
    assert.equal(api.buildMediaProfile("extract_audio", { format: "opus", bitrate: "320k" }).ok, false);
    assert.equal(api.buildMediaProfile("extract_audio", { format: "aac", bitrate: "192k" }).ok, true);

    // Bounded download rejects oversized Content-Length before buffering blob
    let blobCalled = false;
    const oversizedRes = await api.fetchMediaJobOutputBlob("job_0123456789abcdef0123456789abcdef", "c".repeat(64), {
        maxDownloadBytes: 100,
        fetchFn: async () => ({
            ok: true,
            status: 200,
            headers: { get: (h) => (h.toLowerCase() === "content-length" ? "500" : "") },
            blob: async () => { blobCalled = true; return new Blob(["x"]); }
        })
    });
    assert.equal(oversizedRes.success, false);
    assert.equal(oversizedRes.code, "OUTPUT_TOO_LARGE");
    assert.equal(blobCalled, false);

    // Deferred objectURL revocation
    const doc = createFakeDocument();
    const jobId = "job_11112222333344445555666677778888";
    const token = "d".repeat(64);
    const revoked = [];
    const fakeWin = {
        URL: {
            createObjectURL: () => "blob:deferred-url",
            revokeObjectURL: (u) => revoked.push(u)
        }
    };
    const ctrl = createWorkspaceController(doc, {
        api,
        window: fakeWin,
        revokeDelayMs: 25,
        pollIntervalMs: 5,
        fetchFn: async (url) => {
            if (url === "/api/media/jobs") {
                return { ok: true, status: 202, json: async () => ({ job: { jobId, status: "queued" }, capabilityToken: token }) };
            }
            if (url === `/api/media/jobs/${jobId}`) {
                return { ok: true, status: 200, json: async () => ({ job: { jobId, status: "completed", output: { sizeBytes: 10 } } }) };
            }
            return { ok: true, status: 200, headers: { get: () => 'attachment; filename="out.mp4"' }, blob: async () => new Blob(["ok"]) };
        }
    });
    ctrl.setAvailability(true);
    doc.elements["workspace-file"].files = [{ name: "v.mp4", size: 10 }];
    await ctrl.handleSubmit();
    await ctrl.handleDownload();
    // Not revoked synchronously on click tick, but revoked after revokeDelayMs
    assert.equal(revoked.length, 0);
    await new Promise((r) => setTimeout(r, 45));
    assert.deepEqual(revoked, ["blob:deferred-url"]);
});

test("8. Phase 3.1: feature disablement mid-flight and download cancellation races", async () => {
    const doc = createFakeDocument();
    const jobId = "job_aaaabbbbccccddddeeeeffff00001111";
    const token = "e".repeat(64);
    let cancelSent = false;

    const ctrl = createWorkspaceController(doc, {
        api,
        pollIntervalMs: 5,
        revokeDelayMs: 0,
        fetchFn: async (url, opts = {}) => {
            if (url === "/api/media/jobs") {
                await new Promise((r) => setTimeout(r, 30));
                return { ok: true, status: 202, json: async () => ({ job: { jobId, status: "queued" }, capabilityToken: token }) };
            }
            if (url === `/api/media/jobs/${jobId}/cancel`) {
                cancelSent = true;
                return { ok: true, status: 200, json: async () => ({ job: { jobId, status: "cancelled" } }) };
            }
            return { ok: true, status: 200, json: async () => ({ job: { jobId, status: "completed" } }) };
        }
    });

    ctrl.setAvailability(true);
    doc.elements["workspace-file"].files = [{ name: "v.mp4", size: 10 }];

    const submitPromise = ctrl.handleSubmit();
    await new Promise((r) => setTimeout(r, 10));
    // Disable feature while upload is in-flight
    ctrl.setAvailability(false);
    await submitPromise;

    assert.equal(ctrl.getIsBusy(), false);
    assert.equal(ctrl.hasActiveCredentials(), false);
    assert.equal(cancelSent, true);
});
