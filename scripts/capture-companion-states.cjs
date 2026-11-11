// scripts/capture-companion-states.cjs
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outDir = path.resolve('C:/Users/SantoshPrajapati-Tec/.gemini/antigravity/brain/bd266af1-4429-4da3-807d-da6a7ade43a0/screenshots/companion');

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
    const port = 9345;
    const edge = spawn(edgePath, [
        '--headless',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--remote-debugging-port=${port}`,
        'about:blank'
    ], { stdio: 'ignore' });

    try {
        await delay(1500);
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

        const viewports = [
            { name: 'mobile-320px', width: 320, height: 640 },
            { name: 'mobile-360px', width: 360, height: 800 },
            { name: 'mobile-375px', width: 375, height: 812 },
            { name: 'mobile-390px', width: 390, height: 844 },
            { name: 'mobile-412px', width: 412, height: 915 },
            { name: 'mobile-430px', width: 430, height: 932 },
            { name: 'tablet-768px', width: 768, height: 1024 },
            { name: 'desktop-1024px', width: 1024, height: 768 },
            { name: 'desktop-1280px', width: 1280, height: 800 },
            { name: 'desktop-1440px', width: 1440, height: 900 },
            { name: 'desktop-1920px', width: 1920, height: 1080 }
        ];

        // 1. Capture responsive viewports with companion docked
        for (const vp of viewports) {
            await send('Emulation.setDeviceMetricsOverride', {
                width: vp.width,
                height: vp.height,
                deviceScaleFactor: vp.width < 768 ? 2 : 1,
                mobile: vp.width < 768
            });
            await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
            await delay(1200);

            const res = await send('Page.captureScreenshot', { format: 'png' });
            const filePath = path.join(outDir, `${vp.name}.png`);
            fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
            console.log(`Saved screenshot: ${vp.name}.png (${fs.statSync(filePath).size} bytes)`);
        }

        // 2. Capture Companion interactive states at 390px mobile
        const statesToTest = [
            { name: 'companion-state-welcome', state: 'WELCOME', msg: 'Hi there! Ready to download your favorite media?' },
            { name: 'companion-state-curious', state: 'CURIOUS', msg: 'Paste your link and I will inspect it for you!' },
            { name: 'companion-state-processing', state: 'PROCESSING', msg: 'Extracting media streams right now...' },
            { name: 'companion-state-success', state: 'SUCCESS', msg: 'All done! Your media is ready to download.' },
            { name: 'companion-state-failure', state: 'FAILURE', msg: 'Oh no, I could not fetch this media. Please check the link!' }
        ];

        await send('Emulation.setDeviceMetricsOverride', {
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            mobile: true
        });

        for (const st of statesToTest) {
            await send('Runtime.evaluate', {
                expression: `
                    if (window.ReevaCompanion) {
                        const comp = window.ReevaCompanion.getInstance();
                        if (comp) {
                            comp.state = window.ReevaCompanion.STATES.IDLE;
                            comp.triggerState(window.ReevaCompanion.STATES.${st.state}, 10000);
                        }
                    }
                `
            });
            await delay(700);

            const res = await send('Page.captureScreenshot', { format: 'png' });
            const filePath = path.join(outDir, `${st.name}.png`);
            fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
            console.log(`Saved companion state screenshot: ${st.name}.png`);
        }

        // 3. Dark mode capture with companion active
        await send('Runtime.evaluate', { expression: 'document.getElementById("theme-toggle").click()' });
        await delay(500);
        const darkRes = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, 'companion-dark-390px.png'), Buffer.from(darkRes.data, 'base64'));
        console.log('Saved companion dark mode screenshot: companion-dark-390px.png');

        ws.close();
    } catch (err) {
        console.error('Visual capture failed:', err);
    } finally {
        edge.kill();
    }
}

run();
