// scripts/download-fonts.cjs
const https = require('https');
const fs = require('fs');
const path = require('path');

const fontsDir = path.join(__dirname, '..', 'public', 'fonts');
if (!fs.existsSync(fontsDir)) fs.mkdirSync(fontsDir, { recursive: true });

https.get('https://fonts.googleapis.com/css2?family=Urbanist:wght@300;400;500;600&display=swap', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
}, (res) => {
  let css = '';
  res.on('data', c => css += c);
  res.on('end', async () => {
    // Only get latin subset (the last block for each weight)
    const blocks = css.split('@font-face');
    for (const b of blocks) {
      if (!b.includes('font-weight')) continue;
      const weightMatch = b.match(/font-weight:\s*(\d+);/);
      const urlMatch = b.match(/src:\s*url\((https:[^)]+)\)\s*format\('woff2'\);/);
      if (weightMatch && urlMatch && b.includes('U+0000-00FF')) {
        const weight = weightMatch[1];
        const url = urlMatch[1];
        const dest = path.join(fontsDir, `urbanist-${weight}.woff2`);
        await new Promise((resolve, reject) => {
          https.get(url, (fRes) => {
            const fileStream = fs.createWriteStream(dest);
            fRes.pipe(fileStream);
            fileStream.on('finish', () => {
              console.log(`Saved urbanist-${weight}.woff2 (${fs.statSync(dest).size} bytes)`);
              resolve();
            });
          }).on('error', reject);
        });
      }
    }
  });
});
