// server.cjs — Reeva self-hosted backend (multi-platform downloader)
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch"); // v2 for CommonJS
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ================== SECURITY + MIDDLEWARE ==================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use(express.static("public"));
app.use(rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 60,
    message: { error: "Too many requests. Please wait a few minutes and try again." }
}));

// ================== CACHE ==================
const cache = new Map(); // key: url -> { result, expiresAt }
const cacheTTL = 10 * 60 * 1000; // 10 minutes

// ================== LOCAL MODULES ==================
let localModules = {};
try { localModules.instagram = require("@sasmeee/igdl"); } catch (e) { }
try { localModules.instagramAlt = require("instagram-url-direct"); } catch (e) { }
try { localModules.twitter = require("twitter-downloader"); } catch (e) { }
try { localModules.pinterest = require("pinterest-dl"); } catch (e) { }
try { localModules.universal = require("@totallynodavid/downloader"); } catch (e) { }

console.log("Loaded modules:", Object.keys(localModules));

// ================== BASIC UTILITIES ==================
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPage(url) {
    const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (ReevaBot)" }
    });
    if (!resp.ok) throw new Error(`Failed to load page (${resp.status})`);
    return await resp.text();
}

function extractFromMeta(html) {
    const match = html.match(/<meta property="og:video" content="([^"]+)"/i);
    if (match && match[1]) return match[1];
    return null;
}
function extractMediaFromHtml(html) {
    const decode = s => s?.replace(/\\"/g, '"').replace(/\\u0026/g, "&");

    // Try multiple patterns — order matters
    const patterns = [
        /"video_versions":\[\{"url":"([^"]+)"/i,
        /"video_url"\s*:\s*"([^"]+)"/i,
        /"url"\s*:\s*"([^"]+\.mp4)"/i,
        /"src"\s*:\s*"([^"]+\.mp4)"/i,
        /"contentUrl"\s*:\s*"([^"]+)"/i,
        /"playbackUrl"\s*:\s*"([^"]+)"/i,
        /"display_resources":\[\{"src":"([^"]+)"/i,
        /"display_url"\s*:\s*"([^"]+)"/i,
        /<meta property="og:video" content="([^"]+)"/i,
        /<meta property="og:image" content="([^"]+)"/i
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
            const url = decode(match[1]);
            const type = url.includes(".mp4") ? "video" : "image";
            return { url, type };
        }
    }

    return null;
}


// ================== PLATFORM HANDLERS ==================

// --- Instagram ---
async function getInstagramMedia(url) {
    if (!/instagram\.com/i.test(url)) throw new Error("Please enter a valid Instagram link.");

    const cached = cache.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    // Try @sasmeee/igdl
    try {
        const result = await localModules.instagram(url);
        if (result?.url) {
            const res = { url: result.url, type: "video" };
            cache.set(url, { result: res, expiresAt: Date.now() + cacheTTL });
            return res;
        }
    } catch (e) { console.warn("IGDL failed:", e.message); }

    // Try instagram-url-direct
    try {
        const result = await localModules.instagramAlt(url);
        if (result && result.url_list && result.url_list.length) {
            const res = { url: result.url_list[0], type: "video" };
            cache.set(url, { result: res, expiresAt: Date.now() + cacheTTL });
            return res;
        }
    } catch (e) { console.warn("instagram-url-direct failed:", e.message); }

    // HTML fallback
    try {
        const html = await fetchPage(url);
        const match = html.match(/"video_url":"([^"]+)"/);
        if (match && match[1]) {
            const res = { url: match[1].replace(/\\u0026/g, "&"), type: "video" };
            cache.set(url, { result: res, expiresAt: Date.now() + cacheTTL });
            return res;
        }
    } catch (e) { console.warn("Instagram HTML fallback failed:", e.message); }

    throw new Error("Reeva couldn’t find a downloadable video. Make sure the post is public.");
}

// --- Facebook (public only) ---
async function getFacebookMedia(url) {
    if (!/facebook\.com|fb\.watch/i.test(url)) throw new Error("Please enter a valid Facebook link.");

    const cached = cache.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    // Try universal downloader
    if (localModules.universal) {
        try {
            const out = await localModules.universal(url);
            const vid = out?.url || out?.video || out?.downloadUrl;
            if (vid) {
                const res = { url: vid, type: "video" };
                cache.set(url, { result: res, expiresAt: Date.now() + cacheTTL });
                return res;
            }
        } catch (e) { console.warn("Universal FB module failed:", e.message); }
    }

    // HTML fallback
    try {
        const html = await fetchPage(url);
        const meta = extractFromMeta(html);
        if (meta) {
            const res = { url: meta, type: "video" };
            cache.set(url, { result: res, expiresAt: Date.now() + cacheTTL });
            return res;
        }
    } catch (e) { console.warn("Facebook meta extraction failed:", e.message); }

    throw new Error("This Facebook video seems private or unavailable. Only public videos can be downloaded.");
}

