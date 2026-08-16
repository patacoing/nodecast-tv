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
        if (r.width <= 0 || r.height <= 0) return false;

        // A visibility:hidden element keeps a perfectly valid rect but cannot
        // take focus, so .focus() fails silently and the selection appears
        // frozen. The collapsed channel sidebar hides its header that way.
        if (el.checkVisibility) {
            return el.checkVisibility({ checkVisibilityCSS: true });
        }
        return getComputedStyle(el).visibility !== 'hidden';
    }

    function candidates() {
        // While something is fullscreen, everything else is covered but still
        // sits in the page with perfectly valid coordinates. Without this the
        // selection wanders out of the player onto the navbar behind it and
        // simply appears to do nothing.
        const root = document.querySelector('.css-fullscreen')
            || document.fullscreenElement
            || document;
        return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
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
    function findNext(current, dir, excluded) {
        const from = boxOf(current);
        const vertical = dir === 'down' || dir === 'up';

        const ahead = [];
        for (const el of candidates()) {
            if (el === current) continue;
            if (excluded && excluded.has(el)) continue;
            const to = boxOf(el);
            // Must lie in that direction (small tolerance for rounding)
            if (primaryDistance(from, to, dir) < -1) continue;
            ahead.push({ el, to, primary: Math.max(primaryDistance(from, to, dir), 0) });
        }
        if (!ahead.length) return null;

        if (!vertical) {
            // Prefer whatever shares the row we started from, so that moving
            // along the player bar cannot fall into the recommended movies
            // sitting lower down. When the row holds nothing further in that
            // direction, leaving it is the only sensible move — that is how
            // you get from the Live TV channel list, a tall column on the
            // left, to the player controls pinned at the bottom right.
            const sameRow = ahead.filter(c => c.to.top < from.bottom && c.to.bottom > from.top);

            let best = null;
            let bestScore = Infinity;
            for (const c of (sameRow.length ? sameRow : ahead)) {
                // On the row, the gap alone decides. When leaving it, plain
                // straight-line distance is the honest measure: adding the
                // axes up instead favoured whatever sat closest to the edge
                // of the screen, which sent the selection to the navbar
                // rather than to the sidebar's expand button.
                const s = sameRow.length
                    ? c.primary
                    : Math.hypot(c.to.cx - from.cx, c.to.cy - from.cy);
                if (s < bestScore) {
                    bestScore = s;
                    best = c;
                }
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
        // Same caution as findNext: an element may refuse focus.
        for (const el of list.slice(0, 5)) {
            el.focus();
            if (document.activeElement === el) return true;
        }
        return false;
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

    /**
     * Mirrored onto <html> as .dpad-active so CSS can react. A remote never
     * hovers, so anything that only shows itself on mouse activity is
     * invisible forever otherwise — which left the collapsed channel sidebar
     * with no reachable way back.
     */
    function setKeyboardMode(on) {
        if (keyboardMode === on) return;
        keyboardMode = on;
        document.documentElement.classList.toggle('dpad-active', on);
    }

    document.addEventListener('pointerdown', () => setKeyboardMode(false), true);

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

    /**
     * Any key is the remote's equivalent of moving the mouse: it has to keep
     * the player controls on screen and restart their countdown. Navigation
     * keys are consumed here before the players ever see them, so the signal
     * has to come from this side too.
     */
    function keepPlayerControlsAwake() {
        const page = document.querySelector('.page.active');
        if (!page) return;
        if (page.id === 'page-watch') window.app?.pages?.watch?.showOverlay?.();
        else if (page.id === 'page-live') window.app?.player?.showOverlay?.();
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

    let lastDecision = '(rien)';

    function decide(e) {
        const dir = DIRECTIONS[e.key];
        const isEnter = e.key === 'Enter' || e.key === ' ';

        setKeyboardMode(true);
        keepPlayerControlsAwake();

        const active = document.activeElement;

        // Let the control keep the key when it needs it (caret, slider value,
        // Enter to submit). Vertical arrows always navigate out.
        if (arrowBelongsToControl(active, dir)) return 'laissée au champ/slider';
        if (isEnter && (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA')) {
            return 'entrée laissée au champ';
        }

        if (!isNavigable(active)) {
            // Nothing focused on a player page. Horizontal arrows stay with
            // playback — seeking and volume, the way a TV player behaves —
            // while Enter and the vertical arrows are how you reach the
            // interface. Leaving every arrow to playback meant that a page
            // with nothing playing, such as Live TV before a channel is
            // picked, could not be entered at all.
            if (onPlayerPage()) {
                const wantsIn = isEnter || dir === 'up' || dir === 'down';
                if (!wantsIn) return 'rien de sélectionné, laissée à la lecture';
                if (enterPlayerControls() || focusFirst()) {
                    e.preventDefault();
                    e.stopPropagation();
                    return 'entrée dans l\'interface';
                }
                return 'rien de sélectionné, aucune cible';
            }
            if (dir && focusFirst()) {
                e.preventDefault();
                e.stopPropagation();
                return 'première cible sélectionnée';
            }
            return 'rien de sélectionné, aucune cible';
        }

        if (isEnter) {
            if (activate(active)) {
                e.preventDefault();
                e.stopPropagation();
                return 'activé';
            }
            return 'activation laissée au navigateur';
        }

        // An element can look perfectly focusable and still refuse focus.
        // Rather than trust it, check that the focus actually landed and move
        // on to the next best candidate when it did not.
        const refused = new Set();
        for (let attempt = 0; attempt < 5; attempt++) {
            const next = findNext(active, dir, refused);
            if (!next) break;

            next.focus();
            if (document.activeElement === next) {
                e.preventDefault();
                e.stopPropagation();
                return 'déplacé vers ' + (next.id || next.className || next.tagName);
            }
            refused.add(next);
        }
        return 'AUCUNE CIBLE dans cette direction';
    }

    document.addEventListener('keydown', e => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (!DIRECTIONS[e.key] && e.key !== 'Enter' && e.key !== ' ') return;

        // TEMPORAIRE : le try/catch et lastDecision servent au panneau de
        // diagnostic. Sans cela, une exception ici passerait totalement
        // inaperçue — la touche serait reçue et rien ne bougerait.
        try {
            lastDecision = decide(e) || '(sans effet)';
        } catch (err) {
            lastDecision = 'ERREUR ' + (err && err.message);
            console.error('[DPad]', err);
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
        get keyboardMode() { return keyboardMode; },
        // TEMPORAIRE : lu par le panneau de diagnostic
        get lastDecision() { return lastDecision; }
    };

    // ==========================================================
    // Fullscreen inside the Android TV wrapper
    // ==========================================================

    // The wrapper appends this to its user agent. Its activity already fills
    // the screen, so the Fullscreen API buys nothing there — and going
    // through it leaves the WebView's video surface at its previous size,
    // which paints the picture small in the top-left corner with black bands
    // to the right and below. Lay it out in CSS instead.
    const inAndroidWrapper = / NodeCastTV-Android\//.test(navigator.userAgent);

    window.Fullscreen = {
        inAndroidWrapper,

        isOn(element) {
            return inAndroidWrapper
                ? !!element?.classList.contains('css-fullscreen')
                : !!(document.fullscreenElement || document.webkitFullscreenElement);
        },

        /** Returns true when it handled the toggle itself. */
        toggle(element) {
            if (!inAndroidWrapper || !element) return false;
            element.classList.toggle('css-fullscreen');
            return true;
        }
    };
})();
