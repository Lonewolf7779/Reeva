// tests/public-website-quality.test.cjs — Phase B Public-Facing Website Quality & Compliance Tests
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const path = require("path");

const app = require("../server.cjs");
const i18nModule = require("../public/js/i18n.js");
const uiModule = require("../public/js/ui.js");

function createTestServer() {
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            resolve({
                port,
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

function fetchUrl(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data
                });
            });
        });
        req.on("error", reject);
    });
}

// =========================================================================
// 1. Static Public Pages HTTP Status & Security Headers
// =========================================================================

test("Public Website Quality: GET /robots.txt returns HTTP 200 with sensible crawl directives", async () => {
    const { port, close } = await createTestServer();
    try {
        const res = await fetchUrl(port, "/robots.txt");
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers["content-type"].includes("text/plain"), "robots.txt must be served as text/plain");
        assert.ok(res.body.includes("User-agent: *"));
        assert.ok(res.body.includes("Allow: /"));
        assert.ok(res.body.includes("Disallow: /api/"));
    } finally {
        await close();
    }
});

test("Public Website Quality: GET /privacy.html returns HTTP 200 with security headers and accurate content", async () => {
    const { port, close } = await createTestServer();
    try {
        const res = await fetchUrl(port, "/privacy.html");
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers["content-type"].includes("text/html"));
        assert.strictEqual(res.headers["x-frame-options"], "DENY");
        assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
        assert.ok(res.headers["content-security-policy"]);

        // Content checks
        assert.ok(res.body.includes("<title>Privacy Policy — Reeva</title>"));
        assert.ok(res.body.includes("Privacy Policy"));
        assert.ok(res.body.includes("Submitted URLs"));
        assert.ok(res.body.includes("No User Accounts"));
        assert.ok(res.body.includes("Ephemeral Scratch Storage"));
        assert.ok(res.body.includes("REEVA_TEMP_DIR"));
        assert.ok(res.body.includes("In-Memory Caching"));
        assert.ok(res.body.includes("Rate Limiting"));
        assert.ok(res.body.includes("Information Requiring Operator Confirmation"));
        assert.ok(res.body.includes("Deployment Operator Contact"));
    } finally {
        await close();
    }
});

test("Public Website Quality: GET /terms.html returns HTTP 200 with security headers and legal disclosures", async () => {
    const { port, close } = await createTestServer();
    try {
        const res = await fetchUrl(port, "/terms.html");
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers["content-type"].includes("text/html"));
        assert.strictEqual(res.headers["x-frame-options"], "DENY");
        assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
        assert.ok(res.headers["content-security-policy"]);

        // Content checks
        assert.ok(res.body.includes("<title>Terms of Service — Reeva</title>"));
        assert.ok(res.body.includes("Terms of Service"));
        assert.ok(res.body.includes("Authorized Use and User Representations"));
        assert.ok(res.body.includes("Compliance with Third-Party Platform Rules"));
        assert.ok(res.body.includes("Intellectual Property and Content Ownership"));
        assert.ok(res.body.includes("Prohibited Misuse"));
        assert.ok(res.body.includes("Copyright Complaints and Content Removal"));
        assert.ok(res.body.includes("Disclaimer of Warranties"));
        assert.ok(res.body.includes("Operator Identification & Governing Law"));
    } finally {
        await close();
    }
});

test("Public Website Quality: GET /favicon.svg returns HTTP 200 with valid SVG vector icon", async () => {
    const { port, close } = await createTestServer();
    try {
        const res = await fetchUrl(port, "/favicon.svg");
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers["content-type"].includes("image/svg+xml"));
        assert.ok(res.body.includes("<svg"));
        assert.ok(res.body.includes("viewBox="));
    } finally {
        await close();
    }
});

// =========================================================================
// 2. Frontend Security & CSP Compliance of New Pages
// =========================================================================

test("Public Website Quality: privacy.html and terms.html contain zero inline scripts or inline styles", () => {
    const publicPages = ["public/privacy.html", "public/terms.html"];

    for (const relPath of publicPages) {
        const fullPath = path.join(__dirname, "..", relPath);
        assert.ok(fs.existsSync(fullPath), `${relPath} must exist`);
        const html = fs.readFileSync(fullPath, "utf8");

        // Zero inline scripts
        const inlineScriptMatch = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/i);
        assert.strictEqual(
            inlineScriptMatch,
            null,
            `${relPath} must not contain inline <script> blocks to ensure strict CSP compliance`
        );

        // Zero inline event handlers
        const inlineHandlerMatch = html.match(/\son[a-zA-Z]+\s*=\s*["'][^"']*["']/i);
        assert.strictEqual(
            inlineHandlerMatch,
            null,
            `${relPath} must not contain inline DOM event handlers`
        );

        // Zero inline style attributes
        const inlineStyleMatch = html.match(/\sstyle\s*=\s*["'][^"']*["']/i);
        assert.strictEqual(
            inlineStyleMatch,
            null,
            `${relPath} must not contain inline style attributes; all styling belongs in styles.css`
        );
    }
});

