// scripts/verify-mobile-viewports.cjs
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outDir = path.resolve('C:/Users/SantoshPrajapati-Tec/.gemini/antigravity/brain/bd266af1-4429-4da3-807d-da6a7ade43a0/screenshots/icon-grid-design');

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
    const port = 9335;
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
            { name: 'mobile-320x640', width: 320, height: 640 },
            { name: 'mobile-360x800', width: 360, height: 800 },
            { name: 'mobile-375x812', width: 375, height: 812 },
            { name: 'mobile-393x852', width: 393, height: 852 },
            { name: 'mobile-412x915', width: 412, height: 915 },
            { name: 'mobile-430x932', width: 430, height: 932 },
            { name: 'tablet-768x1024', width: 768, height: 1024 },
            { name: 'desktop-1024x768', width: 1024, height: 768 },
            { name: 'desktop-1440x900', width: 1440, height: 900 }
        ];

        for (const vp of viewports) {
            await send('Emulation.setDeviceMetricsOverride', {
                width: vp.width,
                height: vp.height,
                deviceScaleFactor: vp.width < 768 ? 2 : 1,
                mobile: vp.width < 768
            });
            await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
            await delay(700);

            const res = await send('Page.captureScreenshot', { format: 'png' });
            const filePath = path.join(outDir, `${vp.name}.png`);
            fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
            console.log(`Saved screenshot: ${vp.name}.png (${fs.statSync(filePath).size} bytes)`);
        }

        ws.close();
    } catch (err) {
        console.error('Mobile viewport capture failed:', err);
    } finally {
        edge.kill();
    }
}

run();
