const fs = require('fs');
const path = require('path');

const publicDir = path.resolve('public');
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

let violations = 0;
for (const file of files) {
    const content = fs.readFileSync(path.join(publicDir, file), 'utf8');
    const inlineScripts = content.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi);
    const inlineStyles = content.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    const inlineEvents = content.match(/\son[a-z]+\s*=/gi);

    if (inlineScripts) {
        console.error(`Violation in ${file}: inline <script> found:`, inlineScripts);
        violations++;
    }
    if (inlineStyles) {
        console.error(`Violation in ${file}: inline <style> found:`, inlineStyles);
        violations++;
    }
    if (inlineEvents) {
        console.error(`Violation in ${file}: inline event handlers found:`, inlineEvents);
        violations++;
    }
}

if (violations === 0) {
    console.log(`CSP AUDIT PASSED: All ${files.length} HTML files have 0 inline scripts, 0 inline styles, and 0 inline event handlers.`);
} else {
    process.exit(1);
}
