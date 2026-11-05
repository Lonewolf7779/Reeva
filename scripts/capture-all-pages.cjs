// scripts/capture-all-pages.cjs
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outDir = path.resolve('C:/Users/SantoshPrajapati-Tec/.gemini/antigravity/brain/bd266af1-4429-4da3-807d-da6a7ade43a0/screenshots/phase-5.2');

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
    const port = 9338;
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

        const mainViewports = [
            { name: 'index-desktop-1440x900', url: 'http://127.0.0.1:3000', width: 1440, height: 900 },
            { name: 'index-tablet-768x1024', url: 'http://127.0.0.1:3000', width: 768, height: 1024 },
            { name: 'index-mobile-393x852', url: 'http://127.0.0.1:3000', width: 393, height: 852 },
            { name: 'index-mobile-320x640', url: 'http://127.0.0.1:3000', width: 320, height: 640 },
            { name: 'platforms-desktop-1440x900', url: 'http://127.0.0.1:3000/platforms.html', width: 1440, height: 900 },
            { name: 'platforms-mobile-393x852', url: 'http://127.0.0.1:3000/platforms.html', width: 393, height: 852 },
            { name: 'how-to-use-desktop-1440x900', url: 'http://127.0.0.1:3000/how-to-use.html', width: 1440, height: 900 },
            { name: 'faq-desktop-1440x900', url: 'http://127.0.0.1:3000/faq.html', width: 1440, height: 900 },
            { name: 'about-desktop-1440x900', url: 'http://127.0.0.1:3000/about.html', width: 1440, height: 900 },
            { name: 'contact-desktop-1440x900', url: 'http://127.0.0.1:3000/contact.html', width: 1440, height: 900 },
            { name: 'copyright-desktop-1440x900', url: 'http://127.0.0.1:3000/copyright.html', width: 1440, height: 900 }
        ];

        for (const item of mainViewports) {
            await send('Emulation.setDeviceMetricsOverride', {
                width: item.width,
                height: item.height,
                deviceScaleFactor: item.width < 768 ? 2 : 1,
                mobile: item.width < 768
            });
            await send('Page.navigate', { url: item.url });
            await delay(700);

            const res = await send('Page.captureScreenshot', { format: 'png' });
            const filePath = path.join(outDir, `${item.name}.png`);
            fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
            console.log(`Saved screenshot: ${item.name}.png (${fs.statSync(filePath).size} bytes)`);
        }

        ws.close();
    } catch (err) {
        console.error('Capture failed:', err);
    } finally {
        edge.kill();
    }
}

run();
