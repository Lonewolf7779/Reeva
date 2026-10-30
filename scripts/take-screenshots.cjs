// scripts/take-screenshots.cjs
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outDir = path.resolve('C:/Users/SantoshPrajapati-Tec/.gemini/antigravity/brain/bd266af1-4429-4da3-807d-da6a7ade43a0/screenshots');

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

const viewports = [
    { name: 'desktop-1440x900', w: 1440, h: 900 },
    { name: 'tablet-768x1024', w: 768, h: 1024 },
    { name: 'mobile-375x812', w: 375, h: 812 },
    { name: 'mobile-430x932', w: 430, h: 932 }
];

for (const vp of viewports) {
    const dest = path.join(outDir, `${vp.name}.png`);
    const cmd = `"${edgePath}" --headless --disable-gpu --screenshot="${dest}" --window-size=${vp.w},${vp.h} "http://127.0.0.1:3000"`;
    try {
        execSync(cmd, { stdio: 'pipe' });
        const stats = fs.statSync(dest);
        console.log(`Captured ${vp.name}: ${stats.size} bytes -> ${dest}`);
    } catch (e) {
        console.error(`Error capturing ${vp.name}:`, e.message);
    }
}
