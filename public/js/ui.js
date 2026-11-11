// public/js/ui.js — Safe DOM Rendering and UI State Operations
"use strict";

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.Reeva = root.Reeva || {};
        root.Reeva.ui = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    /**
     * Initializes UI controller bound to a document context.
     * Caches DOM references to avoid repeated DOM queries.
     * Uses strictly safe DOM manipulation APIs (textContent, setAttribute, classList).
     *
     * @param {Document} [doc]
     * @returns {object}
     */
    function createUiController(doc, win) {
        const documentRef = doc || (typeof document !== "undefined" ? document : null);
        const windowRef = win || (typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
        if (!documentRef) {
            return null;
        }

        const elements = {
            appHeading: documentRef.getElementById("app-heading"),
            appSubtitle: documentRef.getElementById("app-subtitle"),
            inputInstruction: documentRef.getElementById("input-instruction"),
            langLabel: documentRef.getElementById("lang-label"),
            langSelect: documentRef.getElementById("lang-select"),
            getBtn: documentRef.getElementById("get"),
            downloadBtn: documentRef.getElementById("download"),
            urlIn: documentRef.getElementById("url"),
            log: documentRef.getElementById("log"),
            preview: documentRef.getElementById("preview"),
            previewImage: documentRef.getElementById("preview-image"),
            previewAudio: documentRef.getElementById("preview-audio"),
            embedContainer: documentRef.getElementById("embed-container"),
            carouselContainer: documentRef.getElementById("carousel-container"),
            consent: documentRef.getElementById("consent"),
            consentText: documentRef.getElementById("consent-text"),
            whyConsent: documentRef.getElementById("why-consent"),
            footerDisclaimer: documentRef.getElementById("footer-disclaimer"),
            footerCopyright: documentRef.getElementById("footer-copyright"),
            linkPrivacy: documentRef.getElementById("link-privacy"),
            linkTerms: documentRef.getElementById("link-terms"),
            platformBtns: documentRef.querySelectorAll(".platform-btn")
        };

        // Ensure accessibility attributes on status log container
        if (elements.log) {
            elements.log.setAttribute("role", "status");
            elements.log.setAttribute("aria-live", "polite");
        }

        /**
         * Updates status log text safely using textContent.
         *
         * @param {string} message
         * @param {"info"|"success"|"error"} [type="info"]
         */
        function setLog(message, type = "info") {
            if (!elements.log) return;
            const colorMap = {
                info: "var(--muted)",
                success: "var(--success)",
                error: "var(--error)"
            };
            elements.log.style.color = colorMap[type] || "var(--muted)";
            elements.log.textContent = String(message || "");
        }

        /**
         * Clears status log text.
         */
        function clearLog() {
            if (!elements.log) return;
            elements.log.textContent = "";
        }

        /**
         * Sets loading visual and accessibility state.
         *
         * @param {boolean} isLoading
         * @param {string} [loadingText]
         */
        function setLoading(isLoading, loadingText) {
            if (elements.getBtn) {
                elements.getBtn.disabled = Boolean(isLoading);
                elements.getBtn.setAttribute("aria-busy", String(Boolean(isLoading)));
            }
            if (isLoading && loadingText) {
                setLog(loadingText, "info");
            }
        }

        /**
         * Displays the appropriate media preview element (video, image, or audio)
         * based on mediaType with a validated stream URL.
         *
         * @param {string} streamUrl
         * @param {string} [mediaType="video"]
         * @param {string|null} [posterUrl=null]
         */
        function showPreview(streamUrl, mediaType = "video", posterUrl = null) {
            if (!streamUrl) return;

            // Reset and hide all previews first
            hidePreview();

            const normalizedType = String(mediaType || "video").toLowerCase();

            if (normalizedType === "image") {
                if (elements.previewImage) {
                    elements.previewImage.src = streamUrl;
                    elements.previewImage.classList.remove("hidden");
                    elements.previewImage.style.display = "block";
                }
            } else if (normalizedType === "audio") {
                if (elements.previewAudio) {
                    elements.previewAudio.src = streamUrl;
                    elements.previewAudio.classList.remove("hidden");
                    elements.previewAudio.style.display = "block";
                }
            } else if (normalizedType === "video") {
                if (elements.preview) {
                    elements.preview.src = streamUrl;
                    if (posterUrl) {
                        elements.preview.poster = posterUrl;
                    }
                    elements.preview.classList.remove("hidden");
                    elements.preview.style.display = "block";
                }
            } else {
                // Unknown/unsupported preview media type: safe fallback
                // All previews remain hidden; the user can still download
            }
        }

        /**
         * Hides and resets all media preview elements (video, image, audio),
         * detaching playback buffers and releasing memory resources.
         */
        function hidePreview() {
            if (elements.preview) {
                try {
                    if (typeof elements.preview.pause === "function") {
                        elements.preview.pause();
                    }
                    if (typeof elements.preview.load === "function") {
                        elements.preview.removeAttribute("src");
                        elements.preview.load();
                    } else {
                        elements.preview.removeAttribute("src");
                    }
                } catch (_) {}
                elements.preview.removeAttribute("poster");
                elements.preview.classList.add("hidden");
                elements.preview.style.display = "none";
            }

            if (elements.previewImage) {
                elements.previewImage.removeAttribute("src");
                elements.previewImage.classList.add("hidden");
                elements.previewImage.style.display = "none";
            }

            if (elements.previewAudio) {
                try {
                    if (typeof elements.previewAudio.pause === "function") {
                        elements.previewAudio.pause();
                    }
                    if (typeof elements.previewAudio.load === "function") {
                        elements.previewAudio.removeAttribute("src");
                        elements.previewAudio.load();
                    } else {
                        elements.previewAudio.removeAttribute("src");
                    }
                } catch (_) {}
                elements.previewAudio.classList.add("hidden");
                elements.previewAudio.style.display = "none";
            }
        }

        /**
         * Renders the official embedded player in the embed container with restrictive sandbox attributes.
         *
         * @param {object} embedData
         */
        function showEmbed(embedData) {
            if (!elements.embedContainer || !embedData || !embedData.embedUrl) return;

            // Clean previous children
            while (elements.embedContainer.firstChild) {
                elements.embedContainer.removeChild(elements.embedContainer.firstChild);
            }

            // Ensure native preview is hidden
            hidePreview();
            setDownloadButtonVisible(false);

            // Construct notice badge using textContent and DOM APIs
            const badge = documentRef.createElement("div");
            badge.className = "embed-badge";

            const tag = documentRef.createElement("span");
            tag.className = "embed-badge-tag";
            tag.textContent = "OFFICIAL EMBED";
            badge.appendChild(tag);

            const noticeText = documentRef.createTextNode(
                embedData.notice || "Direct video file downloads are restricted by platform terms. An official embedded player is provided."
            );
            badge.appendChild(noticeText);
            elements.embedContainer.appendChild(badge);

            // Construct sandboxed iframe
            const iframe = documentRef.createElement("iframe");
            iframe.setAttribute("src", embedData.embedUrl);
            iframe.setAttribute("title", embedData.title || "Embedded Media Player");
            iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups");
            iframe.setAttribute("allow", "fullscreen; picture-in-picture; autoplay; encrypted-media; web-share");
            iframe.setAttribute("loading", "lazy");

            const widthVal = embedData.width ? (typeof embedData.width === "number" ? `${embedData.width}px` : embedData.width) : "100%";
            const heightVal = embedData.height ? (typeof embedData.height === "number" ? `${embedData.height}px` : embedData.height) : "480px";
            iframe.style.width = widthVal;
            iframe.style.height = heightVal;

            elements.embedContainer.appendChild(iframe);
            elements.embedContainer.classList.remove("hidden");
            elements.embedContainer.style.display = "flex";
        }

        /**
         * Hides and resets the official embedded player.
         */
        function hideEmbed() {
            if (!elements.embedContainer) return;
            while (elements.embedContainer.firstChild) {
                elements.embedContainer.removeChild(elements.embedContainer.firstChild);
            }
            elements.embedContainer.classList.add("hidden");
            elements.embedContainer.style.display = "none";
        }

        /**
         * Renders all carousel items in a responsive grid with individual media previews and download buttons.
         *
         * @param {Array<object>} items
         */
        function showCarousel(items) {
            if (!elements.carouselContainer || !Array.isArray(items) || items.length === 0) return;

            hidePreview();
            hideEmbed();
            setDownloadButtonVisible(false);

            while (elements.carouselContainer.firstChild) {
                elements.carouselContainer.removeChild(elements.carouselContainer.firstChild);
            }

            const grid = documentRef.createElement("div");
            grid.className = "carousel-grid";

            const total = items.length;

            items.forEach((item, idx) => {
                const card = documentRef.createElement("div");
                card.className = "carousel-card";

                // Header with position and type badge
                const header = documentRef.createElement("div");
                header.className = "carousel-card-header";

                const posBadge = documentRef.createElement("span");
                posBadge.className = "carousel-position-badge";
                posBadge.textContent = `${idx + 1} of ${total}`;
                header.appendChild(posBadge);

                const typeBadge = documentRef.createElement("span");
                const isVideo = item.type === "video";
                typeBadge.className = `carousel-type-badge ${isVideo ? "badge-video" : "badge-image"}`;
                typeBadge.textContent = isVideo ? "Video" : "Photo";
                header.appendChild(typeBadge);

                card.appendChild(header);

                // Media preview wrapper
                const mediaWrapper = documentRef.createElement("div");
                mediaWrapper.className = "carousel-media-wrapper";

                if (isVideo) {
                    const videoEl = documentRef.createElement("video");
                    videoEl.controls = true;
                    videoEl.playsInline = true;
                    videoEl.preload = "none";
                    videoEl.setAttribute("controlsList", "nodownload");
                    videoEl.setAttribute("aria-label", `Video ${idx + 1} of ${total}`);
                    if (item.thumbnailUrl) {
                        if (typeof windowRef.IntersectionObserver === "function") {
                            videoEl.dataset.poster = item.thumbnailUrl;
                            const observer = new windowRef.IntersectionObserver((entries, obs) => {
                                for (const entry of entries) {
                                    if (entry.isIntersecting) {
                                        if (videoEl.dataset.poster) {
                                            videoEl.poster = videoEl.dataset.poster;
                                            delete videoEl.dataset.poster;
                                        }
                                        obs.unobserve(videoEl);
                                    }
                                }
                            }, { rootMargin: "200px 0px" });
                            observer.observe(videoEl);
                        } else {
                            videoEl.poster = item.thumbnailUrl;
                        }
                    }
                    if (item.streamUrl) {
                        videoEl.src = item.streamUrl;
                    }
                    mediaWrapper.appendChild(videoEl);
                } else {
                    const imgEl = documentRef.createElement("img");
                    imgEl.loading = "lazy";
                    imgEl.alt = `Carousel item ${idx + 1} of ${total}`;
                    imgEl.src = item.thumbnailUrl || item.streamUrl;
                    mediaWrapper.appendChild(imgEl);
                }

                card.appendChild(mediaWrapper);

                // Footer with individual download button
                const footer = documentRef.createElement("div");
                footer.className = "carousel-card-footer";

                const downloadLink = documentRef.createElement("a");
                downloadLink.className = "action carousel-download-btn";
                downloadLink.href = item.downloadUrl || item.streamUrl;
                downloadLink.setAttribute("download", `reeva_instagram_${String(idx + 1).padStart(2, "0")}.${isVideo ? "mp4" : "jpg"}`);
                downloadLink.textContent = isVideo ? "Download Video" : "Download Photo";
                downloadLink.setAttribute("aria-label", `Download item ${idx + 1} of ${total}`);

                // Prevent rapid repeated clicks
                let isDownloading = false;
                downloadLink.addEventListener("click", () => {
                    if (isDownloading) return;
                    isDownloading = true;
                    setTimeout(() => { isDownloading = false; }, 2000);
                });

                footer.appendChild(downloadLink);
                card.appendChild(footer);

                grid.appendChild(card);
            });

            elements.carouselContainer.appendChild(grid);
            elements.carouselContainer.classList.remove("hidden");
            elements.carouselContainer.style.display = "flex";
        }

        /**
         * Hides and resets the carousel container.
         */
        function hideCarousel() {
            if (!elements.carouselContainer) return;

            // Pause any playing videos
            try {
                const videos = elements.carouselContainer.querySelectorAll("video");
                videos.forEach((v) => {
                    if (typeof v.pause === "function") {
                        v.pause();
                    }
                    v.removeAttribute("src");
                });
            } catch (_) {}

            while (elements.carouselContainer.firstChild) {
                elements.carouselContainer.removeChild(elements.carouselContainer.firstChild);
            }
            elements.carouselContainer.classList.add("hidden");
            elements.carouselContainer.style.display = "none";
        }

        /**
         * Toggles the visibility of the Download action button.
         *
         * @param {boolean} show
         */
        function setDownloadButtonVisible(show) {
            if (!elements.downloadBtn) return;
            if (show) {
                elements.downloadBtn.classList.remove("hidden");
                elements.downloadBtn.style.display = "inline-block";
                elements.downloadBtn.setAttribute("aria-hidden", "false");
            } else {
                elements.downloadBtn.classList.add("hidden");
                elements.downloadBtn.style.display = "none";
                elements.downloadBtn.setAttribute("aria-hidden", "true");
            }
        }

        /**
         * Highlights the selected platform button and de-highlights all others.
         * Does NOT rely on inner text of button, matches on data-platform attribute.
         *
         * @param {string} selectedPlatform
         */
        function setActivePlatform(selectedPlatform) {
            if (!elements.platformBtns) return;
            elements.platformBtns.forEach((btn) => {
                if (btn.dataset && btn.dataset.platform === selectedPlatform) {
                    btn.classList.add("active");
                } else {
                    btn.classList.remove("active");
                }
            });
        }

        /**
         * Retrieves trimmed URL input value.
         *
         * @returns {string}
         */
        function getUrlInput() {
            return elements.urlIn ? elements.urlIn.value.trim() : "";
        }

        /**
         * Checks whether consent checkbox is checked.
         *
         * @returns {boolean}
         */
        function isConsentChecked() {
            return elements.consent ? Boolean(elements.consent.checked) : false;
        }

        /**
         * Applies active localization to the DOM elements.
         *
         * @param {string} lang
         * @param {(key: string, params?: object, lang?: string) => string} t
         * @param {(lang: string) => "ltr"|"rtl"} [getDirection]
         */
        function applyTranslations(lang, t, getDirection) {
            if (typeof t !== "function") return;

            // HTML lang & direction attributes
            if (documentRef.documentElement) {
                documentRef.documentElement.lang = lang;
                if (typeof getDirection === "function") {
                    documentRef.documentElement.dir = getDirection(lang);
                }
            }

            // Document title
            const titleText = t("app.title", {}, lang);
            if (titleText) {
                documentRef.title = titleText;
            }

            // Headers & instructions
            if (elements.appHeading) elements.appHeading.textContent = t("app.heading", {}, lang);
            if (elements.appSubtitle) elements.appSubtitle.textContent = t("app.subtitle", {}, lang);
            if (elements.inputInstruction) elements.inputInstruction.textContent = t("input.instruction", {}, lang);
            if (elements.langLabel) elements.langLabel.textContent = t("lang.label", {}, lang);

            // Controls & accessibility labels
            if (elements.urlIn) {
                elements.urlIn.placeholder = t("input.placeholder", {}, lang);
                elements.urlIn.setAttribute("aria-label", t("aria.video_url", {}, lang));
            }
            if (elements.getBtn) elements.getBtn.textContent = t("action.get", {}, lang);
            if (elements.downloadBtn) elements.downloadBtn.textContent = t("action.download", {}, lang);

            // Consent & media labels
            if (elements.consentText) elements.consentText.textContent = t("consent.label", {}, lang);
            if (elements.whyConsent) elements.whyConsent.textContent = t("consent.why", {}, lang);
            if (elements.preview) elements.preview.setAttribute("aria-label", t("aria.media_preview", {}, lang));
            if (elements.previewImage) elements.previewImage.setAttribute("alt", t("aria.image_preview", {}, lang));
            if (elements.previewAudio) elements.previewAudio.setAttribute("aria-label", t("aria.audio_preview", {}, lang));

            // Footer text
            if (elements.footerDisclaimer) elements.footerDisclaimer.textContent = t("footer.disclaimer", {}, lang);
            if (elements.footerCopyright) elements.footerCopyright.textContent = t("footer.copyright", {}, lang);
            if (elements.linkPrivacy) elements.linkPrivacy.textContent = t("footer.privacy", {}, lang);
            if (elements.linkTerms) elements.linkTerms.textContent = t("footer.terms", {}, lang);

            // Platform buttons
            if (elements.platformBtns) {
                elements.platformBtns.forEach((btn) => {
                    const platform = btn.dataset ? btn.dataset.platform : null;
                    if (platform) {
                        const labelText = t(`platform.${platform}`, {}, lang);
                        btn.setAttribute("title", labelText);
                        btn.setAttribute("aria-label", labelText);
                        const labelSpan = btn.querySelector ? btn.querySelector(".platform-label") : null;
                        if (labelSpan) {
                            labelSpan.textContent = labelText;
                        } else if (!btn.querySelector || !btn.querySelector("svg")) {
                            btn.textContent = labelText;
                        }
                    }
                });
            }

            // Language selector select value
            if (elements.langSelect) {
                elements.langSelect.value = lang;
            }
        }

        return {
            elements,
            setLog,
            clearLog,
            setLoading,
            showPreview,
            hidePreview,
            showEmbed,
            hideEmbed,
            showCarousel,
            hideCarousel,
            setDownloadButtonVisible,
            setActivePlatform,
            getUrlInput,
            isConsentChecked,
            applyTranslations
        };
    }

    return {
        createUiController
    };
});
