// tests/embed-providers.test.cjs — Automated Tests for Official Sandboxed Embeds
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { URL } = require("url");

const app = require("../server.cjs");
const {
    SUPPORTED_EMBED_PLATFORMS,
    resolveEmbed,
    EmbedError,
    EMBED_ERROR_CODES,
    escapeHtml,
    buildSandboxedIframe
} = require("../lib/embed/index.cjs");
const { extractTikTokVideoId, resolveTikTokEmbed } = require("../lib/embed/providers/tiktok.cjs");
const { extractInstagramShortcode, resolveInstagramEmbed } = require("../lib/embed/providers/instagram.cjs");
const { inspectFacebookUrl, resolveFacebookEmbed } = require("../lib/embed/providers/facebook.cjs");

function makeRequest(server, path) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        http.get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                let body;
                try {
                    body = JSON.parse(data);
                } catch {
                    body = data;
                }
                resolve({ status: res.statusCode, headers: res.headers, body });
            });
        }).on("error", reject);
    });
}

// -------------------------------------------------------------
// 1. Sandboxing & HTML Escaping Security
// -------------------------------------------------------------

test("Embed Security: escapeHtml correctly neutralizes HTML injection vectors", () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    assert.equal(escapeHtml("Tom & Jerry's"), "Tom &amp; Jerry&#39;s");
    assert.equal(escapeHtml('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
});

test("Embed Security: buildSandboxedIframe enforces restrictive sandbox and attributes", () => {
    const iframe = buildSandboxedIframe("https://www.tiktok.com/embed/v2/7106594312292453678", {
        title: "Test <Video> & Player"
    });

    assert.ok(iframe.includes('sandbox="allow-scripts allow-same-origin allow-popups"'), "Strict sandbox must be set");
    assert.ok(!iframe.includes("allow-top-navigation"), "Top navigation must NOT be allowed");
    assert.ok(!iframe.includes("allow-modals"), "Modals must NOT be allowed");
    assert.ok(!iframe.includes("allow-forms"), "Forms must NOT be allowed");
    assert.ok(iframe.includes('title="Test &lt;Video&gt; &amp; Player"'), "Title must be escaped");
    assert.ok(iframe.includes('loading="lazy"'), "Lazy loading must be enforced");
});

// -------------------------------------------------------------
// 2. TikTok Provider
// -------------------------------------------------------------

test("TikTok Embed: Extracts video ID from canonical video URLs", () => {
    const id = extractTikTokVideoId("https://www.tiktok.com/@tiktok/video/7106594312292453678?is_from_webapp=1");
    assert.equal(id, "7106594312292453678");

    const idV = extractTikTokVideoId("https://m.tiktok.com/v/7106594312292453678.html");
    assert.equal(idV, "7106594312292453678");

    const invalid = extractTikTokVideoId("https://www.tiktok.com/@tiktok");
    assert.equal(invalid, null);
});

test("TikTok Embed: Resolves embed object with downloadSupported=false and sandboxed iframe", async () => {
    const result = await resolveTikTokEmbed("https://www.tiktok.com/@tiktok/video/7106594312292453678");

    assert.equal(result.platform, "tiktok");
    assert.equal(result.type, "embed");
    assert.equal(result.downloadSupported, false, "Must clearly indicate downloads are not supported");
    assert.equal(result.videoId, "7106594312292453678");
    assert.equal(result.embedUrl, "https://www.tiktok.com/embed/v2/7106594312292453678");
    assert.ok(result.iframeHtml.includes('src="https://www.tiktok.com/embed/v2/7106594312292453678"'));
    assert.ok(result.notice.includes("restricted by platform terms"));
});

test("TikTok Embed: Resolves short links securely and rejects malformed short links", async () => {
    // Mock fetch for short link redirect
    const mockFetch = async (url) => {
        if (url.includes("vm.tiktok.com/ZM8x")) {
            return {
                finalUrl: "https://www.tiktok.com/@user/video/7106594312292453678",
                clearTimeout: () => {}
            };
        }
        const err = new Error("Not Found");
        err.statusCode = 404;
        throw err;
    };

    const res = await resolveTikTokEmbed("https://vm.tiktok.com/ZM8x", { fetch: mockFetch });
    assert.equal(res.videoId, "7106594312292453678");

    await assert.rejects(
        () => resolveTikTokEmbed("https://vm.tiktok.com/deletedLink", { fetch: mockFetch }),
        (err) => {
            assert.equal(err.code, EMBED_ERROR_CODES.EMBED_NOT_FOUND);
            assert.equal(err.statusCode, 404);
            return true;
        }
    );
});

// -------------------------------------------------------------
// 3. Instagram Provider
// -------------------------------------------------------------

test("Instagram Embed: Extracts shortcodes from posts, reels, and IGTV", () => {
    assert.equal(extractInstagramShortcode("https://www.instagram.com/p/Cx123456789/"), "Cx123456789");
    assert.equal(extractInstagramShortcode("https://www.instagram.com/reel/C-abc_123/?igsh=xyz"), "C-abc_123");
    assert.equal(extractInstagramShortcode("https://www.instagram.com/tv/B_def-456/"), "B_def-456");
    assert.equal(extractInstagramShortcode("https://www.instagram.com/username/"), null);
});

test("Instagram Embed: Resolves embed object with downloadSupported=false and official iframe", async () => {
    const result = await resolveInstagramEmbed("https://www.instagram.com/reel/C-abc_123/");

    assert.equal(result.platform, "instagram");
    assert.equal(result.type, "embed");
    assert.equal(result.downloadSupported, false);
    assert.equal(result.shortcode, "C-abc_123");
    assert.equal(result.embedUrl, "https://www.instagram.com/p/C-abc_123/embed/");
    assert.ok(result.iframeHtml.includes('src="https://www.instagram.com/p/C-abc_123/embed/"'));
});

// -------------------------------------------------------------
// 4. Facebook Provider
// -------------------------------------------------------------

test("Facebook Embed: Inspects Watch, video, and Reel paths", () => {
    const watch = inspectFacebookUrl("https://www.facebook.com/watch/?v=10153231379946729");
    assert.equal(watch.videoId, "10153231379946729");
    assert.equal(watch.isWatch, true);

    const reel = inspectFacebookUrl("https://www.facebook.com/reel/123456789012345");
    assert.equal(reel.videoId, "123456789012345");
    assert.equal(reel.isReel, true);

    const userVideo = inspectFacebookUrl("https://www.facebook.com/bbcnews/videos/9876543210/");
    assert.equal(userVideo.videoId, "9876543210");

    const nonVideo = inspectFacebookUrl("https://www.facebook.com/someuser");
    assert.equal(nonVideo, null);

    const groupUrl = inspectFacebookUrl("https://www.facebook.com/groups/12345678/");
    assert.equal(groupUrl, null);
});

test("Facebook Embed: Rejects non-video URLs with INVALID_URL", async () => {
    await assert.rejects(
        () => resolveFacebookEmbed("https://www.facebook.com/someuser"),
        (err) => {
            assert.equal(err.code, EMBED_ERROR_CODES.INVALID_URL);
            assert.equal(err.statusCode, 400);
            return true;
        }
    );
});

test("Facebook Embed: Resolves embed object with official video player plugin", async () => {
    const target = "https://www.facebook.com/watch/?v=10153231379946729";
    const result = await resolveFacebookEmbed(target);

    assert.equal(result.platform, "facebook");
    assert.equal(result.type, "embed");
    assert.equal(result.downloadSupported, false);
    assert.equal(result.videoId, "10153231379946729");
    assert.ok(result.embedUrl.startsWith("https://www.facebook.com/plugins/video.php"));
    assert.ok(result.embedUrl.includes(encodeURIComponent(target)));
    assert.ok(result.iframeHtml.includes("facebook.com/plugins/video.php"));
});

test("Facebook Embed: Resolves fb.watch short links safely", async () => {
    const mockFetch = async () => ({
        finalUrl: "https://www.facebook.com/watch/?v=10153231379946729",
        clearTimeout: () => {}
    });

    const result = await resolveFacebookEmbed("https://fb.watch/shortCode123/", { fetch: mockFetch });
    assert.equal(result.videoId, "10153231379946729");
    assert.equal(result.canonicalUrl, "https://www.facebook.com/watch/?v=10153231379946729");
});

// -------------------------------------------------------------
// 5. Centralized Dispatcher & Boundary Hardening
// -------------------------------------------------------------

test("Embed Dispatcher: Rejects unsupported platforms and spoofed domains", async () => {
    // Unsupported platform
    await assert.rejects(
        () => resolveEmbed("youtube", "https://www.youtube.com/watch?v=123"),
        (err) => {
            assert.equal(err.code, EMBED_ERROR_CODES.UNSUPPORTED_PLATFORM);
            assert.equal(err.statusCode, 400);
            return true;
        }
    );

    // Missing URL
    await assert.rejects(
        () => resolveEmbed("tiktok", ""),
        (err) => {
            assert.equal(err.code, EMBED_ERROR_CODES.INVALID_URL);
            assert.equal(err.statusCode, 400);
            return true;
        }
    );

    // Spoofed domain (SSRF / domain bypass attempt)
    await assert.rejects(
        () => resolveEmbed("tiktok", "https://attacker-tiktok.com/video/123"),
        (err) => {
            assert.equal(err.code, EMBED_ERROR_CODES.DISALLOWED_DOMAIN);
            assert.equal(err.statusCode, 400);
            return true;
        }
    );

    // Private IP target
    await assert.rejects(
        () => resolveEmbed("instagram", "https://127.0.0.1/p/123"),
        (err) => {
            assert.equal(err.code, EMBED_ERROR_CODES.DISALLOWED_DOMAIN);
            assert.equal(err.statusCode, 400);
            return true;
        }
    );
});

// -------------------------------------------------------------
// 6. HTTP API Integration & CSP Verification
// -------------------------------------------------------------

test("HTTP API: GET /api/embed/:platform returns structured embed metadata and enforces CSP", async () => {
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        // 1. TikTok embed endpoint
        const ttRes = await makeRequest(server, "/api/embed/tiktok?url=" + encodeURIComponent("https://www.tiktok.com/@tiktok/video/7106594312292453678"));
        assert.equal(ttRes.status, 200);
        assert.ok(ttRes.body.embed);
        assert.equal(ttRes.body.embed.type, "embed");
        assert.equal(ttRes.body.embed.downloadSupported, false);
        assert.equal(ttRes.body.embed.videoId, "7106594312292453678");

        // CSP frame-src check
        const csp = ttRes.headers["content-security-policy"];
        assert.ok(csp, "CSP header must be present");
        assert.ok(csp.includes("frame-src"), "frame-src must be defined in CSP");
        assert.ok(csp.includes("https://www.tiktok.com"), "TikTok frame source must be permitted in CSP");
        assert.ok(csp.includes("https://www.instagram.com"), "Instagram frame source must be permitted in CSP");
        assert.ok(csp.includes("https://www.facebook.com"), "Facebook frame source must be permitted in CSP");

        // 2. Instagram embed endpoint
        const igRes = await makeRequest(server, "/api/embed/instagram?url=" + encodeURIComponent("https://www.instagram.com/p/Cx123456789/"));
        assert.equal(igRes.status, 200);
        assert.ok(igRes.body.embed);
        assert.equal(igRes.body.embed.type, "embed");
        assert.equal(igRes.body.embed.shortcode, "Cx123456789");

        // 3. Facebook embed endpoint
        const fbRes = await makeRequest(server, "/api/embed/facebook?url=" + encodeURIComponent("https://www.facebook.com/watch/?v=10153231379946729"));
        assert.equal(fbRes.status, 200);
        assert.ok(fbRes.body.embed);
        assert.equal(fbRes.body.embed.type, "embed");
        assert.equal(fbRes.body.embed.videoId, "10153231379946729");

        // 4. Invalid platform rejection
        const errPlatRes = await makeRequest(server, "/api/embed/unknown?url=" + encodeURIComponent("https://www.facebook.com/watch/?v=10153231379946729"));
        assert.equal(errPlatRes.status, 400);
        assert.equal(errPlatRes.body.error.code, EMBED_ERROR_CODES.UNSUPPORTED_PLATFORM);

        // 5. Disallowed domain rejection
        const errDomainRes = await makeRequest(server, "/api/embed/tiktok?url=" + encodeURIComponent("https://evil-site.com/video/123"));
        assert.equal(errDomainRes.status, 400);
        assert.equal(errDomainRes.body.error.code, EMBED_ERROR_CODES.DISALLOWED_DOMAIN);
    } finally {
        await new Promise(r => server.close(r));
    }
});

