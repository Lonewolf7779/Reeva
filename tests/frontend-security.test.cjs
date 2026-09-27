// tests/frontend-security.test.cjs — Automated Tests for Frontend Security & Injection Risks
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("Frontend Security: index.html has no inline scripts or inline event handlers", () => {
    const htmlPath = path.join(__dirname, "../public/index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Must not have inline <script> blocks (only external script src)
    const inlineScriptMatch = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/i);
    assert.equal(
        inlineScriptMatch,
        null,
        "index.html must not contain inline <script> blocks to ensure strict CSP compliance"
    );

    // Must not contain inline event handlers like onclick, onload, onerror
    const inlineHandlerMatch = html.match(/\son[a-zA-Z]+\s*=\s*["'][^"']*["']/i);
    assert.equal(
        inlineHandlerMatch,
        null,
        "index.html must not contain inline DOM event handlers"
    );
});

test("Frontend Security: app.js avoids unsafe innerHTML sinks for API feedback", () => {
    const jsPath = path.join(__dirname, "../public/app.js");
    const js = fs.readFileSync(jsPath, "utf8");

    // Check that innerHTML is not used
    const innerHtmlMatch = js.match(/\.innerHTML\s*=/);
    assert.equal(
        innerHtmlMatch,
        null,
        "app.js must not assign to innerHTML; textContent must be used for untrusted data"
    );
});
