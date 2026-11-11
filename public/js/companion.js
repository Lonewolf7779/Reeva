// public/js/companion.js — Reeva Visual Novel Anime Companion Character System
"use strict";

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.ReevaCompanion = factory();
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {

    // =========================================================================
    // 1. Companion States & Priority Escalation Matrix
    // =========================================================================
    const STATES = {
        IDLE: "IDLE",
        WELCOME: "WELCOME",
        CURIOUS: "CURIOUS",
        PLATFORM_SELECTED: "PLATFORM_SELECTED",
        PROCESSING: "PROCESSING",
        SUCCESS: "SUCCESS",
        FAILURE: "FAILURE",
        INVALID_URL: "INVALID_URL",
        NETWORK_ERROR: "NETWORK_ERROR",
        IDLE_SUCCESS: "IDLE_SUCCESS"
    };

    const STATE_PRIORITIES = {
        [STATES.IDLE]: 1,
        [STATES.IDLE_SUCCESS]: 1,
        [STATES.WELCOME]: 2,
        [STATES.CURIOUS]: 2,
        [STATES.PLATFORM_SELECTED]: 2,
        [STATES.PROCESSING]: 4,
        [STATES.INVALID_URL]: 5,
        [STATES.NETWORK_ERROR]: 5,
        [STATES.FAILURE]: 6,
        [STATES.SUCCESS]: 6
    };

    // All 10 Required Visual Novel Expressions
    const EXPRESSIONS = {
        HAPPY: "happy",
        SMILING: "smiling",
        EXCITED: "excited",
        CURIOUS: "curious",
        FOCUSED: "focused",
        SURPRISED: "surprised",
        CONFUSED: "confused",
        DISAPPOINTED: "disappointed",
        CRYING: "crying",
        CELEBRATING: "celebrating"
    };

    // Contextual Messages (Bilingual EN / HI)
    const COMPANION_MESSAGES = {
        [STATES.WELCOME]: {
            en: "Ready when you are!",
            hi: "नमस्ते! जब आप तैयार हों।"
        },
        [STATES.CURIOUS]: {
            en: "Ooh, what video are we getting?",
            hi: "अरे वाह, कौन सा वीडियो ला रहे हैं?"
        },
        [STATES.PLATFORM_SELECTED]: {
            en: "Nice choice! Paste the link whenever you're ready.",
            hi: "बढ़िया चुनाव! जब तैयार हों, लिंक पेस्ट करें।"
        },
        [STATES.PROCESSING]: {
            en: "Let me take a look...",
            hi: "ज़रा देखने दीजिए..."
        },
        [STATES.SUCCESS]: {
            en: "There we go! Your media is ready.",
            hi: "ये रहा! आपका मीडिया तैयार है।"
        },
        [STATES.FAILURE]: {
            en: "Oops... I couldn't retrieve that one.",
            hi: "ओह... यह डाउनलोड नहीं हो पाया।"
        },
        [STATES.INVALID_URL]: {
            en: "Hmm... could you check that link?",
            hi: "हम्म... क्या आप इस लिंक की दोबारा जांच कर सकते हैं?"
        },
        [STATES.NETWORK_ERROR]: {
            en: "Looks like the connection is having trouble.",
            hi: "लगता है नेटवर्क कनेक्शन में समस्या है।"
        }
    };

    const MOOD_TAGS = {
        [STATES.IDLE]: { en: "Ready", hi: "तैयार" },
        [STATES.WELCOME]: { en: "Greeting", hi: "नमस्ते" },
        [STATES.CURIOUS]: { en: "Curious", hi: "उत्सुक" },
        [STATES.PLATFORM_SELECTED]: { en: "Ready", hi: "तैयार" },
        [STATES.PROCESSING]: { en: "Working...", hi: "काम चालू..." },
        [STATES.SUCCESS]: { en: "Success!", hi: "सफल!" },
        [STATES.FAILURE]: { en: "Sorry!", hi: "माफ़ कीजिए" },
        [STATES.INVALID_URL]: { en: "Puzzled", hi: "असमंजस" },
        [STATES.NETWORK_ERROR]: { en: "Offline", hi: "ऑफ़लाइन" }
    };

    // Helper to safely check reduced motion
    function isReducedMotion() {
        if (typeof window !== "undefined" && window.matchMedia) {
            return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        }
        return false;
    }

    // =========================================================================
    // 2. Natural Periodic Blinking Controller
    // =========================================================================
    class BlinkController {
        constructor(eyelidsEl) {
            this.eyelidsEl = eyelidsEl;
            this.timer = null;
            this.isActive = false;
            this.isPaused = false;
        }

        start() {
            if (this.isActive) return;
            this.isActive = true;
            this.isPaused = false;
            this._scheduleNextBlink();
        }

        stop() {
            this.isActive = false;
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            if (this.eyelidsEl) {
                this.eyelidsEl.classList.remove("is-blinking");
            }
        }

        pause() {
            this.isPaused = true;
            if (this.eyelidsEl) {
                this.eyelidsEl.classList.remove("is-blinking");
            }
        }

        resume() {
            this.isPaused = false;
        }

        _scheduleNextBlink() {
            if (!this.isActive) return;
            // Anime blink interval: 2.8s to 5.2s
            const delay = 2800 + Math.random() * 2400;
            this.timer = setTimeout(() => {
                if (!this.isActive) return;
                if (this.isPaused || isReducedMotion()) {
                    this._scheduleNextBlink();
                    return;
                }
                this._blinkOnce(() => {
                    // ~15% chance of a quick natural double blink
                    if (Math.random() < 0.15 && this.isActive && !this.isPaused) {
                        setTimeout(() => {
                            this._blinkOnce(() => this._scheduleNextBlink());
                        }, 120);
                    } else {
                        this._scheduleNextBlink();
                    }
                });
            }, delay);
        }

        _blinkOnce(cb) {
            if (!this.eyelidsEl) {
                if (cb) cb();
                return;
            }
            this.eyelidsEl.classList.add("is-blinking");
            setTimeout(() => {
                if (this.eyelidsEl) {
                    this.eyelidsEl.classList.remove("is-blinking");
                }
                if (cb) cb();
            }, 140);
        }
    }

    // =========================================================================
    // 3. Interactive Processing Butterfly Controller
    // =========================================================================
    class ButterflyController {
        constructor(butterflyEl, spriteContainerEl) {
            this.butterflyEl = butterflyEl;
            this.spriteContainerEl = spriteContainerEl;
            this.animFrame = null;
            this.isActive = false;
            this.startTime = 0;
            this.isCatching = false;
        }

        start() {
            if (!this.butterflyEl) return;
            this.isActive = true;
            this.isCatching = false;
            this.startTime = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
            this.butterflyEl.classList.remove("hidden", "is-caught");
            this.butterflyEl.classList.add("is-active");

            if (isReducedMotion()) {
                // Keep static gentle hover near character for reduced-motion
                this.butterflyEl.style.left = "65%";
                this.butterflyEl.style.top = "30%";
                this.butterflyEl.style.transform = "translate(-50%, -50%)";
                return;
            }

            const updateFlight = (timestamp) => {
                if (!this.isActive || this.isCatching) return;
                const elapsed = (timestamp - this.startTime) / 1000;

                // Smooth Lissajous flight path around upper body / head
                const centerX = 50;
                const centerY = 36;
                const radiusX = 30;
                const radiusY = 20;

                const x = centerX + Math.sin(elapsed * 1.6) * radiusX + Math.cos(elapsed * 0.8) * 6;
                const y = centerY + Math.sin(elapsed * 3.2) * (radiusY * 0.55) + Math.sin(elapsed * 1.1) * 7;

                const dx = Math.cos(elapsed * 1.6) * 1.6 * radiusX;
                const dy = Math.cos(elapsed * 3.2) * 1.76 * (radiusY * 0.55);
                const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI) * 0.35;

                this.butterflyEl.style.left = `${x.toFixed(2)}%`;
                this.butterflyEl.style.top = `${y.toFixed(2)}%`;
                this.butterflyEl.style.transform = `translate(-50%, -50%) rotate(${angleDeg.toFixed(1)}deg)`;

                // Character sprite subtly follows butterfly gaze (<= 3px translation, <= 0.6deg rotation)
                if (this.spriteContainerEl) {
                    const gazeX = ((x - centerX) / radiusX) * 2.5;
                    const gazeY = ((y - centerY) / radiusY) * 1.4;
                    const gazeRot = ((x - centerX) / radiusX) * 0.5;
                    this.spriteContainerEl.style.transform = `translate(${gazeX.toFixed(1)}px, ${gazeY.toFixed(1)}px) rotate(${gazeRot.toFixed(1)}deg)`;
                }

                if (typeof window !== "undefined" && window.requestAnimationFrame) {
                    this.animFrame = window.requestAnimationFrame(updateFlight);
                }
            };

            if (typeof window !== "undefined" && window.requestAnimationFrame) {
                this.animFrame = window.requestAnimationFrame(updateFlight);
            }
        }

        stop() {
            this.isActive = false;
            this.isCatching = false;
            if (this.animFrame && typeof window !== "undefined" && window.cancelAnimationFrame) {
                window.cancelAnimationFrame(this.animFrame);
                this.animFrame = null;
            }
            if (this.butterflyEl) {
                this.butterflyEl.classList.remove("is-active", "is-caught");
                this.butterflyEl.classList.add("hidden");
                this.butterflyEl.style.transform = "";
                this.butterflyEl.style.transition = "";
            }
            if (this.spriteContainerEl) {
                this.spriteContainerEl.style.transform = "";
                this.spriteContainerEl.style.transition = "";
            }
        }

        catchAndFinish(onComplete) {
            if (!this.isActive) {
                if (onComplete) onComplete();
                return;
            }
            this.isCatching = true;
            if (this.animFrame && typeof window !== "undefined" && window.cancelAnimationFrame) {
                window.cancelAnimationFrame(this.animFrame);
                this.animFrame = null;
            }

            if (!this.butterflyEl || isReducedMotion()) {
                this.stop();
                if (onComplete) onComplete();
                return;
            }

            // Swoop toward Reeva's chest/hands before catching
            this.butterflyEl.style.transition = "left 0.28s ease-in, top 0.28s ease-in, transform 0.28s ease-in";
            this.butterflyEl.style.left = "50%";
            this.butterflyEl.style.top = "60%";
            this.butterflyEl.style.transform = "translate(-50%, -50%) scale(1.15)";

            if (this.spriteContainerEl) {
                this.spriteContainerEl.style.transition = "transform 0.28s ease-in";
                this.spriteContainerEl.style.transform = "translate(0px, 1px) rotate(0deg)";
            }

            setTimeout(() => {
                if (this.butterflyEl) {
                    this.butterflyEl.style.transition = "";
                    this.butterflyEl.classList.add("is-caught");
                }
                setTimeout(() => {
                    this.stop();
                    if (onComplete) onComplete();
                }, 360);
            }, 280);
        }
    }

    // =========================================================================
    // 4. Character Animations (Entrance, Breathing, Gestures)
    // =========================================================================
    class VisualNovelAnimations {
        constructor(spriteContainerEl) {
            this.container = spriteContainerEl;
            this.breathingActive = false;
        }

        _runAnimation(animDef) {
            if (!this.container || isReducedMotion()) return;
            try {
                const anime = (typeof window !== "undefined" && window.anime) ? window.anime : null;
                if (typeof anime === "function") {
                    anime(Object.assign({ targets: this.container }, animDef));
                } else if (anime && typeof anime.animate === "function") {
                    anime.animate(this.container, animDef);
                }
            } catch (err) {
                // Graceful fallback to pure CSS transforms
            }
        }

        startBreathing() {
            if (!this.container || isReducedMotion()) return;
            this.breathingActive = true;
            this.container.classList.add("is-breathing");
        }

        stopBreathing() {
            this.breathingActive = false;
            if (this.container) {
                this.container.classList.remove("is-breathing");
            }
        }

        playLookTowardUser() {
            if (!this.container || isReducedMotion()) return;
            this.container.classList.remove("look-toward-user");
            void this.container.offsetWidth; // Trigger reflow
            this.container.classList.add("look-toward-user");
            setTimeout(() => {
                if (this.container) this.container.classList.remove("look-toward-user");
            }, 550);
        }

        playWelcome() {
            if (!this.container || isReducedMotion()) return;
            this.container.classList.remove("anim-bounce");
            void this.container.offsetWidth;
            this.container.classList.add("anim-bounce");
            setTimeout(() => {
                if (this.container) this.container.classList.remove("anim-bounce");
            }, 700);
        }

        playLookTowardInterface() {
            this._runAnimation({
                translateX: [-6, 0],
                duration: 600,
                easing: "easeOutCubic"
            });
        }

        playCurious() {
            this._runAnimation({
                rotate: [-2, 0],
                translateY: [-3, 0],
                duration: 700,
                easing: "easeOutQuad"
            });
        }

        playCelebration() {
            if (!this.container || isReducedMotion()) return;
            this.container.classList.remove("anim-bounce");
            void this.container.offsetWidth;
            this.container.classList.add("anim-bounce");
            setTimeout(() => {
                if (this.container) this.container.classList.remove("anim-bounce");
            }, 750);
        }

        playCrying() {
            this._runAnimation({
                translateX: [-2, 2, -1, 1, 0],
                translateY: [3, 0],
                duration: 750,
                easing: "easeInOutSine"
            });
        }
    }

    // =========================================================================
    // 5. Dialogue Box Controller
    // =========================================================================
    class VisualNovelDialogue {
        constructor() {
            this.dialogueEl = document.getElementById("companion-dialogue");
            this.textEl = document.getElementById("companion-dialogue-text");
            this.closeBtn = document.getElementById("companion-dialogue-close");
            this.moodTagEl = document.getElementById("companion-mood-tag");
            this.dismissTimer = null;

            if (this.closeBtn) {
                this.closeBtn.addEventListener("click", () => this.hide());
            }
        }

        show(text, mood = "Ready", autoDismissMs = 5000) {
            if (this.dismissTimer) {
                clearTimeout(this.dismissTimer);
                this.dismissTimer = null;
            }

            if (this.moodTagEl) {
                this.moodTagEl.textContent = mood;
            }

            if (this.textEl) {
                this.textEl.textContent = text;
            }

            if (this.dialogueEl) {
                this.dialogueEl.classList.remove("hidden", "bubble-exit");
                this.dialogueEl.classList.add("bubble-enter");
            }

            if (autoDismissMs > 0) {
                this.dismissTimer = setTimeout(() => {
                    this.hide();
                }, autoDismissMs);
            }
        }

        hide() {
            if (this.dismissTimer) {
                clearTimeout(this.dismissTimer);
                this.dismissTimer = null;
            }

            if (this.dialogueEl) {
                this.dialogueEl.classList.remove("bubble-enter");
                this.dialogueEl.classList.add("bubble-exit");
                setTimeout(() => {
                    if (this.dialogueEl) {
                        this.dialogueEl.classList.add("hidden");
                        this.dialogueEl.classList.remove("bubble-exit");
                    }
                }, 220);
            }
        }
    }

    // =========================================================================
    // 6. Main Companion Controller
    // =========================================================================
    class CompanionController {
        constructor(stageEl, options = {}) {
            this.stageEl = stageEl || document.getElementById("companion-stage");
            this.options = options;
            this.state = STATES.IDLE;
            this.currentLanguage = options.initialLanguage || "en";
            this.currentExpression = EXPRESSIONS.HAPPY;
            this.isVisible = false;
            this.idleReturnTimer = null;
            this.exitTransitionTimer = null;

            // DOM Elements
            this.workspaceLayout = document.querySelector(".workspace-layout");
            this.spriteContainer = document.getElementById("comp-sprite-container");
            this.eyelidsEl = document.getElementById("comp-eyelids");
            this.butterflyEl = document.getElementById("comp-butterfly");

            // Sub-controllers
            this.blinkController = new BlinkController(this.eyelidsEl);
            this.butterflyController = new ButterflyController(this.butterflyEl, this.spriteContainer);
            this.dialogue = new VisualNovelDialogue();
            this.animationEngine = new VisualNovelAnimations(this.spriteContainer);

            // Interaction on companion avatar click
            this._initInteractions();

            // Set initial expression to happy
            this.setExpression(EXPRESSIONS.HAPPY);

            // Initial state: hidden by default
            if (this.stageEl) {
                this.stageEl.classList.add("is-hidden");
                this.stageEl.setAttribute("aria-hidden", "true");
            }
            if (this.workspaceLayout) {
                this.workspaceLayout.classList.remove("has-active-companion");
            }
        }

        _initInteractions() {
            if (this.spriteContainer) {
                this.spriteContainer.addEventListener("click", () => {
                    if (this.state === STATES.IDLE || !this.isVisible) {
                        this.triggerState(STATES.WELCOME, 3500);
                    }
                });
            }
        }

        showCompanion(onShown) {
            if (this.exitTransitionTimer) {
                clearTimeout(this.exitTransitionTimer);
                this.exitTransitionTimer = null;
            }

            if (this.isVisible && this.stageEl && !this.stageEl.classList.contains("is-hidden")) {
                if (onShown) onShown();
                return;
            }

            this.isVisible = true;

            if (this.stageEl) {
                this.stageEl.classList.remove("is-hidden", "is-exiting");
                this.stageEl.setAttribute("aria-hidden", "false");
            }

            if (this.workspaceLayout) {
                this.workspaceLayout.classList.add("has-active-companion");
            }

            // Look-toward-user entrance animation
            this.animationEngine.playLookTowardUser();
            this.animationEngine.startBreathing();

            // Start natural periodic blinking
            this.blinkController.start();

            if (onShown) onShown();
        }

        hideCompanion(force = false, onHidden) {
            if (this.exitTransitionTimer) {
                clearTimeout(this.exitTransitionTimer);
                this.exitTransitionTimer = null;
            }

            if (this.idleReturnTimer) {
                clearTimeout(this.idleReturnTimer);
                this.idleReturnTimer = null;
            }

            // Stop animations & hide dialogue
            this.butterflyController.stop();
            this.blinkController.stop();
            this.animationEngine.stopBreathing();
            this.dialogue.hide();

            this.state = STATES.IDLE;
            this.setExpression(EXPRESSIONS.HAPPY);

            if (!this.stageEl) {
                this.isVisible = false;
                if (onHidden) onHidden();
                return;
            }

            if (force || isReducedMotion()) {
                this.stageEl.classList.add("is-hidden");
                this.stageEl.classList.remove("is-exiting");
                this.stageEl.setAttribute("aria-hidden", "true");
                if (this.workspaceLayout) {
                    this.workspaceLayout.classList.remove("has-active-companion");
                }
                this.isVisible = false;
                if (onHidden) onHidden();
                return;
            }

            // Smooth exit animation
            this.stageEl.classList.add("is-exiting");
            this.exitTransitionTimer = setTimeout(() => {
                if (this.stageEl) {
                    this.stageEl.classList.add("is-hidden");
                    this.stageEl.classList.remove("is-exiting");
                    this.stageEl.setAttribute("aria-hidden", "true");
                }
                if (this.workspaceLayout) {
                    this.workspaceLayout.classList.remove("has-active-companion");
                }
                this.isVisible = false;
                this.exitTransitionTimer = null;
                if (onHidden) onHidden();
            }, 280);
        }

        setLanguage(lang) {
            this.currentLanguage = lang === "hi" ? "hi" : "en";
            if (this.state !== STATES.IDLE && this.isVisible) {
                const msg = this.getLocalizedMessage(this.state);
                const mood = this.getLocalizedMood(this.state);
                if (msg) this.dialogue.show(msg, mood, 4000);
            }
        }

        getLocalizedMessage(stateKey) {
            const entry = COMPANION_MESSAGES[stateKey];
            if (!entry) return "";
            return entry[this.currentLanguage] || entry.en || "";
        }

        getLocalizedMood(stateKey) {
            const entry = MOOD_TAGS[stateKey];
            if (!entry) return "Ready";
            return entry[this.currentLanguage] || entry.en || "Ready";
        }

        setExpression(exprName) {
            this.currentExpression = exprName;

            // Pause blinking if expression has closed eyes (celebrating, crying)
            if (exprName === EXPRESSIONS.CELEBRATING || exprName === EXPRESSIONS.CRYING) {
                this.blinkController.pause();
            } else {
                this.blinkController.resume();
            }

            const exprIds = [
                "comp-expr-happy",
                "comp-expr-smiling",
                "comp-expr-excited",
                "comp-expr-curious",
                "comp-expr-focused",
                "comp-expr-surprised",
                "comp-expr-confused",
                "comp-expr-disappointed",
                "comp-expr-crying",
                "comp-expr-celebrating"
            ];

            const targetId = `comp-expr-${exprName}`;
            exprIds.forEach(id => {
                const img = document.getElementById(id);
                if (img) {
                    if (id === targetId) {
                        img.classList.remove("hidden");
                        img.classList.add("is-active");
                    } else {
                        img.classList.add("hidden");
                        img.classList.remove("is-active");
                    }
                }
            });
        }

        triggerState(newState, durationMs = 0) {
            // If requested to go to IDLE, smoothly disappear
            if (newState === STATES.IDLE) {
                this.hideCompanion();
                return;
            }

            // Check priority: don't override higher priority active states unless idle
            const currentPriority = STATE_PRIORITIES[this.state] || 0;
            const newPriority = STATE_PRIORITIES[newState] || 0;

            if (newPriority < currentPriority && this.state !== STATES.IDLE && this.isVisible) {
                return;
            }

            if (this.idleReturnTimer) {
                clearTimeout(this.idleReturnTimer);
                this.idleReturnTimer = null;
            }

            // Ensure companion is revealed
            this.showCompanion();

            // Special handling: Transition from PROCESSING to SUCCESS or FAILURE
            // Let the butterfly catch sequence finish before showing celebration / crying
            if (this.state === STATES.PROCESSING && (newState === STATES.SUCCESS || newState === STATES.FAILURE)) {
                this.butterflyController.catchAndFinish(() => {
                    this._applyState(newState, durationMs);
                });
                return;
            }

            // Normal state application
            this._applyState(newState, durationMs);
        }

        _applyState(newState, durationMs = 0) {
            this.state = newState;
            const msg = this.getLocalizedMessage(newState);
            const mood = this.getLocalizedMood(newState);

            switch (newState) {
                case STATES.WELCOME:
                    this.setExpression(EXPRESSIONS.SMILING);
                    this.animationEngine.playWelcome();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 4000);
                    this._scheduleReturnToIdle(durationMs || 4200);
                    break;

                case STATES.PLATFORM_SELECTED:
                    this.setExpression(EXPRESSIONS.HAPPY);
                    this.animationEngine.playLookTowardInterface();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 3500);
                    this._scheduleReturnToIdle(durationMs || 3800);
                    break;

                case STATES.CURIOUS:
                    this.setExpression(EXPRESSIONS.CURIOUS);
                    this.animationEngine.playCurious();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 3500);
                    this._scheduleReturnToIdle(durationMs || 3800);
                    break;

                case STATES.PROCESSING:
                    this.setExpression(EXPRESSIONS.FOCUSED);
                    this.butterflyController.start();
                    if (msg) this.dialogue.show(msg, mood, 0); // Keep open during media extraction
                    break;

                case STATES.SUCCESS:
                    this.setExpression(EXPRESSIONS.CELEBRATING);
                    this.animationEngine.playCelebration();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 5000);
                    this._scheduleReturnToIdle(durationMs || 5500);
                    break;

                case STATES.FAILURE:
                    this.setExpression(EXPRESSIONS.CRYING);
                    this.animationEngine.playCrying();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 5000);
                    this._scheduleReturnToIdle(durationMs || 5500);
                    break;

                case STATES.INVALID_URL:
                    this.setExpression(EXPRESSIONS.CONFUSED);
                    this.animationEngine.playCurious();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 4200);
                    this._scheduleReturnToIdle(durationMs || 4500);
                    break;

                case STATES.NETWORK_ERROR:
                    this.setExpression(EXPRESSIONS.DISAPPOINTED);
                    this.animationEngine.playCrying();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 4500);
                    this._scheduleReturnToIdle(durationMs || 4800);
                    break;

                case STATES.IDLE:
                default:
                    this.hideCompanion();
                    break;
            }
        }

        _scheduleReturnToIdle(delayMs) {
            if (this.idleReturnTimer) {
                clearTimeout(this.idleReturnTimer);
            }
            this.idleReturnTimer = setTimeout(() => {
                this.triggerState(STATES.IDLE);
            }, delayMs);
        }

        resetToIdle() {
            this.hideCompanion(true);
        }

        destroy() {
            this.resetToIdle();
        }
    }

    const companionApi = {
        STATES,
        STATE_PRIORITIES,
        EXPRESSIONS,
        COMPANION_MESSAGES,
        MOOD_TAGS,
        BlinkController,
        ButterflyController,
        VisualNovelAnimations,
        VisualNovelDialogue,
        CompanionController,
        activeInstance: null,
        initCompanion(rootId = "companion-stage", options = {}) {
            if (typeof document === "undefined") return null;
            let stageEl = document.getElementById(rootId);
            if (!stageEl && (rootId === "anime-companion-root" || rootId === "companion-stage")) {
                stageEl = document.getElementById("companion-stage") || document.getElementById("anime-companion-root");
            }
            if (!stageEl) return null;
            const instance = new CompanionController(stageEl, options);
            companionApi.activeInstance = instance;
            if (typeof window !== "undefined") {
                window.ReevaCompanion = window.ReevaCompanion || companionApi;
                window.ReevaCompanion.activeInstance = instance;
            }
            return instance;
        },
        getInstance() {
            return companionApi.activeInstance || (typeof window !== "undefined" && window.ReevaCompanion ? window.ReevaCompanion.activeInstance : null);
        }
    };

    return companionApi;
}));
