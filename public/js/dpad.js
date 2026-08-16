/**
 * D-pad / keyboard spatial navigation
 *
 * Makes the whole UI reachable with arrow keys + Enter, as required by an
 * Android TV remote. Most clickable elements in this app are <div>s with a
 * click listener, which are not focusable by default: this module hydrates
 * them with tabindex/role as they are rendered, then implements geometric
 * spatial navigation on top.
 *
 * Existing playback shortcuts (WatchPage / LivePage / VideoPlayer listen for
 * keydown on document) are preserved: this module runs in the capture phase
 * and only swallows a key when something navigable actually holds focus.
 */

(function () {
    'use strict';

    // Clickable elements that are not natively focusable
    const CARD_SELECTOR = [
        '.movie-card',
        '.series-card',
        '.dashboard-card',
        '.channel-item',
        '.episode-item',
        '.watch-episode-item',
        '.watch-recommended-card',
        '.season-header',
        '.watch-season-header',
        '.group-header',
    ].join(',');

    // Natively focusable interactive elements
    const NATIVE_SELECTOR = 'a[href], button, input, select, textarea';

    const FOCUSABLE_SELECTOR = CARD_SELECTOR + ',' + NATIVE_SELECTOR;

    // Cross-axis misalignment weight, and penalty for candidates that do not
    // overlap the source on the cross axis (i.e. not in the same row/column).
    const CROSS_WEIGHT = 3;
    const NO_OVERLAP_PENALTY = 3000;

    // ==========================================================
    // Hydration: make card-like elements focusable
    // ==========================================================

    function hydrate(root) {
        if (!root || root.nodeType !== 1) return;

        if (root.matches?.(CARD_SELECTOR)) hydrateOne(root);
        root.querySelectorAll?.(CARD_SELECTOR).forEach(hydrateOne);
    }

    function hydrateOne(el) {
        if (el.dataset.dpad) return;
        el.dataset.dpad = '1';
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    }

    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            m.addedNodes.forEach(hydrate);
        }
    });

    // ==========================================================
    // Candidate collection
    // ==========================================================

    function isVisible(el) {
        if (el.disabled) return false;
        if (el.closest('.hidden')) return false;
        if (el.closest('.page:not(.active)')) return false;
        if (el.getAttribute('tabindex') === '-1') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function candidates() {
        return Array.from(document.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
    }

    function boxOf(el) {
        const r = el.getBoundingClientRect();
        return {
            left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            cx: r.left + r.width / 2, cy: r.top + r.height / 2
        };
    }

    /**
     * Distance score from `from` to `to` in `dir`. Lower is better,
     * Infinity means the candidate is not in that direction at all.
     */
    function score(from, to, dir) {
        let primary, cross, overlap;

        if (dir === 'right') {
            primary = to.left - from.right;
            cross = Math.abs(to.cy - from.cy);
            overlap = Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top);
        } else if (dir === 'left') {
            primary = from.left - to.right;
            cross = Math.abs(to.cy - from.cy);
            overlap = Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top);
        } else if (dir === 'down') {
            primary = to.top - from.bottom;
            cross = Math.abs(to.cx - from.cx);
            overlap = Math.min(from.right, to.right) - Math.max(from.left, to.left);
        } else {
            primary = from.top - to.bottom;
            cross = Math.abs(to.cx - from.cx);
            overlap = Math.min(from.right, to.right) - Math.max(from.left, to.left);
        }

        // Must actually lie in that direction (small tolerance for rounding)
        if (primary < -1) return Infinity;

        return Math.max(primary, 0) + cross * CROSS_WEIGHT + (overlap > 0 ? 0 : NO_OVERLAP_PENALTY);
    }

    function findNext(current, dir) {
        const from = boxOf(current);
        let best = null;
        let bestScore = Infinity;

        for (const el of candidates()) {
            if (el === current) continue;
            const s = score(from, boxOf(el), dir);
            if (s < bestScore) {
                bestScore = s;
                best = el;
            }
        }
        return best;
    }

    function focusFirst() {
        const list = candidates();
        if (!list.length) return false;

        // Topmost, then leftmost
        list.sort((a, b) => {
            const ba = boxOf(a), bb = boxOf(b);
            return (ba.top - bb.top) || (ba.left - bb.left);
        });
        list[0].focus();
        return document.activeElement === list[0];
    }

    // ==========================================================
    // Key handling
    // ==========================================================

    const DIRECTIONS = {
        ArrowRight: 'right',
        ArrowLeft: 'left',
        ArrowDown: 'down',
        ArrowUp: 'up'
    };

    // Which input device the user is currently driving the UI with. A remote
    // has no pointer, so anything that relies on hover or on "move the mouse
    // to bring it back" has to behave differently in keyboard mode.
    let keyboardMode = false;

    document.addEventListener('pointerdown', () => { keyboardMode = false; }, true);

    function isTextEntry(el) {
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'TEXTAREA') return true;
        if (tag !== 'INPUT') return false;
        return !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
    }

    function isNavigable(el) {
        return !!el && el !== document.body && el.matches?.(FOCUSABLE_SELECTOR) && isVisible(el);
    }

    /** Pages where a bare arrow press (nothing focused) drives playback. */
    function onPlayerPage() {
        const active = document.querySelector('.page.active');
        return active && (active.id === 'page-watch' || active.id === 'page-live');
    }

    function activate(el) {
        // Native controls already turn Enter/Space into a click themselves
        if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return false;
        el.click();
        return true;
    }

    /** Reveal player controls and focus the play/pause button. */
    function enterPlayerControls() {
        const page = document.querySelector('.page.active');
        if (!page) return false;

        const isWatch = page.id === 'page-watch';
        window.app?.pages?.watch?.showOverlay?.();

        const btn = document.getElementById(isWatch ? 'watch-play-pause' : 'btn-play');
        if (btn && isVisible(btn)) {
            btn.focus();
            return true;
        }
        return false;
    }

    document.addEventListener('keydown', e => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;

        const dir = DIRECTIONS[e.key];
        const isEnter = e.key === 'Enter' || e.key === ' ';
        if (!dir && !isEnter) return;

        keyboardMode = true;

        const active = document.activeElement;

        // Inside a text field or a slider, horizontal arrows belong to the
        // control (caret / value). Vertical arrows navigate out of it.
        if (isTextEntry(active) && (dir === 'left' || dir === 'right' || isEnter)) return;

        if (!isNavigable(active)) {
            // Nothing focused: on the player pages let the existing playback
            // shortcuts run, and use Enter as the way into the controls.
            if (onPlayerPage()) {
                if (isEnter && enterPlayerControls()) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                return;
            }
            if (dir && focusFirst()) {
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }

        if (isEnter) {
            if (activate(active)) {
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }

        const next = findNext(active, dir);
        if (next) {
            next.focus();
            e.preventDefault();
            e.stopPropagation();
        }
    }, true); // capture: runs before the playback shortcut listeners

    // Keep the focused element on screen
    document.addEventListener('focusin', e => {
        const el = e.target;
        if (!isNavigable(el)) return;
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });

    // ==========================================================
    // Boot
    // ==========================================================

    function start() {
        hydrate(document.body);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    // Exposed for the player overlay auto-hide guards
    window.DPad = {
        isNavigable,
        focusFirst,
        get keyboardMode() { return keyboardMode; }
    };
})();
