// scripts/cdp-screenshot.cjs
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outDir = path.resolve('C:/Users/SantoshPrajapati-Tec/.gemini/antigravity/brain/bd266af1-4429-4da3-807d-da6a7ade43a0/screenshots');

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
    const port = 9333;
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

        const captures = [
            {
                name: 'desktop-main-1440x900',
                width: 1440,
                height: 900,
                setup: async () => {
                    await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
                    await delay(1000);
                }
            },
            {
                name: 'tablet-main-768x1024',
                width: 768,
                height: 1024,
                setup: async () => {
                    await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
                    await delay(800);
                }
            },
            {
                name: 'mobile-main-375x812',
                width: 375,
                height: 812,
                setup: async () => {
                    await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
                    await delay(800);
                }
            },
            {
                name: 'workflow-download-ready-1440x900',
                width: 1440,
                height: 900,
                setup: async () => {
                    await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
                    await delay(800);
                    // Simulate inputting URL and entering successful download ready state
                    await send('Runtime.evaluate', {
                        expression: `
                            (function() {
                                const urlIn = document.getElementById('url');
                                if (urlIn) urlIn.value = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
                                const consent = document.getElementById('consent');
                                if (consent) consent.checked = true;
                                const preview = document.getElementById('preview');
                                if (preview) {
                                    preview.src = '/api/media/med_sample';
                                    preview.classList.remove('hidden');
                                    preview.style.display = 'block';
                                }
                                const dlBtn = document.getElementById('download');
                                if (dlBtn) {
                                    dlBtn.classList.remove('hidden');
                                    dlBtn.style.display = 'inline-flex';
                                }
                                const log = document.getElementById('log');
                                if (log) {
                                    log.textContent = '✅ Video ready for download! MP4 format verified.';
                                    log.style.color = 'var(--status-success)';
                                }
                            })();
                        `
                    });
                    await delay(400);
                }
            },
            {
                name: 'workflow-embed-fallback-1440x900',
                width: 1440,
                height: 900,
                setup: async () => {
                    await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
                    await delay(800);
                    // Simulate platform restricted official embed fallback
                    await send('Runtime.evaluate', {
                        expression: `
                            (function() {
                                const urlIn = document.getElementById('url');
                                if (urlIn) urlIn.value = 'https://www.tiktok.com/@scout2015/video/7106594312292453678';
                                const embedContainer = document.getElementById('embed-container');
                                if (embedContainer) {
                                    embedContainer.classList.remove('hidden');
                                    embedContainer.style.display = 'flex';
                                    embedContainer.innerHTML = '';
                                    
                                    const badge = document.createElement('div');
                                    badge.className = 'embed-badge';
                                    const tag = document.createElement('span');
                                    tag.className = 'embed-badge-tag';
                                    tag.textContent = 'OFFICIAL EMBED';
                                    badge.appendChild(tag);
                                    badge.appendChild(document.createTextNode('Direct video file downloads are restricted by platform terms. An official embedded player is provided below.'));
                                    embedContainer.appendChild(badge);

                                    const iframe = document.createElement('iframe');
                                    iframe.src = 'https://www.tiktok.com/embed/v2/7106594312292453678';
                                    iframe.title = 'Official TikTok Embed';
                                    iframe.style.width = '100%';
                                    iframe.style.height = '460px';
                                    iframe.style.border = '1px solid var(--border-color)';
                                    iframe.style.borderRadius = 'var(--radius-md)';
                                    iframe.style.background = 'var(--bg-surface)';
                                    embedContainer.appendChild(iframe);
                                }
                                const log = document.getElementById('log');
                                if (log) {
                                    log.textContent = 'ℹ️ Official embedded player loaded. Direct downloads are restricted for this content.';
                                    log.style.color = 'var(--text-secondary)';
                                }
                            })();
                        `
                    });
                    await delay(400);
                }
            },
            {
                name: 'desktop-dark-mode-1440x900',
                width: 1440,
                height: 900,
                setup: async () => {
                    await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
                    await delay(800);
                    await send('Runtime.evaluate', {
                        expression: `document.documentElement.setAttribute('data-theme', 'dark');`
                    });
                    await delay(300);
                }
            }
        ];

        for (const cap of captures) {
            await send('Emulation.setDeviceMetricsOverride', {
                width: cap.width,
                height: cap.height,
                deviceScaleFactor: 1,
                mobile: cap.width < 768
            });
            await cap.setup();
            const res = await send('Page.captureScreenshot', { format: 'png' });
            const filePath = path.join(outDir, `${cap.name}.png`);
            fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
            console.log(`Saved screenshot: ${cap.name}.png (${fs.statSync(filePath).size} bytes)`);
        }

        ws.close();
    } catch (err) {
        console.error('CDP screenshot failed:', err);
    } finally {
        edge.kill();
    }
}

run();
