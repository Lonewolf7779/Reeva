// scripts/capture-vn-companion.cjs
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9388;
const outDir = path.resolve('C:/Users/SantoshPrajapati-Tec/.gemini/antigravity/brain/bd266af1-4429-4da3-807d-da6a7ade43a0/screenshots/vn-companion');

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

async function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    const tmpProfile = path.join(os.tmpdir(), `edge-cap-${Date.now()}`);
    const edge = spawn(edgePath, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${tmpProfile}`,
        `--remote-debugging-port=${port}`,
        'about:blank'
    ], { stdio: 'ignore' });

    try {
        await delay(2000);
        const version = await getJson(`http://127.0.0.1:${port}/json/version`);
        console.log('Connected to Edge:', version.Browser);

        const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
        const pageTarget = targets.find(t => t.type === 'page') || targets[0];
        const wsUrl = pageTarget.webSocketDebuggerUrl;

        const ws = new WebSocket(wsUrl);
        await new Promise(r => ws.onopen = r);

        let id = 1;
        const send = (method, params = {}) => new Promise((resolve) => {
            const reqId = id++;
            const handler = (evt) => {
                const msg = JSON.parse(evt.data);
                if (msg.id === reqId) {
                    ws.removeEventListener('message', handler);
                    resolve(msg.result);
                }
            };
            ws.addEventListener('message', handler);
            ws.send(JSON.stringify({ id: reqId, method, params }));
        });

        await send('Page.enable');
        await send('Runtime.enable');

        // 1. Desktop 1440px Capture: Downloader + Dedicated Companion Stage
        await send('Emulation.setDeviceMetricsOverride', {
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false
        });
        await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
        await delay(1200);

        let res = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, 'desktop-1440px-workspace.png'), Buffer.from(res.data, 'base64'));
        console.log('Saved: desktop-1440px-workspace.png');

        // 2. Desktop 1280px Capture
        await send('Emulation.setDeviceMetricsOverride', {
            width: 1280,
            height: 800,
            deviceScaleFactor: 1,
            mobile: false
        });
        await delay(600);
        res = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, 'desktop-1280px-workspace.png'), Buffer.from(res.data, 'base64'));
        console.log('Saved: desktop-1280px-workspace.png');

        // 3. Mobile 390px Capture (Normal / Light Mode)
        await send('Emulation.setDeviceMetricsOverride', {
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            mobile: true
        });
        await delay(600);
        res = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, 'mobile-390px-overview.png'), Buffer.from(res.data, 'base64'));
        console.log('Saved: mobile-390px-overview.png');

        // 4. Mobile 375px Capture
        await send('Emulation.setDeviceMetricsOverride', {
            width: 375,
            height: 812,
            deviceScaleFactor: 2,
            mobile: true
        });
        await delay(500);
        res = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, 'mobile-375px-overview.png'), Buffer.from(res.data, 'base64'));
        console.log('Saved: mobile-375px-overview.png');

        // 5. Capture Companion States across the 10 Expressions at Desktop
        const statesToTest = [
            { name: 'expression-welcome-smiling', state: 'WELCOME' },
            { name: 'expression-curious', state: 'CURIOUS' },
            { name: 'expression-platform-happy', state: 'PLATFORM_SELECTED' },
            { name: 'expression-focused-processing', state: 'PROCESSING' },
            { name: 'expression-celebrating-success', state: 'SUCCESS' },
            { name: 'expression-crying-failure', state: 'FAILURE' },
            { name: 'expression-confused-invalid-url', state: 'INVALID_URL' },
            { name: 'expression-disappointed-network', state: 'NETWORK_ERROR' }
        ];

        await send('Emulation.setDeviceMetricsOverride', {
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false
        });

        for (const st of statesToTest) {
            const evalRes = await send('Runtime.evaluate', {
                expression: `
                    (() => {
                        const comp = (window.ReevaCompanion && window.ReevaCompanion.getInstance()) ||
                                     (window.__reevaApp && typeof window.__reevaApp.getCompanion === 'function' && window.__reevaApp.getCompanion());
                        if (!comp) return 'NO_COMPANION';
                        comp.state = window.ReevaCompanion.STATES.IDLE;
                        comp.triggerState(window.ReevaCompanion.STATES.${st.state}, 15000);
                        return 'TRIGGERED_' + comp.currentExpression;
                    })()
                `,
                returnByValue: true
            });
            console.log(`State ${st.state}:`, evalRes && evalRes.result && evalRes.result.value);
            await delay(600);

            res = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(outDir, `${st.name}.png`), Buffer.from(res.data, 'base64'));
            console.log(`Saved: ${st.name}.png`);
        }

        // 6. Dark Mode Capture (Desktop)
        await send('Runtime.evaluate', { expression: 'document.getElementById("theme-toggle").click()' });
        await delay(500);
        res = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, 'desktop-dark-mode.png'), Buffer.from(res.data, 'base64'));
        console.log('Saved: desktop-dark-mode.png');

        // 7. Dark Mode Capture (Mobile 390px)
        await send('Emulation.setDeviceMetricsOverride', {
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            mobile: true
        });
        await delay(500);
        res = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, 'mobile-390px-dark.png'), Buffer.from(res.data, 'base64'));
        console.log('Saved: mobile-390px-dark.png');

        ws.close();
        console.log('All visual captures completed cleanly!');
    } catch (err) {
        console.error('Visual capture error:', err);
    } finally {
        edge.kill();
    }
}

run();
