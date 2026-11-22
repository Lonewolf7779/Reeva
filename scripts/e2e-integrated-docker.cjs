// scripts/e2e-integrated-docker.cjs — Phase 3.3 Real Browser + Real FFmpeg Integrated Verification
"use strict";

const { spawn, execFileSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("node:assert/strict");

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

function findChromeBinary() {
    const candidates = [
        process.env.CHROME_PATH,
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error("No Chrome/Chromium/Edge binary found on host.");
}

async function createCdpClient(port) {
    let version = null;
    let lastErr = null;
    for (let i = 0; i < 40; i++) {
        try {
            version = await getJson(`http://127.0.0.1:${port}/json/version`);
            break;
        } catch (err) {
            lastErr = err;
            await delay(300);
        }
    }
    if (!version) throw new Error(`CDP endpoint did not start on port ${port} (lastErr: ${lastErr && lastErr.message})`);

    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

    let nextId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
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

function ffprobeInContainer(containerName, localFilePath) {
    const containerTmp = `/tmp/probe_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try { fs.chmodSync(localFilePath, 0o644); } catch (_) {}
    execFileSync("docker", ["cp", localFilePath, `${containerName}:${containerTmp}`]);
    try {
        const out = execFileSync("docker", [
            "exec", "-u", "root", containerName,
            "/usr/local/bin/ffprobe",
            "-v", "error",
            "-show_format",
            "-show_streams",
            "-of", "json",
            containerTmp
        ], { encoding: "utf8" });
        return JSON.parse(out);
    } finally {
        try {
            execFileSync("docker", ["exec", "-u", "root", containerName, "rm", "-f", containerTmp]);
        } catch (_) {}
    }
}

async function run() {
    const disabledBaseUrl = process.env.DISABLED_BASE_URL || "http://127.0.0.1:3100";
    const enabledBaseUrl = process.env.ENABLED_BASE_URL || "http://127.0.0.1:3101";
    const containerName = process.env.INTEGRATED_CONTAINER_NAME || "reeva-ci-integrated";
    const fixturePath = process.env.SYNTH_FIXTURE_PATH;

    assert.ok(fixturePath && fs.existsSync(fixturePath), `Missing synthetic fixture at '${fixturePath}'`);
    const fixtureProbe = ffprobeInContainer(containerName, fixturePath);
    const fixtureVideo = fixtureProbe.streams.find((s) => s.codec_type === "video");
    const fixtureAudio = fixtureProbe.streams.find((s) => s.codec_type === "audio");
    assert.ok(fixtureVideo && fixtureAudio, "Fixture must contain both video and audio streams");

    const chromeBin = findChromeBinary();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "reeva-p33-"));
    const userDataDir = path.join(workDir, "profile");
    const downloadDir = path.join(workDir, "downloads");
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(downloadDir, { recursive: true });

    const emptyFile = path.join(workDir, "empty.mp4");
    const badFile = path.join(workDir, "corrupt.txt");
    fs.writeFileSync(emptyFile, Buffer.alloc(0));
    fs.writeFileSync(badFile, "plain-text-not-video");

    const cdpPort = 9345;
    const chromeArgs = [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-address=127.0.0.1",
        "--remote-allow-origins=*",
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${cdpPort}`
    ];
    if (process.platform === "linux") {
        chromeArgs.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage");
    }
    chromeArgs.push("about:blank");

    console.log("Launching browser:", chromeBin, execFileSync(chromeBin, ["--version"], { encoding: "utf8" }).trim());
    const browserProc = spawn(chromeBin, chromeArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let browserStderr = "";
    browserProc.stdout.on("data", (d) => {
        if (browserStderr.length < 4096) browserStderr += d.toString();
    });
    browserProc.stderr.on("data", (d) => {
        if (browserStderr.length < 4096) browserStderr += d.toString();
    });
    browserProc.on("exit", (code, sig) => {
        console.log("Browser exited early:", code, sig);
    });
    const report = {
        browser: "",
        fixture: {
            duration: fixtureProbe.format.duration,
            videoCodec: fixtureVideo.codec_name,
            audioCodec: fixtureAudio.codec_name,
            dimensions: `${fixtureVideo.width}x${fixtureVideo.height}`
        },
        operations: {},
        failureAndCancel: {},
        security: {},
        resources: {}
    };

    try {
        const cdp = await createCdpClient(cdpPort);
        report.browser = cdp.version.Browser;
        await cdp.send("Page.enable");
        await cdp.send("DOM.enable");
        await cdp.send("Runtime.enable");
        await cdp.send("Performance.enable");
        await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });

        // 1. Verify default feature-disabled container rejects media processing
        await cdp.send("Page.navigate", { url: disabledBaseUrl });
        await delay(1200);
        const disabledCheck = await cdp.evalJs(`(async () => ({
            submitDisabled: document.getElementById('workspace-submit').disabled,
            directPostStatus: (await fetch('/api/media/jobs', { method: 'POST' })).status
        }))()`);
        assert.equal(disabledCheck.submitDisabled, true);
        assert.equal(disabledCheck.directPostStatus, 403);
        report.security.defaultGateDisabled = "PASS (UI disabled, direct POST returned 403)";

        // 2. Navigate to isolated enabled container (real FFmpeg, zero stubs)
        await cdp.send("Page.navigate", { url: enabledBaseUrl });
        await delay(1200);
        const enabledCheck = await cdp.evalJs(`document.getElementById('workspace-submit').disabled`);
        assert.equal(enabledCheck, false, "Workspace must be enabled on isolated test container");

        const attachFile = async (filePath) => {
            const docNode = await cdp.send("DOM.getDocument");
            const inputNode = await cdp.send("DOM.querySelector", { nodeId: docNode.root.nodeId, selector: "#workspace-file" });
            await cdp.send("DOM.setFileInputFiles", { nodeId: inputNode.nodeId, files: [filePath] });
        };

        // 3. Empty & unsupported file rejections
        await attachFile(emptyFile);
        await cdp.evalJs(`document.getElementById('workspace-submit').click()`);
        await delay(150);
        assert.ok((await cdp.evalJs(`document.getElementById('workspace-status').textContent`)).toLowerCase().includes("empty"));
        report.failureAndCancel.emptyUpload = "PASS (rejected client-side)";

        await attachFile(badFile);
        await cdp.evalJs(`document.getElementById('workspace-submit').click()`);
        await delay(600);
        const badStatus = await cdp.evalJs(`document.getElementById('workspace-status').textContent`);
        assert.ok(badStatus.toLowerCase().includes("supported") || badStatus.toLowerCase().includes("failed"), `Unexpected bad status: ${badStatus}`);
        report.failureAndCancel.unsupportedUpload = "PASS (rejected by backend signature/ffprobe)";

        // 4. All 5 real FFmpeg operations end-to-end
        await attachFile(fixturePath);
        const operations = [
            {
                op: "compress",
                setup: `document.getElementById('workspace-compress-preset').value = 'compact';`,
                verify: (probe) => {
                    assert.ok(probe.format.format_name.includes("mp4"));
                    assert.equal(probe.streams.find((s) => s.codec_type === "video").codec_name, "h264");
                }
            },
            {
                op: "convert",
                setup: `document.getElementById('workspace-convert-format').value = 'webm';`,
                verify: (probe) => {
                    assert.ok(probe.format.format_name.includes("webm"));
                    assert.equal(probe.streams.find((s) => s.codec_type === "video").codec_name, "vp9");
                    assert.equal(probe.streams.find((s) => s.codec_type === "audio").codec_name, "opus");
                }
            },
            {
                op: "extract_audio",
                setup: `document.getElementById('workspace-audio-format').value = 'mp3'; document.getElementById('workspace-audio-bitrate').value = '128k';`,
                verify: (probe) => {
                    assert.equal(probe.streams.filter((s) => s.codec_type === "video").length, 0);
                    assert.equal(probe.streams.find((s) => s.codec_type === "audio").codec_name, "mp3");
                }
            },
            {
                op: "trim",
                setup: `document.getElementById('workspace-trim-start').value = '0.5'; document.getElementById('workspace-trim-end').value = '2.0'; document.getElementById('workspace-trim-mode').value = 'accurate';`,
                verify: (probe) => {
                    const dur = parseFloat(probe.format.duration);
                    assert.ok(dur >= 1.2 && dur <= 1.8, `Expected ~1.5s trimmed duration, got ${dur}`);
                }
            },
            {
                op: "resize",
                setup: `document.getElementById('workspace-resize-preset').value = 'portrait_1080x1920'; document.getElementById('workspace-resize-fit').value = 'contain';`,
                verify: (probe) => {
                    const v = probe.streams.find((s) => s.codec_type === "video");
                    assert.equal(v.width, 1080);
                    assert.equal(v.height, 1920);
                }
            }
        ];

        for (const item of operations) {
            const opStart = Date.now();
            await cdp.evalJs(`(() => {
                const sel = document.getElementById('workspace-operation');
                sel.value = '${item.op}';
                sel.dispatchEvent(new Event('change'));
                ${item.setup}
                document.getElementById('workspace-submit').click();
            })()`);

            let completed = false;
            let lastStatus = "";
            for (let i = 0; i < 60; i++) {
                await delay(500);
                const st = await cdp.evalJs(`({
                    status: document.getElementById('workspace-status').textContent,
                    dlDisabled: document.getElementById('workspace-download').disabled
                })`);
                lastStatus = st.status;
                if (!st.dlDisabled) {
                    completed = true;
                    break;
                }
            }
            assert.equal(completed, true, `Operation ${item.op} failed to complete (status: ${lastStatus})`);

            const opDownloadDir = path.join(downloadDir, item.op);
            fs.mkdirSync(opDownloadDir, { recursive: true });
            await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: opDownloadDir });

            await cdp.evalJs(`document.getElementById('workspace-download').click()`);
            let savedFile = null;
            for (let i = 0; i < 100; i++) {
                await delay(100);
                const current = fs.readdirSync(opDownloadDir).filter((f) => !f.endsWith(".crdownload") && !f.endsWith(".tmp"));
                if (current.length > 0) {
                    savedFile = path.join(opDownloadDir, current[0]);
                    break;
                }
            }
            assert.ok(savedFile && fs.existsSync(savedFile), `Saved download file missing for ${item.op} (dir=${JSON.stringify(fs.readdirSync(opDownloadDir))}, status=${await cdp.evalJs("document.getElementById('workspace-status').textContent")})`);
            const fileBytes = fs.statSync(savedFile).size;
            assert.ok(fileBytes > 0, `Downloaded file is 0 bytes for ${item.op}`);

            const probe = ffprobeInContainer(containerName, savedFile);
            item.verify(probe);

            report.operations[item.op] = {
                status: "PASS",
                durationMs: Date.now() - opStart,
                downloadedBytes: fileBytes,
                format: probe.format.format_name,
                durationSec: probe.format.duration
            };
        }

        // 5. Real processing cancellation test
        await cdp.evalJs(`(() => {
            const sel = document.getElementById('workspace-operation');
            sel.value = 'convert';
            sel.dispatchEvent(new Event('change'));
            document.getElementById('workspace-convert-format').value = 'webm';
            document.getElementById('workspace-submit').click();
        })()`);
        await delay(250);
        await cdp.evalJs(`document.getElementById('workspace-cancel').click()`);
        await delay(500);
        const cancelStatus = await cdp.evalJs(`document.getElementById('workspace-status').textContent`);
        assert.ok(cancelStatus.toLowerCase().includes("cancelled"), `Expected cancelled status, got: ${cancelStatus}`);
        report.failureAndCancel.activeCancel = "PASS (cancelled active webm job)";

        // 6. Browser security & storage verification
        const secState = await cdp.evalJs(`(() => ({
            localKeys: Object.keys(localStorage),
            sessionLen: sessionStorage.length,
            search: location.search
        }))()`);
        assert.equal(secState.sessionLen, 0);
        assert.equal(secState.search, "");
        assert.ok(!secState.localKeys.some((k) => k.toLowerCase().includes("token")));
        report.security.browserStorageAndUrls = "PASS (zero tokens in storage or URL)";

        // 7. Container resource, temp-file, and orphan-process checks
        report.resources.dockerStats = execFileSync("docker", [
            "stats", "--no-stream", "--format", "{{.MemUsage}} | CPU={{.CPUPerc}}", containerName
        ], { encoding: "utf8" }).trim();

        const tempFilesLeft = execFileSync("docker", [
            "exec", containerName, "sh", "-c", "ls -1 /var/reeva/media | grep '^upl_' || true"
        ], { encoding: "utf8" }).trim();
        assert.equal(tempFilesLeft, "", `Orphaned raw uploads remained: ${tempFilesLeft}`);
        report.resources.rawUploadsRemaining = 0;

        const orphanFfmpeg = execFileSync("docker", [
            "exec", containerName, "sh", "-c", "grep -l 'ffmpeg\\|ffprobe' /proc/[0-9]*/comm 2>/dev/null || true"
        ], { encoding: "utf8" }).trim();
        assert.equal(orphanFfmpeg, "", `Orphaned ffmpeg processes remained: ${orphanFfmpeg}`);
        report.resources.orphanedFfmpegProcesses = 0;

        cdp.ws.close();
        console.log("PHASE_3_3_INTEGRATED_REPORT=" + JSON.stringify(report, null, 2));
    } catch (err) {
        if (browserStderr) console.error("Browser stderr:", browserStderr);
        throw err;
    } finally {
        try { browserProc.kill("SIGKILL"); } catch (_) {}
        await delay(300);
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    }
}

run().catch((err) => {
    console.error("PHASE 3.3 INTEGRATED VERIFICATION FAILED:", err);
    process.exit(1);
});
