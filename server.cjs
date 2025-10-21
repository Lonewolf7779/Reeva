// server.cjs
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const fetch = require("node-fetch");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;

// Basic checks
if (!RAPIDAPI_KEY || !RAPIDAPI_HOST) {
    console.warn("Warning: RAPIDAPI_KEY or RAPIDAPI_HOST is not set. Set them in .env before running.");
}

// Security + logging
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use(express.static("public"));

// Rate limiter (adjust if needed)
const limiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 30,
    message: { error: "Too many requests — try again later." }
});
app.use(limiter);

// Simple in-memory cache (for demo). Use Redis for production.
const cache = new Map(); // key: url -> { videoUrl, expiresAt }

// Helper: call RapidAPI provider
async function callUpstream(urlToDownload) {
    if (!RAPIDAPI_KEY || !RAPIDAPI_HOST) {
        throw new Error("Server not configured with RAPIDAPI_KEY / RAPIDAPI_HOST");
    }

    const apiUrl = `https://${RAPIDAPI_HOST}/download?url=${encodeURIComponent(urlToDownload)}`;

    const resp = await fetch(apiUrl, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "X-RapidAPI-Key": RAPIDAPI_KEY,
            "X-RapidAPI-Host": RAPIDAPI_HOST
        },
        timeout: 20000
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const err = new Error(`Upstream returned ${resp.status}: ${text}`);
        err.raw = text;
        err.status = resp.status;
        throw err;
    }

    const data = await resp.json().catch(() => null);
    return data;
}

// Endpoint: get video URL
app.get("/api/get-video", async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: "Missing url parameter." });
        if (!/instagram\.com/i.test(url))
            return res.status(400).json({ error: "Only Instagram URLs are allowed." });

        // Cache check
        const cached = cache.get(url);
        if (cached && cached.expiresAt > Date.now()) {
            return res.json({ videoUrl: cached.videoUrl, source: "cache" });
        }

        // Build request to the new API
        const apiUrl = `https://${RAPIDAPI_HOST}/convert?url=${encodeURIComponent(url)}`;

        const response = await fetch(apiUrl, {
            method: "GET",
            headers: {
                "X-RapidAPI-Key": RAPIDAPI_KEY,
                "X-RapidAPI-Host": RAPIDAPI_HOST
            },
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Upstream returned ${response.status}: ${errText}`);
        }

        const data = await response.json();
        console.log("📦 Upstream response:", data);

        if (!data.media || !data.media.length) {
            return res.status(404).json({ error: "No media found for this link." });
        }

        // Prefer the first video; fallback to image if video missing
        let videoObj = data.media.find((m) => m.type === "video") || data.media[0];
        const videoUrl = videoObj.url;

        if (!videoUrl) {
            return res.status(502).json({ error: "Video URL not found in response." });
        }

        // Cache result
        cache.set(url, { videoUrl, expiresAt: Date.now() + 10 * 60 * 1000 });

        return res.json({ videoUrl, source: "upstream" });
    } catch (err) {
        console.error("Error in /api/get-video:", err);
        return res.status(500).json({ error: "Server error: " + err.message });
    }
});


// Proxy endpoint to stream the video to the client (avoids CORS and hides upstream)
app.get("/api/proxy", async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).send("Missing url");

        const proxied = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.instagram.com/" }
        });

        if (!proxied.ok) return res.status(502).send("Failed to fetch remote video");

        res.setHeader("Content-Type", proxied.headers.get("content-type") || "application/octet-stream");
        res.setHeader("Content-Disposition", 'attachment; filename="reel.mp4"');
        proxied.body.pipe(res);
    } catch (err) {
        console.error("Proxy error:", err);
        res.status(500).send("Proxy error");
    }
});

app.listen(PORT, () => {
    console.log(`✅ IG Reel downloader running on http://localhost:${PORT}`);
});