// =========================================================================
// 3. SEO Metadata & Asset Link Integrity
// =========================================================================

test("Public Website Quality: index.html has complete SEO, social metadata, and valid local asset links", () => {
    const htmlPath = path.join(__dirname, "../public/index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Title & description
    assert.ok(html.includes("<title>Reeva — Universal Reel Downloader</title>"));
    assert.ok(html.includes('name="description"'));
    assert.ok(html.includes('name="theme-color" content="#0e0e10"'));

    // OpenGraph & Twitter cards
    assert.ok(html.includes('property="og:title"'));
    assert.ok(html.includes('property="og:description"'));
    assert.ok(html.includes('property="og:type" content="website"'));
    assert.ok(html.includes('name="twitter:card" content="summary"'));
    assert.ok(html.includes('name="twitter:title"'));
    assert.ok(html.includes('name="twitter:description"'));

    // Favicon link
    assert.ok(html.includes('rel="icon" type="image/svg+xml" href="/favicon.svg"'));

    // Canonical link must NOT be invented without a known production domain
    assert.strictEqual(
        html.includes('rel="canonical"'),
        false,
        "Canonical URL must not be hardcoded to an invented domain"
    );

    // Verify all local referenced assets exist in public/
    const assetMatches = [...html.matchAll(/(?:href|src)=["']\/([^"'#?]+)["']/g)].map((m) => m[1]);
    for (const asset of assetMatches) {
        const assetPath = path.join(__dirname, "../public", asset);
        assert.ok(fs.existsSync(assetPath), `Referenced asset /${asset} must exist in public/ directory`);
    }
});

// =========================================================================
// 4. Footer Discoverability & Multilingual Translation
// =========================================================================

test("Public Website Quality: Footer links are discoverable and translate dynamically between EN and HI", () => {
    const htmlPath = path.join(__dirname, "../public/index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Links exist in HTML
    assert.ok(html.includes('id="link-privacy"'));
    assert.ok(html.includes('id="link-terms"'));
    assert.ok(html.includes('href="/privacy.html"'));
    assert.ok(html.includes('href="/terms.html"'));

    // Translation keys exist in both English and Hindi
    assert.strictEqual(i18nModule.t("footer.privacy", {}, "en"), "Privacy Policy");
    assert.strictEqual(i18nModule.t("footer.terms", {}, "en"), "Terms of Service");
    assert.strictEqual(i18nModule.t("footer.privacy", {}, "hi"), "गोपनीयता नीति");
    assert.strictEqual(i18nModule.t("footer.terms", {}, "hi"), "सेवा की शर्तें");

    // Mock DOM translation verification
    function createMockEl(id, text = "") {
        return {
            id,
            textContent: text,
            style: {},
            classList: { add: () => {}, remove: () => {}, contains: () => false },
            setAttribute: () => {},
            removeAttribute: () => {},
            getAttribute: () => null
        };
    }

    const mockDoc = {
        documentElement: { lang: "en", dir: "ltr" },
        title: "",
        getElementById: (id) => {
            if (id === "link-privacy") return linkPrivacyEl;
            if (id === "link-terms") return linkTermsEl;
            if (id === "footer-disclaimer") return footerDisclaimerEl;
            if (id === "footer-copyright") return footerCopyrightEl;
            return null;
        },
        querySelectorAll: () => []
    };

    const linkPrivacyEl = createMockEl("link-privacy", "Privacy Policy");
    const linkTermsEl = createMockEl("link-terms", "Terms of Service");
    const footerDisclaimerEl = createMockEl("footer-disclaimer");
    const footerCopyrightEl = createMockEl("footer-copyright");

    const ui = uiModule.createUiController(mockDoc);
    assert.ok(ui);

    // Apply Hindi
    ui.applyTranslations("hi", i18nModule.t, i18nModule.getLanguageDirection);
    assert.strictEqual(linkPrivacyEl.textContent, "गोपनीयता नीति");
    assert.strictEqual(linkTermsEl.textContent, "सेवा की शर्तें");

    // Apply English
    ui.applyTranslations("en", i18nModule.t, i18nModule.getLanguageDirection);
    assert.strictEqual(linkPrivacyEl.textContent, "Privacy Policy");
    assert.strictEqual(linkTermsEl.textContent, "Terms of Service");
});