// --- Twitter/X ---
async function getTwitterMedia(url) {
    if (!/twitter\.com|x\.com/i.test(url)) throw new Error("Please enter a valid Twitter (X) link.");

    const cached = cache.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    try {
        const result = await localModules.twitter(url);
        const vid = result?.download?.[0]?.url || result?.url;
        if (vid) {
            const res = { url: vid, type: "video" };
            cache.set(url, { result: res, expiresAt: Date.now() + cacheTTL });
            return res;
        }
    } catch (e) { console.warn("Twitter module failed:", e.message); }

    throw new Error("Reeva couldn’t find a playable video. Make sure the tweet is public and contains a video.");
}

// --- Pinterest ---
async function getPinterestMedia(url) {
    console.log("🕵️‍♂️ [Pinterest] Starting extraction for:", url);

    // 🟢 STEP 1 — Handle short links like https://pin.it/abcd1234
    if (/pin\.it/i.test(url)) {
        try {
            const resp = await fetch(url, { redirect: "manual" });
            const redirected = resp.headers.get("location");
            if (redirected && /pinterest\.com/i.test(redirected)) {
                console.log(`🔗 Resolved short link → ${redirected}`);
                url = redirected; // update URL for the rest of the process
            } else {
                throw new Error("Could not expand the Pinterest short link.");
            }
        } catch (e) {
            console.warn("⚠️ Pinterest short link resolver failed:", e.message);
            throw new Error("Reeva couldn’t open this Pinterest link. Try opening it once in your browser.");
        }
    }

    // 🟢 STEP 2 — Validate AFTER resolving
    if (!/pinterest\.com/i.test(url))
        throw new Error("❌ Please enter a valid Pinterest link from pinterest.com");

    // 🟢 STEP 3 — Cache check
    const cached = cache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
        console.log("📦 Returning cached Pinterest result");
        return cached.result;
    }

    // 🟢 STEP 4 — Try local module (pinterest-dl)
    try {
        const result = await localModules.pinterest(url);
        const pin = result?.url || result?.[0]?.url;
        if (pin) {
            const res = { url: pin, type: pin.endsWith(".mp4") ? "video" : "image" };
            cache.set(url, { result: res, expiresAt: Date.now() + 10 * 60 * 1000 });
            console.log("✅ Pinterest media found via local module:", res.url);
            return res;
        }
    } catch (e) {
        console.warn("⚠️ Pinterest module failed:", e.message);
    }

    // 🟢 STEP 5 — Try HTML extraction as fallback
    try {
        const html = await fetchPage(url);
        const extracted = extractMediaFromHtml(html);
        if (extracted && extracted.url) {
            const res = { url: extracted.url, type: extracted.type };
            cache.set(url, { result: res, expiresAt: Date.now() + 10 * 60 * 1000 });
            console.log("✅ Pinterest media found via HTML fallback:", res.url);
            return res;
        }
    } catch (e) {
        console.warn("⚠️ Pinterest HTML extraction failed:", e.message);
    }

    // 🟢 STEP 6 — All attempts failed
    throw new Error("❌ Reeva couldn’t find any downloadable media for this Pinterest post. Please make sure it’s public and has a visible image or video.");
}
// --- WhatsApp ---
async function getWhatsAppMedia() {
    throw new Error("WhatsApp statuses are private. Reeva cannot download them for privacy reasons.");
}

// ================== MAIN DOWNLOAD ROUTE ==================
app.get("/api/download/:platform", async (req, res) => {
    try {
        const { platform } = req.params;
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: "Please paste a link first." });

        let result;
        switch (platform.toLowerCase()) {
            case "instagram": result = await getInstagramMedia(url); break;
            case "facebook": result = await getFacebookMedia(url); break;
            case "twitter":
            case "x": result = await getTwitterMedia(url); break;
            case "pinterest": result = await getPinterestMedia(url); break;
            case "whatsapp": return res.status(501).json({ error: "WhatsApp download is not available." });
            default: return res.status(400).json({ error: "This platform is not supported yet." });
        }

        if (!result || !result.url) {
            console.warn(`⚠️ No media found for ${platform} → ${url}`);
            return res.status(404).json({
                error: `❌ Reeva couldn’t find a downloadable media for this ${platform} post.
Make sure it's public and contains a video or image.`
            });
        }
        res.json({ videoUrl: result.url, mediaType: result.type || "unknown" });
    } catch (err) {
        console.error("❌ Download error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ================== PROXY ENDPOINT ==================
app.get("/api/proxy", async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).send("Missing media URL.");

        const proxied = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.instagram.com/" }
        });
        if (!proxied.ok) return res.status(502).send("Could not fetch media from source.");

        res.setHeader("Content-Type", proxied.headers.get("content-type") || "application/octet-stream");
        res.setHeader("Content-Disposition", 'attachment; filename="media"');
        proxied.body.pipe(res);
    } catch (err) {
        console.error("Proxy error:", err.message);
        res.status(500).send("An error occurred while fetching the video.");
    }
});

// ================== START SERVER ==================
app.listen(PORT, () => {
    console.log(`✅ Reeva backend is live at http://localhost:${PORT}`);
    console.log("🧩 Active modules:", Object.keys(localModules).filter(k => localModules[k]));
});