// -------------------------------------------------------------
// 7. Frontend Embed Integration & UI Regression Tests
// -------------------------------------------------------------

test("Frontend Embed API: isValidEmbedUrl enforces strict whitelist per provider", () => {
    const api = require("../public/js/api.js");

    // TikTok
    assert.equal(api.isValidEmbedUrl("tiktok", "https://www.tiktok.com/embed/v2/7106594312292453678"), true);
    assert.equal(api.isValidEmbedUrl("tiktok", "https://tiktok.com/embed/v2/7106594312292453678"), true);
    assert.equal(api.isValidEmbedUrl("tiktok", "https://evil.com/embed/v2/7106594312292453678"), false);
    assert.equal(api.isValidEmbedUrl("tiktok", "javascript:alert(1)"), false);

    // Instagram
    assert.equal(api.isValidEmbedUrl("instagram", "https://www.instagram.com/p/C8oP4qNtxZ7/embed/"), true);
    assert.equal(api.isValidEmbedUrl("instagram", "https://instagram.com/p/C8oP4qNtxZ7/embed"), true);
    assert.equal(api.isValidEmbedUrl("instagram", "https://notinstagram.com/p/C8oP4qNtxZ7/embed/"), false);

    // Facebook
    assert.equal(api.isValidEmbedUrl("facebook", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D123&show_text=false&width=500"), true);
    assert.equal(api.isValidEmbedUrl("facebook", "https://evil.facebook.com/plugins/video.php?href=test&show_text=false&width=500"), false);
    assert.equal(api.isValidEmbedUrl("facebook", "data:text/html,<script>alert(1)</script>"), false);
});

test("Frontend Embed API: fetchEmbed client method parses success and rejects invalid embed URLs", async () => {
    const api = require("../public/js/api.js");

    // Mock fetch returning approved embed
    const mockFetch = async () => ({
        ok: true,
        json: async () => ({
            embed: {
                platform: "tiktok",
                embedUrl: "https://www.tiktok.com/embed/v2/7106594312292453678",
                title: "TikTok Video",
                notice: "Direct download restricted."
            }
        })
    });

    const res = await api.fetchEmbed("tiktok", "https://www.tiktok.com/@tiktok/video/7106594312292453678", { fetchFn: mockFetch });
    assert.equal(res.success, true);
    assert.equal(res.embed.embedUrl, "https://www.tiktok.com/embed/v2/7106594312292453678");

    // Mock fetch returning hostile embed URL
    const mockHostileFetch = async () => ({
        ok: true,
        json: async () => ({
            embed: {
                platform: "tiktok",
                embedUrl: "https://evil-tracker.com/embed/v2/7106594312292453678"
            }
        })
    });

    const hostileRes = await api.fetchEmbed("tiktok", "https://www.tiktok.com/@tiktok/video/7106594312292453678", { fetchFn: mockHostileFetch });
    assert.equal(hostileRes.success, false);
    assert.equal(hostileRes.code, "UNSAFE_EMBED_URL");
});

test("Frontend Embed UI: showEmbed safely constructs sandboxed DOM iframe and hides download button", () => {
    const uiModule = require("../public/js/ui.js");

    // Mock minimal DOM document
    const createdElements = [];
    const mockDocument = {
        getElementById: (id) => {
            const el = {
                id,
                classList: {
                    classes: new Set(["hidden"]),
                    add(c) { this.classes.add(c); },
                    remove(c) { this.classes.delete(c); },
                    contains(c) { return this.classes.has(c); }
                },
                style: {},
                attributes: {},
                children: [],
                firstChild: null,
                setAttribute(k, v) { this.attributes[k] = String(v); },
                removeAttribute(k) { delete this.attributes[k]; },
                appendChild(child) {
                    this.children.push(child);
                    this.firstChild = this.children[0];
                },
                removeChild(child) {
                    const idx = this.children.indexOf(child);
                    if (idx !== -1) this.children.splice(idx, 1);
                    this.firstChild = this.children[0] || null;
                }
            };
            return el;
        },
        querySelectorAll: () => [],
        createElement: (tag) => {
            const el = {
                tag,
                attributes: {},
                style: {},
                children: [],
                className: "",
                textContent: "",
                setAttribute(k, v) { this.attributes[k] = String(v); },
                appendChild(child) { this.children.push(child); }
            };
            createdElements.push(el);
            return el;
        },
        createTextNode: (text) => ({ text })
    };

    const ui = uiModule.createUiController(mockDocument);
    assert.ok(ui);

    // Call showEmbed
    ui.showEmbed({
        platform: "tiktok",
        embedUrl: "https://www.tiktok.com/embed/v2/7106594312292453678",
        title: "TikTok Embed Video",
        notice: "Direct downloads restricted."
    });

    // Check embedContainer visibility
    assert.equal(ui.elements.embedContainer.classList.contains("hidden"), false);
    assert.equal(ui.elements.embedContainer.style.display, "flex");

    // Check preview is hidden
    assert.equal(ui.elements.preview.classList.contains("hidden"), true);

    // Check download button is hidden
    assert.equal(ui.elements.downloadBtn.classList.contains("hidden"), true);

    // Inspect created iframe in createdElements
    const iframe = createdElements.find(e => e.tag === "iframe");
    assert.ok(iframe, "Iframe must be created");
    assert.equal(iframe.attributes.src, "https://www.tiktok.com/embed/v2/7106594312292453678");
    assert.equal(iframe.attributes.sandbox, "allow-scripts allow-same-origin allow-popups");
    assert.equal(iframe.attributes.loading, "lazy");
    assert.ok(!iframe.attributes.sandbox.includes("allow-top-navigation"));

    // Test hideEmbed resets container cleanly
    ui.hideEmbed();
    assert.equal(ui.elements.embedContainer.classList.contains("hidden"), true);
    assert.equal(ui.elements.embedContainer.style.display, "none");
    assert.equal(ui.elements.embedContainer.children.length, 0);
});

test("Frontend Reliability: Platform switching cleans up active embeds, previews, and download triggers", async () => {
    const { createAppController } = require("../public/app.js");
    const stateModule = require("../public/js/state.js");
    const apiModule = require("../public/js/api.js");
    const uiModule = require("../public/js/ui.js");
    const i18nModule = require("../public/js/i18n.js");

    // Build mock DOM elements
    const elements = {};
    const platformButtons = [];
    const eventListeners = new Map();

    function makeMockElement(id, tag = "div") {
        const el = {
            id,
            tag,
            style: { display: "" },
            attributes: {},
            classList: {
                classes: new Set(["hidden"]),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            },
            children: [],
            textContent: "",
            value: "",
            disabled: false,
            setAttribute(k, v) { this.attributes[k] = String(v); },
            getAttribute(k) { return this.attributes[k]; },
            removeAttribute(k) { delete this.attributes[k]; },
            appendChild(c) { this.children.push(c); },
            addEventListener(ev, fn) {
                if (!eventListeners.has(id + ":" + ev)) eventListeners.set(id + ":" + ev, []);
                eventListeners.get(id + ":" + ev).push(fn);
            },
            click() {
                const list = eventListeners.get(id + ":click") || [];
                for (const fn of list) fn();
            }
        };
        elements[id] = el;
        return el;
    }

    const preview = makeMockElement("preview", "video");
    const embedContainer = makeMockElement("embed-container", "div");
    const downloadBtn = makeMockElement("download", "button");
    const getBtn = makeMockElement("get", "button");
    const log = makeMockElement("log", "div");
    const urlIn = makeMockElement("url", "input");
    const consent = makeMockElement("consent", "input");
    consent.checked = true;

    ["youtube", "tiktok", "instagram"].forEach(plat => {
        const btn = makeMockElement("btn-" + plat, "button");
        btn.dataset = { platform: plat };
        platformButtons.push(btn);
    });

    const mockDocument = {
        getElementById: (id) => elements[id] || null,
        querySelectorAll: (sel) => {
            if (sel === ".platform-btn") return platformButtons;
            return [];
        },
        createElement: (tag) => makeMockElement("elem-" + Math.random(), tag),
        createTextNode: (t) => ({ text: t })
    };

    const state = stateModule.createState();

    const app = createAppController({
        document: mockDocument,
        state,
        api: apiModule,
        uiModule,
        i18n: i18nModule,
        fetchFn: async (url) => {
            if (url === "/api/capabilities") {
                return {
                    ok: true,
                    json: async () => ({
                        capabilities: {
                            platforms: { youtube: true, tiktok: true, instagram: true, facebook: true, twitter: true, pinterest: true, generic: true },
                            embedPlatforms: ["tiktok", "instagram", "facebook"],
                            audioOnly: true
                        }
                    })
                };
            }
            return { ok: false, status: 404 };
        }
    });

    await app.capabilitiesPromise;

    // Simulate an active embed state on TikTok
    state.setPlatform("tiktok");
    state.setStatus("success");
    state.setMediaUrls({ streamUrl: "/api/media/test", downloadUrl: "/api/media/test" });
    embedContainer.style.display = "flex";
    embedContainer.classList.remove("hidden");
    downloadBtn.style.display = "inline-block";
    downloadBtn.classList.remove("hidden");

    assert.equal(embedContainer.style.display, "flex");
    assert.equal(downloadBtn.style.display, "inline-block");

    // Click on YouTube platform button to switch
    const youtubeBtn = elements["btn-youtube"];
    youtubeBtn.click();

    // Verify platform changed
    assert.equal(state.getPlatform(), "youtube");

    // Verify media URLs were cleared
    assert.equal(state.getStreamUrl(), "");
    assert.equal(state.getDownloadUrl(), "");
    assert.equal(state.getStatus(), "idle");

    // Verify embed container and download button were hidden
    assert.equal(embedContainer.style.display, "none");
    assert.equal(embedContainer.classList.contains("hidden"), true);
    assert.equal(downloadBtn.style.display, "none");
    assert.equal(downloadBtn.classList.contains("hidden"), true);
});
