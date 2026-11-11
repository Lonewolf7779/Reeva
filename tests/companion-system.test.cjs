// tests/companion-system.test.cjs — Automated Tests for Anime Girl Companion System
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const companionModule = require("../public/js/companion.js");

// Helper to create a functional mock DOM environment for CompanionController
function createMockDOM() {
    const classListMap = new Map();
    const attrMap = new Map();
    const styleMap = new Map();
    const listeners = new Map();

    function createMockElement(id, classes = []) {
        const clsList = new Set(classes);
        classListMap.set(id, clsList);
        attrMap.set(id, new Map());
        styleMap.set(id, {});
        listeners.set(id, new Map());

        const el = {
            id,
            classList: {
                add(...names) { names.forEach(n => clsList.add(n)); },
                remove(...names) { names.forEach(n => clsList.delete(n)); },
                contains(name) { return clsList.has(name); },
                toggle(name, force) {
                    if (force !== undefined) {
                        force ? clsList.add(name) : clsList.delete(name);
                    } else {
                        clsList.has(name) ? clsList.delete(name) : clsList.add(name);
                    }
                }
            },
            setAttribute(k, v) { attrMap.get(id).set(k, String(v)); },
            getAttribute(k) { return attrMap.get(id).get(k) || null; },
            removeAttribute(k) { attrMap.get(id).delete(k); },
            style: styleMap.get(id),
            textContent: "",
            offsetWidth: 256,
            offsetHeight: 322,
            addEventListener(evt, handler) {
                if (!listeners.get(id).has(evt)) listeners.get(id).set(evt, []);
                listeners.get(id).get(evt).push(handler);
            },
            removeEventListener(evt, handler) {
                if (!listeners.get(id).has(evt)) return;
                const arr = listeners.get(id).get(evt).filter(h => h !== handler);
                listeners.get(id).set(evt, arr);
            },
            dispatchEvent(evt) {
                const arr = listeners.get(id).get(evt) || [];
                arr.forEach(h => h({ target: el }));
            }
        };
        return el;
    }

    const elements = {
        "companion-stage": createMockElement("companion-stage", ["widget-card", "companion-stage", "is-hidden"]),
        "companion-dialogue": createMockElement("companion-dialogue", ["companion-dialogue-card", "hidden"]),
        "companion-dialogue-text": createMockElement("companion-dialogue-text"),
        "companion-dialogue-close": createMockElement("companion-dialogue-close"),
        "companion-mood-tag": createMockElement("companion-mood-tag"),
        "comp-butterfly": createMockElement("comp-butterfly", ["comp-butterfly", "hidden"]),
        "comp-sprite-container": createMockElement("comp-sprite-container", ["companion-sprite-container"]),
        "comp-eyelids": createMockElement("comp-eyelids", ["comp-eyelids"]),
        "comp-expr-happy": createMockElement("comp-expr-happy", ["comp-expr-img"]),
        "comp-expr-smiling": createMockElement("comp-expr-smiling", ["comp-expr-img", "hidden"]),
        "comp-expr-excited": createMockElement("comp-expr-excited", ["comp-expr-img", "hidden"]),
        "comp-expr-curious": createMockElement("comp-expr-curious", ["comp-expr-img", "hidden"]),
        "comp-expr-focused": createMockElement("comp-expr-focused", ["comp-expr-img", "hidden"]),
        "comp-expr-surprised": createMockElement("comp-expr-surprised", ["comp-expr-img", "hidden"]),
        "comp-expr-confused": createMockElement("comp-expr-confused", ["comp-expr-img", "hidden"]),
        "comp-expr-disappointed": createMockElement("comp-expr-disappointed", ["comp-expr-img", "hidden"]),
        "comp-expr-crying": createMockElement("comp-expr-crying", ["comp-expr-img", "hidden"]),
        "comp-expr-celebrating": createMockElement("comp-expr-celebrating", ["comp-expr-img", "hidden"])
    };

    const workspaceLayout = createMockElement("workspace-layout", ["workspace-layout"]);

    const mockDoc = {
        getElementById(id) {
            return elements[id] || null;
        },
        querySelector(sel) {
            if (sel === ".workspace-layout") return workspaceLayout;
            return null;
        }
    };

    return {
        doc: mockDoc,
        elements,
        workspaceLayout
    };
}

