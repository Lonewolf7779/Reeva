// server.cjs — Reeva self-hosted backend (multi-platform downloader)
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch"); // v2 for CommonJS
const ytdl = require("ytdl-core");
const ytdl_exec = require("@distube/ytdl-core"); // backup parser
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
    console.log("🕵️‍♂️ [Instagram] Starting extraction for:", url);

    if (!/instagram\.com/i.test(url))
        throw new Error("❌ Please enter a valid Instagram link.");

    // 🟢 Cache check
    const cached = cache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
        console.log("📦 Returning cached Instagram result");
        return cached.result;
    }

    // 🟢 Try local module first (igdl or instagram-url-direct)
    try {
        if (localModules.instagramAlt) {
            const result = await localModules.instagramAlt(url);
            if (result && result.url) {
                const res = { url: result.url, type: "video" };
                cache.set(url, { result: res, expiresAt: Date.now() + 10 * 60 * 1000 });
                console.log("✅ Instagram media found via local module:", res.url);
                return res;
            }
        }
    } catch (e) {
        console.warn("⚠️ Instagram local module failed:", e.message);
    }

    // 🟢 HTML Extraction (new patterns)
    try {
        const html = await fetchPage(url);
        const decode = s => s?.replace(/\\"/g, '"').replace(/\\u0026/g, "&");

        // --- 1️⃣ Look for video_versions JSON ---
        const match1 = html.match(/"video_versions":\[\{"type":[^}]*"url":"([^"]+)"/);
        if (match1 && match1[1]) {
            const link = decode(match1[1]);
            console.log("✅ Found via video_versions pattern:", link);
            const res = { url: link, type: "video" };
            cache.set(url, { result: res, expiresAt: Date.now() + 10 * 60 * 1000 });
            return res;
        }

        // --- 2️⃣ Look for display_resources (images fallback) ---
        const match2 = html.match(/"display_resources":\[\{"src":"([^"]+)"/);
        if (match2 && match2[1]) {
            const link = decode(match2[1]);
            console.log("✅ Found via display_resources pattern:", link);
            const res = { url: link, type: "image" };
            cache.set(url, { result: res, expiresAt: Date.now() + 10 * 60 * 1000 });
            return res;
        }

        // --- 3️⃣ Fallback meta tags ---
        const match3 = html.match(/<meta property="og:video" content="([^"]+)"/);
        if (match3 && match3[1]) {
            const link = decode(match3[1]);
            console.log("✅ Found via og:video meta tag:", link);
            const res = { url: link, type: "video" };
            cache.set(url, { result: res, expiresAt: Date.now() + 10 * 60 * 1000 });
            return res;
        }

        // --- 4️⃣ Last resort (display_url meta) ---
        const match4 = html.match(/<meta property="og:image" content="([^"]+)"/);
        if (match4 && match4[1]) {
            const link = decode(match4[1]);
            console.log("✅ Found via og:image fallback:", link);
            const res = { url: link, type: "image" };
            cache.set(url, { result: res, expiresAt: Date.now() + 10 * 60 * 1000 });
            return res;
        }

        console.warn("⚠️ No media found in HTML for Instagram post.");
    } catch (e) {
        console.warn("⚠️ Instagram HTML extraction failed:", e.message);
    }

    // 🟢 Final fallback
    throw new Error("❌ Reeva couldn’t find any downloadable media for this Instagram post. Please make sure it’s public and contains a visible video or image.");
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

async function getYouTubeMedia(url) {
    if (!/youtube\.com|youtu\.be/i.test(url))
        throw new Error("Please enter a valid YouTube link.");

    console.log("🎥 Fetching YouTube media for:", url);

    try {
        let info;
        try {
            // 🧠 Try standard ytdl-core first
            info = await ytdl.getInfo(url);
        } catch (err) {
            console.warn("⚠️ Primary ytdl-core failed:", err.message);
            console.log("🧩 Trying backup parser...");
            info = await ytdl_exec.getInfo(url);
        }

        if (!info || !info.formats) throw new Error("Could not retrieve video details.");

        console.log("🎬 Title:", info.videoDetails?.title || "Untitled");
        console.log("🧾 Total formats:", info.formats?.length || 0);

        // ✅ Try for MP4 with both audio + video first
        let format =
            info.formats.find(f => f.hasVideo && f.hasAudio && f.container === "mp4") ||
            info.formats.find(f => f.hasVideo && f.container === "mp4") ||
            info.formats.find(f => f.mimeType && f.mimeType.includes("video"));

        if (!format || !format.url) {
            console.warn("⚠️ No valid downloadable format found, showing keys:");
            console.log(Object.keys(info.formats[0] || {}));
            throw new Error("Reeva couldn’t find a downloadable YouTube stream.");
        }

        console.log(`✅ YouTube format chosen: ${format.qualityLabel || "unknown"} (${format.container})`);

        const result = {
            url: format.url,
            type: "video",
            title: info.videoDetails?.title || "Reeva YouTube Video"
        };

        cache.set(url, { result, expiresAt: Date.now() + 10 * 60 * 1000 });
        return result;

    } catch (err) {
        console.error("❌ YouTube fetch failed:", err.message);
        throw new Error("Reeva couldn’t get a video from YouTube. Make sure it’s public and not restricted.");
    }
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
            case "youtube":
                result = await getYouTubeMedia(url);
                break;
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
// ⚔️ Smart Proxy Endpoint — auto-refresh expired Instagram tokens
app.get("/api/proxy", async (req, res) => {
    try {
        const { url, original } = req.query;
        if (!url) return res.status(400).send("Missing URL");

        console.log("🌍 Proxying media:", url);

        // 🧠 Always refresh for Instagram CDN links
        if (/scontent\.cdninstagram\.com/i.test(url) && original) {
            console.log("🔁 Refreshing Instagram token before fetch...");
            const refreshed = await getInstagramMedia(original);
            if (refreshed?.url) {
                console.log("✅ Got fresh Instagram media URL:", refreshed.url);
                return res.redirect(`/api/proxy?url=${encodeURIComponent(refreshed.url)}`);
            } else {
                throw new Error("Could not refresh Instagram video link.");
            }
        }

        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://www.instagram.com/",
                "Origin": "https://www.instagram.com/",
                "Connection": "keep-alive"
            },
            redirect: "follow"
        });

        if (!response.ok) {
            console.error("❌ Proxy fetch failed:", response.status, response.statusText);
            return res.status(502).send(`Could not fetch media from source (HTTP ${response.status}).`);
        }

        if (/googlevideo\.com/i.test(url)) {
            console.log("🎬 Proxying YouTube CDN link...");
            res.setHeader("Content-Disposition", 'inline; filename="reeva_youtube.mp4"');
        } else {
            res.setHeader("Content-Disposition", 'inline; filename="reeva_instagram.mp4"');
        }



        const contentType = response.headers.get("content-type") || "application/octet-stream";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", "inline; filename=reeva_instagram.mp4");
        res.setHeader("Cache-Control", "no-cache");

        response.body.pipe(res);
    } catch (err) {
        console.error("❌ Proxy error:", err.message);
        res.status(500).send("Proxy error — failed to retrieve media stream.");
    }
});


// ================== START SERVER ==================
app.listen(PORT, () => {
    console.log(`✅ Reeva backend is live at http://localhost:${PORT}`);
    console.log("🧩 Active modules:", Object.keys(localModules).filter(k => localModules[k]));
});
