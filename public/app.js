// public/app.js — Frontend client logic for Reeva
"use strict";

document.addEventListener("DOMContentLoaded", () => {
    const getBtn = document.getElementById("get");
    const downloadBtn = document.getElementById("download");
    const urlIn = document.getElementById("url");
    const log = document.getElementById("log");
    const preview = document.getElementById("preview");
    const consent = document.getElementById("consent");
    const whyConsent = document.getElementById("why-consent");
    const platformBtns = document.querySelectorAll(".platform-btn");

    let currentPlatform = "instagram";
    let activeDownloadUrl = "";

    // Platform selection
    platformBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            platformBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentPlatform = btn.dataset.platform;
            log.style.color = "var(--muted)";
            log.textContent = `Selected platform: ${btn.textContent.trim()}`;
        });
    });

    // Consent "Why?" explanation
    if (whyConsent) {
        whyConsent.addEventListener("click", (e) => {
            e.preventDefault();
            alert("Reeva is intended only for public content or content you own or have permission to download.");
        });
    }

    // Media fetch handler
    getBtn.addEventListener("click", async () => {
        const u = urlIn.value.trim();

        if (!consent.checked) {
            alert("Please check the confirmation box before downloading.");
            return;
        }

        if (!u) {
            log.style.color = "var(--error)";
            log.textContent = "⚠️ Please paste a video link first.";
            return;
        }

        log.style.color = "var(--muted)";
        log.textContent = "Fetching video... please wait.";
        preview.style.display = "none";
        preview.removeAttribute("src");
        downloadBtn.style.display = "none";
        activeDownloadUrl = "";

        try {
            const endpoint = `/api/download/${encodeURIComponent(currentPlatform)}?url=${encodeURIComponent(u)}`;
            const resp = await fetch(endpoint, {
                headers: { "Accept": "application/json" }
            });
            const data = await resp.json();

            if (!resp.ok) {
                const errMsg = data?.error?.message || data?.error || "Failed to retrieve media. Please try again.";
                log.style.color = "var(--error)";
                log.textContent = `❌ ${errMsg}`;
                return;
            }

            // Support both new secure media format and fallback
            const streamUrl = data.streamUrl || data.videoUrl;
            activeDownloadUrl = data.downloadUrl || streamUrl;

            if (!streamUrl) {
                log.style.color = "var(--error)";
                log.textContent = "⚠️ Could not find a downloadable video for this link.";
                return;
            }

            log.style.color = "var(--success)";
            log.textContent = "✅ Video found! Click \"Download\" below.";
            preview.src = streamUrl;
            preview.style.display = "block";
            downloadBtn.style.display = "inline-block";

        } catch (e) {
            log.style.color = "var(--error)";
            log.textContent = "⚠️ Network error: " + e.message;
        }
    });

    // Download action
    downloadBtn.addEventListener("click", () => {
        if (!activeDownloadUrl) return;
        window.open(activeDownloadUrl, "_blank", "noopener,noreferrer");
    });
});