// =========================================================================
// 1. Static HTML & Asset Tests
// =========================================================================

test("Companion System: index.html hides companion stage by default on initial page load", () => {
    const htmlPath = path.join(__dirname, "../public/index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Stage must have is-hidden and aria-hidden="true"
    assert.match(
        html,
        /<aside[^>]*id="companion-stage"[^>]*class="[^"]*\bis-hidden\b[^"]*"[^>]*aria-hidden="true"/,
        "companion-stage must be marked is-hidden and aria-hidden='true' by default"
    );

    // Dialogue card must have hidden class initially
    assert.match(
        html,
        /<div[^>]*id="companion-dialogue"[^>]*class="[^"]*\bhidden\b[^"]*"/,
        "companion-dialogue must have hidden class initially"
    );

    // Eyelids overlay image must be present
    assert.match(
        html,
        /id="comp-eyelids"[^>]*src="\/img\/companion\/eyelids-closed\.png"/,
        "comp-eyelids overlay image must be present in index.html"
    );

    // Interactive butterfly must be present
    assert.match(
        html,
        /id="comp-butterfly"[^>]*class="[^"]*\bcomp-butterfly\b[^"]*"/,
        "comp-butterfly element must be present in index.html"
    );
});

test("Companion System: All 10 visual novel expressions and eyelid artwork exist on disk", () => {
    const exprDir = path.join(__dirname, "../public/img/companion/expressions");
    const requiredExpressions = [
        "happy.png",
        "smiling.png",
        "excited.png",
        "curious.png",
        "focused.png",
        "surprised.png",
        "confused.png",
        "disappointed.png",
        "crying.png",
        "celebrating.png"
    ];

    for (const expr of requiredExpressions) {
        const filePath = path.join(exprDir, expr);
        assert.ok(fs.existsSync(filePath), `Expression artwork ${expr} must exist`);
        const stat = fs.statSync(filePath);
        assert.ok(stat.size > 1000, `Expression ${expr} must be valid non-empty image (size=${stat.size} bytes)`);
    }

    const eyelidPath = path.join(__dirname, "../public/img/companion/eyelids-closed.png");
    assert.ok(fs.existsSync(eyelidPath), "Eyelids overlay eyelids-closed.png must exist");
    const eyelidStat = fs.statSync(eyelidPath);
    assert.ok(eyelidStat.size > 500, `Eyelids image must be valid non-empty file (size=${eyelidStat.size} bytes)`);
});

// =========================================================================
// 2. Lifecycle & Contextual Visibility Tests
// =========================================================================

test("Companion System: Initial state is hidden; triggerState contextually reveals companion", () => {
    const { doc, elements, workspaceLayout } = createMockDOM();
    const origDoc = global.document;
    global.document = doc;

    try {
        const companion = companionModule.initCompanion("companion-stage", { initialLanguage: "en" });
        assert.ok(companion, "CompanionController must initialize successfully");
        assert.strictEqual(companion.isVisible, false, "Companion must start with isVisible=false");
        assert.ok(elements["companion-stage"].classList.contains("is-hidden"), "Stage must have is-hidden initially");
        assert.ok(!workspaceLayout.classList.contains("has-active-companion"), "Workspace must not have has-active-companion");

        // User interacts with downloader (focus / paste triggers CURIOUS)
        companion.triggerState(companionModule.STATES.CURIOUS);

        assert.strictEqual(companion.isVisible, true, "Companion must become visible on interaction");
        assert.ok(!elements["companion-stage"].classList.contains("is-hidden"), "is-hidden must be removed");
        assert.strictEqual(elements["companion-stage"].getAttribute("aria-hidden"), "false");
        assert.ok(workspaceLayout.classList.contains("has-active-companion"), "Workspace must have has-active-companion");
        assert.strictEqual(companion.currentExpression, companionModule.EXPRESSIONS.CURIOUS);

        companion.destroy();
    } finally {
        global.document = origDoc;
    }
});

test("Companion System: Expression mapping strictly aligns with application lifecycle states", () => {
    const { doc, elements } = createMockDOM();
    const origDoc = global.document;
    global.document = doc;

    try {
        const companion = companionModule.initCompanion("companion-stage", { initialLanguage: "en" });

        const mappings = [
            { state: companionModule.STATES.WELCOME, expr: companionModule.EXPRESSIONS.SMILING },
            { state: companionModule.STATES.CURIOUS, expr: companionModule.EXPRESSIONS.CURIOUS },
            { state: companionModule.STATES.PLATFORM_SELECTED, expr: companionModule.EXPRESSIONS.HAPPY },
            { state: companionModule.STATES.PROCESSING, expr: companionModule.EXPRESSIONS.FOCUSED },
            { state: companionModule.STATES.SUCCESS, expr: companionModule.EXPRESSIONS.CELEBRATING },
            { state: companionModule.STATES.FAILURE, expr: companionModule.EXPRESSIONS.CRYING },
            { state: companionModule.STATES.INVALID_URL, expr: companionModule.EXPRESSIONS.CONFUSED },
            { state: companionModule.STATES.NETWORK_ERROR, expr: companionModule.EXPRESSIONS.DISAPPOINTED }
        ];

        for (const m of mappings) {
            companion.resetToIdle();
            companion.triggerState(m.state);
            assert.strictEqual(
                companion.currentExpression,
                m.expr,
                `State ${m.state} must map to expression ${m.expr}`
            );
            assert.ok(
                elements[`comp-expr-${m.expr}`].classList.contains("is-active"),
                `Active sprite comp-expr-${m.expr} must have is-active class`
            );
        }

        companion.destroy();
    } finally {
        global.document = origDoc;
    }
});

// =========================================================================
// 3. Processing Lifecycle & Butterfly Coordination Tests
// =========================================================================

test("Companion System: Processing starts butterfly; finishing triggers catch sequence before celebration", (t, done) => {
    const { doc, elements } = createMockDOM();
    const origDoc = global.document;
    global.document = doc;

    try {
        const companion = companionModule.initCompanion("companion-stage", { initialLanguage: "en" });

        // Start processing state
        companion.triggerState(companionModule.STATES.PROCESSING);
        assert.strictEqual(companion.state, companionModule.STATES.PROCESSING);
        assert.strictEqual(companion.currentExpression, companionModule.EXPRESSIONS.FOCUSED);
        assert.strictEqual(companion.butterflyController.isActive, true, "Butterfly must be active during PROCESSING");
        assert.ok(elements["comp-butterfly"].classList.contains("is-active"), "Butterfly must have is-active class");

        // Transition from PROCESSING to SUCCESS triggers catch sequence
        companion.triggerState(companionModule.STATES.SUCCESS);

        // Butterfly controller should enter catch mode
        assert.strictEqual(companion.butterflyController.isCatching, true, "Butterfly must enter catching sequence");

        // Wait for catch sequence to complete and celebration state to apply
        setTimeout(() => {
            assert.strictEqual(companion.state, companionModule.STATES.SUCCESS);
            assert.strictEqual(companion.currentExpression, companionModule.EXPRESSIONS.CELEBRATING);
            assert.strictEqual(companion.butterflyController.isActive, false, "Butterfly must stop after catch");

            companion.destroy();
            done();
        }, 700);
    } catch (err) {
        global.document = origDoc;
        done(err);
    }
});

// =========================================================================
// 4. Return to Idle & Disappearance Tests
// =========================================================================

test("Companion System: Return to idle smoothly dismisses companion and restores workspace layout", (t, done) => {
    const { doc, elements, workspaceLayout } = createMockDOM();
    const origDoc = global.document;
    global.document = doc;

    try {
        const companion = companionModule.initCompanion("companion-stage", { initialLanguage: "en" });

        companion.triggerState(companionModule.STATES.CURIOUS);
        assert.strictEqual(companion.isVisible, true);
        assert.ok(workspaceLayout.classList.contains("has-active-companion"));

        // Trigger return to IDLE
        companion.triggerState(companionModule.STATES.IDLE);

        // Stage begins exiting animation
        assert.ok(elements["companion-stage"].classList.contains("is-exiting"), "Stage must have is-exiting class");

        setTimeout(() => {
            assert.strictEqual(companion.isVisible, false, "Companion must be hidden after exit transition");
            assert.ok(elements["companion-stage"].classList.contains("is-hidden"), "Stage must have is-hidden class");
            assert.ok(!workspaceLayout.classList.contains("has-active-companion"), "Workspace must remove has-active-companion");
            assert.strictEqual(elements["companion-stage"].getAttribute("aria-hidden"), "true");

            companion.destroy();
            done();
        }, 350);
    } catch (err) {
        global.document = origDoc;
        done(err);
    }
});

// =========================================================================
// 5. Localization & Dialogue Tests
// =========================================================================

test("Companion System: Bilingual dialogue contains non-empty messages and updates dynamically", () => {
    const { doc, elements } = createMockDOM();
    const origDoc = global.document;
    global.document = doc;

    try {
        const companion = companionModule.initCompanion("companion-stage", { initialLanguage: "en" });

        // English check
        companion.triggerState(companionModule.STATES.SUCCESS);
        assert.strictEqual(elements["companion-dialogue-text"].textContent, "There we go! Your media is ready.");
        assert.strictEqual(elements["companion-mood-tag"].textContent, "Success!");

        // Switch to Hindi
        companion.setLanguage("hi");
        assert.strictEqual(elements["companion-dialogue-text"].textContent, "ये रहा! आपका मीडिया तैयार है।");
        assert.strictEqual(elements["companion-mood-tag"].textContent, "सफल!");

        companion.destroy();
    } finally {
        global.document = origDoc;
    }
});

// =========================================================================
// 6. Blinking & Eyelids Layer Tests
// =========================================================================

test("Companion System: BlinkController pauses blinking on closed-eye expressions and cleans up", () => {
    const { doc, elements } = createMockDOM();
    const origDoc = global.document;
    global.document = doc;

    try {
        const companion = companionModule.initCompanion("companion-stage", { initialLanguage: "en" });
        companion.showCompanion();

        assert.strictEqual(companion.blinkController.isActive, true, "Blink controller must be active when visible");
        assert.strictEqual(companion.blinkController.isPaused, false, "Blink controller must not be paused initially");

        // When switching to celebrating (closed happy eyes), blinking must be paused
        companion.setExpression(companionModule.EXPRESSIONS.CELEBRATING);
        assert.strictEqual(companion.blinkController.isPaused, true, "Blink controller must pause on celebrating expression");

        // When switching back to happy, blinking resumes
        companion.setExpression(companionModule.EXPRESSIONS.HAPPY);
        assert.strictEqual(companion.blinkController.isPaused, false, "Blink controller must resume on happy expression");

        // Stop cleans up timer and classes
        companion.hideCompanion(true);
        assert.strictEqual(companion.blinkController.isActive, false, "Blink controller must stop on hide");
        assert.ok(!elements["comp-eyelids"].classList.contains("is-blinking"));

        companion.destroy();
    } finally {
        global.document = origDoc;
    }
});

// =========================================================================
// 7. Reduced Motion Support Tests
// =========================================================================

test("Companion System: CSS and JS respect prefers-reduced-motion", () => {
    const cssPath = path.join(__dirname, "../public/styles.css");
    const css = fs.readFileSync(cssPath, "utf8");

    assert.ok(
        css.includes("@media (prefers-reduced-motion: reduce)"),
        "styles.css must contain @media (prefers-reduced-motion: reduce)"
    );

    assert.ok(
        css.includes(".companion-sprite-container.is-breathing"),
        "prefers-reduced-motion must target breathing animation"
    );

    assert.ok(
        css.includes(".wing-left") && css.includes(".wing-right"),
        "prefers-reduced-motion must target butterfly wing animations"
    );
});
