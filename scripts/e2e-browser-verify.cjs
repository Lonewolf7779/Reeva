// scripts/e2e-browser-verify.cjs — Phase 3.2 Real-Browser End-to-End Verification (Chrome & Edge via CDP)
"use strict";

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const app = require("../server.cjs");

const BROWSER_CANDIDATES = [
    { name: "Google Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", port: 9341 },
    { name: "Microsoft Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", port: 9342 }
];

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = "";
            res.on("data", (c) => { data += c; });
            res.on("end", () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on("error", reject);
    });
}

function createFakeFfprobeSpawn() {
    return () => {
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.pid = 77777;
        proc.killed = false;
        proc.kill = () => { proc.killed = true; };
        setTimeout(() => {
            proc.stdout.write(JSON.stringify({
                format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "3.0" },
                streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360 }]
            }));
            proc.stdout.end();
            proc.stderr.end();
            proc.emit("close", 0, null);
        }, 10);
        return proc;
    };
}

async function createCdpClient(port) {
    let version = null;
    for (let i = 0; i < 20; i++) {
        try {
            version = await getJson(`http://127.0.0.1:${port}/json/version`);
            break;
        } catch (_) {
            await delay(250);
        }
    }
    if (!version) throw new Error(`CDP endpoint did not start on port ${port}`);

    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

    let nextId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        const handler = (evt) => {
            const msg = JSON.parse(evt.data);
            if (msg.id === id) {
                clearTimeout(timer);
                ws.removeEventListener("message", handler);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            }
        };
        ws.addEventListener("message", handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const evalJs = async (expression) => {
        const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (res.exceptionDetails) {
            throw new Error(`Browser JS exception: ${JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result ? res.result.value : undefined;
    };

    return { version, ws, send, evalJs };
}

async function verifyInBrowser(browser, baseUrl, tempDir) {
    const userDataDir = fs.mkdtempSync(path.join(tempDir, `profile-${browser.port}-`));
    const downloadDir = fs.mkdtempSync(path.join(tempDir, `dl-${browser.port}-`));
    const fixtureMp4 = path.join(tempDir, "valid_fixture.mp4");
    const emptyFile = path.join(tempDir, "empty_fixture.mp4");
    const badFile = path.join(tempDir, "invalid_fixture.txt");

    fs.writeFileSync(fixtureMp4, Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"), Buffer.alloc(256)]));
    fs.writeFileSync(emptyFile, Buffer.alloc(0));
    fs.writeFileSync(badFile, "not-a-media-file");

    const proc = spawn(browser.path, [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${browser.port}`,
        "about:blank"
    ], { stdio: "ignore", windowsHide: true });

    const report = { browser: browser.name, version: "", operations: {}, security: {}, memory: {}, mobile: {} };

    try {
        const cdp = await createCdpClient(browser.port);
        report.version = cdp.version.Browser;
        await cdp.send("Page.enable");
        await cdp.send("DOM.enable");
        await cdp.send("Runtime.enable");
        await cdp.send("Performance.enable");
        await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });

        // 1. Default feature-disabled verification + Downloader check
        app.setMediaProcessingEnabled(false);
        await cdp.send("Page.navigate", { url: baseUrl });
        await delay(1200);

        const disabledState = await cdp.evalJs(`(() => ({
            title: document.title,
            hasCompanion: Boolean(document.getElementById('companion-stage')),
            workspaceDisabledClass: document.getElementById('media-workspace').classList.contains('workspace-disabled'),
            submitDisabled: document.getElementById('workspace-submit').disabled,
            fileDisabled: document.getElementById('workspace-file').disabled,
            availabilityText: document.getElementById('workspace-availability').textContent.trim(),
            urlDisabled: document.getElementById('get').disabled
        }))()`);
        assert.ok(disabledState.title.includes("Reeva"));
        assert.equal(disabledState.hasCompanion, true);
        assert.equal(disabledState.workspaceDisabledClass, true);
        assert.equal(disabledState.submitDisabled, true);
        assert.equal(disabledState.fileDisabled, true);

        const directPostStatus = await cdp.evalJs(`(async () => {
            const r = await fetch('/api/media/jobs', { method: 'POST' });
            return r.status;
        })()`);
        assert.equal(directPostStatus, 403);
        report.downloaderAndGate = "PASS (disabled workspace locked, direct POST returned 403)";

        // 2. Enable media processing in isolated server and reload
        app.setMediaProcessingEnabled(true);
        await cdp.send("Page.reload", { ignoreCache: true });
        await delay(1200);

        const metricsBefore = await cdp.send("Performance.getMetrics");
        report.memory.jsHeapBeforeBytes = metricsBefore.metrics.find((m) => m.name === "JSHeapUsedSize")?.value || 0;

        // Helper to attach file to #workspace-file
        const attachFile = async (filePath) => {
            const docNode = await cdp.send("DOM.getDocument");
            const inputNode = await cdp.send("DOM.querySelector", { nodeId: docNode.root.nodeId, selector: "#workspace-file" });
            await cdp.send("DOM.setFileInputFiles", { nodeId: inputNode.nodeId, files: [filePath] });
        };

        // 3. Empty file & invalid file checks
        await attachFile(emptyFile);
        await cdp.evalJs(`document.getElementById('workspace-submit').click()`);
        await delay(150);
        const emptyMsg = await cdp.evalJs(`document.getElementById('workspace-status').textContent`);
        assert.ok(emptyMsg.toLowerCase().includes("empty"), `Expected empty file message, got: ${emptyMsg}`);

        await attachFile(badFile);
        await cdp.evalJs(`document.getElementById('workspace-submit').click()`);
        await delay(400);
        const badMsg = await cdp.evalJs(`document.getElementById('workspace-status').textContent`);
        assert.ok(badMsg.toLowerCase().includes("supported") || badMsg.toLowerCase().includes("failed"), `Expected 415 rejection, got: ${badMsg}`);

        // 4. Test all 5 operations end-to-end in real browser
        await attachFile(fixtureMp4);
        const ops = [
            { op: "compress", setup: `document.getElementById('workspace-compress-preset').value = 'compact';` },
            { op: "convert", setup: `document.getElementById('workspace-convert-format').value = 'webm';` },
            { op: "extract_audio", setup: `document.getElementById('workspace-audio-format').value = 'mp3'; document.getElementById('workspace-audio-bitrate').value = '128k';` },
            { op: "trim", setup: `document.getElementById('workspace-trim-start').value = '0'; document.getElementById('workspace-trim-end').value = '2';` },
            { op: "resize", setup: `document.getElementById('workspace-resize-preset').value = 'portrait_1080x1920';` }
        ];

        for (const item of ops) {
            await cdp.evalJs(`(() => {
                const sel = document.getElementById('workspace-operation');
                sel.value = '${item.op}';
                sel.dispatchEvent(new Event('change'));
                ${item.setup}
                document.getElementById('workspace-submit').click();
            })()`);

            let statusText = "";
            let dlReady = false;
            for (let i = 0; i < 30; i++) {
                await delay(150);
                const st = await cdp.evalJs(`({
                    status: document.getElementById('workspace-status').textContent,
                    dlDisabled: document.getElementById('workspace-download').disabled
                })`);
                statusText = st.status;
                if (!st.dlDisabled) {
                    dlReady = true;
                    break;
                }
            }
            assert.equal(dlReady, true, `Operation ${item.op} did not complete (status: ${statusText})`);

            const beforeCount = fs.readdirSync(downloadDir).filter((f) => !f.endsWith(".crdownload") && !f.endsWith(".tmp")).length;
            await cdp.evalJs(`document.getElementById('workspace-download').click()`);
            let downloaded = false;
            for (let i = 0; i < 40; i++) {
                await delay(100);
                const doneFiles = fs.readdirSync(downloadDir).filter((f) => !f.endsWith(".crdownload") && !f.endsWith(".tmp"));
                if (doneFiles.length > beforeCount) {
                    downloaded = true;
                    break;
                }
            }
            assert.equal(downloaded, true, `Browser download did not complete for ${item.op}`);
            report.operations[item.op] = "PASS (uploaded, polled, downloaded)";
        }

        // 5. Security checks in real browser storage & URL
        const sec = await cdp.evalJs(`(() => ({
            localStorageKeys: Object.keys(localStorage),
            sessionStorageLength: sessionStorage.length,
            locationSearch: location.search,
            statusRole: document.getElementById('workspace-status').getAttribute('role'),
            statusLive: document.getElementById('workspace-status').getAttribute('aria-live')
        }))()`);
        assert.equal(sec.sessionStorageLength, 0);
        assert.equal(sec.locationSearch, "");
        assert.equal(sec.statusRole, "status");
        assert.equal(sec.statusLive, "polite");
        assert.ok(!sec.localStorageKeys.some((k) => k.toLowerCase().includes("token")));
        report.security = "PASS (no tokens in storage or URL; accessible live status region)";

        // 6. Mobile viewport emulation check (390x844)
        await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            mobile: true
        });
        await delay(200);
        const mobileOverflow = await cdp.evalJs(`document.documentElement.scrollWidth <= window.innerWidth`);
        assert.equal(mobileOverflow, true, "Mobile 390px viewport must not have horizontal overflow");
        report.mobile = "PASS (390x844 viewport, zero horizontal overflow)";

        const metricsAfter = await cdp.send("Performance.getMetrics");
        report.memory.jsHeapAfterBytes = metricsAfter.metrics.find((m) => m.name === "JSHeapUsedSize")?.value || 0;

        cdp.ws.close();
    } finally {
        if (process.platform === "win32" && proc.pid) {
            try {
                spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore", windowsHide: true });
            } catch (_) {}
        } else {
            try { proc.kill(); } catch (_) {}
        }
        await delay(500);
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (_) {}
    }

    return report;
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reeva-e2e-browser-"));
    const origTemp = process.env.REEVA_TEMP_DIR;
    process.env.REEVA_TEMP_DIR = tempDir;

    app.mediaUploadOptions = {
        baseDir: tempDir,
        ffprobePath: process.execPath,
        spawnFn: createFakeFfprobeSpawn()
    };

    const manager = app.getMediaJobManager();
    const origProcessFn = manager.processMediaFn;
    manager.processMediaFn = async ({ profile }) => {
        const ext = profile.operation === "extract_audio" ? "mp3" : (profile.operation === "convert" ? "webm" : "mp4");
        const outPath = path.join(tempDir, `e2e_out_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`);
        fs.writeFileSync(outPath, `synthetic-e2e-${profile.operation}-output`);
        return { outputPath: outPath, outputSizeBytes: 32, operation: profile.operation, outputExt: ext };
    };

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
        const results = [];
        for (const browser of BROWSER_CANDIDATES) {
            if (!fs.existsSync(browser.path)) {
                console.log(`SKIP: ${browser.name} not found at ${browser.path}`);
                continue;
            }
            console.log(`Running E2E browser verification on ${browser.name}...`);
            const res = await verifyInBrowser(browser, baseUrl, tempDir);
            results.push(res);
            console.log(`PASS: ${browser.name} (${res.version})`);
        }
        console.log("E2E_REPORT_JSON=" + JSON.stringify(results, null, 2));
    } finally {
        manager.processMediaFn = origProcessFn;
        app.mediaUploadOptions = {};
        app.setMediaProcessingEnabled(false);
        if (origTemp !== undefined) process.env.REEVA_TEMP_DIR = origTemp;
        else delete process.env.REEVA_TEMP_DIR;
        await new Promise((r) => server.close(r));
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    }
}

main().catch((err) => {
    console.error("E2E BROWSER VERIFICATION FAILED:", err);
    process.exit(1);
});
