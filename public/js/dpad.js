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
    // Keep in sync with anything that gets a click listener but is not a
    // <button>/<a>. dpad.test.js asserts every entry here stays reachable.
    const CARD_SELECTOR = [
        '.movie-card',
        '.series-card',
        '.dashboard-card',
        '.channel-item',
        '.channel-tile',
        '.episode-item',
        '.watch-episode-item',
        '.watch-recommended-card',
        '.season-header',
        '.watch-season-header',
        '.group-header',
        '.content-group-header',
        '.epg-program',
        '.epg-channel-name',
    ].join(',');

    // Natively focusable interactive elements
    const NATIVE_SELECTOR = 'a[href], button, input, select, textarea';

    const FOCUSABLE_SELECTOR = CARD_SELECTOR + ',' + NATIVE_SELECTOR;

    // Action buttons layered on top of a card. They are real <button>s sitting
    // inside the card, so they used to be focus stops of their own and kept
    // catching the selection, which made the movie and series grids
    // impossible to walk through. A card is a single stop.
    const SKIP_SELECTOR = [
        '.favorite-btn',
        '.watchlist-btn',
        '.card-fav-btn',
        '.card-wl-btn',
        '.card-delete-btn',
        '.wl-remove-btn',
        // Sliders sit in the middle of the player control bar and would trap
        // the selection, since their arrows adjust the value instead of
        // moving on — everything past the volume slider (captions, PiP,
        // fullscreen, the overflow menu) was unreachable. A remote drives
        // them through the bare-arrow shortcuts instead: left/right seeks and
        // up/down changes the volume when no control is focused.
        'input[type="range"]',
    ].join(',');


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
        if (el.matches(SKIP_SELECTOR)) return false;
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

    /** Gap between `from` and `to` along the axis of travel. */
    function primaryDistance(from, to, dir) {
        if (dir === 'right') return to.left - from.right;
        if (dir === 'left') return from.left - to.right;
        if (dir === 'down') return to.top - from.bottom;
        return from.top - to.bottom;
    }

    /**
     * Move to the neighbour in `dir`, in two stages: first decide which row
     * (or column) we are moving into, then which element within it.
     *
     * The two stages matter. Scoring distance and alignment together lets a
     * far but perfectly aligned element beat a near but slightly offset one,
     * which made the dashboard jump over a whole section whenever the next
     * section held fewer items than the current one.
     */
    function findNext(current, dir) {
        const from = boxOf(current);
        const vertical = dir === 'down' || dir === 'up';

        const ahead = [];
        for (const el of candidates()) {
            if (el === current) continue;
            const to = boxOf(el);
            // Must lie in that direction (small tolerance for rounding)
            if (primaryDistance(from, to, dir) < -1) continue;
            // A horizontal move stays on the row it started from. Otherwise
            // anything lower down but slightly to the right wins on distance
            // alone — pressing right on a player button jumped to a
            // recommended movie below instead of the next button in the bar.
            if (!vertical && !(to.top < from.bottom && to.bottom > from.top)) continue;
            ahead.push({ el, to, primary: Math.max(primaryDistance(from, to, dir), 0) });
        }
        if (!ahead.length) return null;

        // On a row there is nothing more to decide: take the nearest.
        if (!vertical) {
            let best = ahead[0];
            for (const c of ahead) {
                if (c.primary < best.primary) best = c;
            }
            return best.el;
        }

        // Vertical move: the closest element decides which row we land in,
        // and everything vertically overlapping it belongs to that same row.
        let nearest = ahead[0];
        for (const c of ahead) {
            if (c.primary < nearest.primary) nearest = c;
        }

        const band = ahead.filter(c =>
            c.to.top <= nearest.to.bottom && c.to.bottom >= nearest.to.top);

        // Moving into a horizontal carousel enters it at its first item. The
        // row is a list, so its natural entry point is the start, not
        // whichever card happens to sit below where we came from — and the
        // row may well be scrolled somewhere else entirely. `band` is in DOM
        // order, which for a carousel is left-to-right.
        // Grids have no .horizontal-scroll ancestor and keep their column.
        const firstInRow = band.find(c => c.el.closest('.horizontal-scroll'));
        if (firstInRow) return firstInRow.el;

        // Within that row, take the closest horizontally.
        let best = null;
        let bestCross = Infinity;
        for (const c of band) {
            const cross = Math.abs(c.to.cx - from.cx);
            if (cross < bestCross) {
                bestCross = cross;
                best = c.el;
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

    /**
     * Should this horizontal arrow stay inside the control rather than move
     * the selection? Sliders always keep them. A text field keeps them only
     * while the caret still has somewhere to go: at the edges the arrow
     * leaves the field, otherwise a search box traps the selection and the
     * buttons next to it become unreachable with a remote.
     */
    function arrowBelongsToControl(el, dir) {
        if (!el) return false;
        const tag = el.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
        if (tag === 'INPUT' && el.type === 'range') return true;
        if (tag === 'INPUT' &&
            ['checkbox', 'radio', 'button', 'submit'].includes(el.type)) return false;
        if (dir !== 'left' && dir !== 'right') return false;

        const value = el.value || '';
        let start, end;
        try {
            start = el.selectionStart;
            end = el.selectionEnd;
        } catch {
            // Input types without a selection API
            return value.length > 0;
        }
        if (start === null) return value.length > 0;
        if (start !== end) return true; // something is selected
        return dir === 'left' ? start > 0 : start < value.length;
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
        if (isWatch) window.app?.pages?.watch?.showOverlay?.();

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

        // Let the control keep the key when it needs it (caret, slider value,
        // Enter to submit). Vertical arrows always navigate out.
        if (arrowBelongsToControl(active, dir)) return;
        if (isEnter && (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA')) return;

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
