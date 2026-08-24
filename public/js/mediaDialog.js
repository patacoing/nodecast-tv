/**
 * The dialog that opens on a film or a series: a hero band that becomes a
 * trailer, a body, and the handful of behaviours a dialog needs on a
 * television.
 *
 * Films and series want the same dialog, and two copies of this would
 * drift apart -- one would keep playing a trailer after closing, or lose
 * the selection back to the grid, and only one of them would ever get
 * fixed.
 *
 * Every method that acts on the current item takes a `key`: the viewer can
 * close the dialog or open another title while an image is still
 * downloading or a timer is still counting, and whatever comes back late
 * must not paint over what is on screen now.
 */

// How long the viewer has to settle on a title before its trailer starts.
const TRAILER_DELAY_MS = 5000;

// How long to wait for the closing animation before hiding regardless.
const CLOSE_FALLBACK_MS = 400;

class MediaDialog {
    /**
     * @param {object} els  { root, hero, trailer, firstFocus } elements.
     * @param {function} onClosed  called once the dialog is really hidden.
     */
    constructor(els, onClosed) {
        this.root = els.root;
        this.heroEl = els.hero;
        this.trailerEl = els.trailer;
        this.firstFocus = els.firstFocus;
        this.onClosed = onClosed;
        this.key = null;
        this.returnFocusTo = null;

        // Clicking the dimmed area closes it, the way a dialog behaves
        // anywhere with a mouse or a finger. A click inside the box bubbles
        // up here too, so the target has to be the backdrop itself:
        // closing the title because someone selected a word of the synopsis
        // would be maddening.
        this.root?.addEventListener('click', (e) => {
            if (e.target === this.root) history.back();
        });
    }

    isOpen() {
        return !!this.root && !this.root.classList.contains('hidden');
    }

    isClosing() {
        return !!this.root?.classList.contains('closing');
    }

    /** `key` is whatever identifies the title, and is echoed back later. */
    open(key) {
        this.key = key;
        this.stopTrailer();
        this.clearHero();

        // Where to put the selection back afterwards. On a remote, losing
        // your place in a grid of thousands is worse than anything the
        // dialog itself can offer.
        this.returnFocusTo = document.activeElement;

        clearTimeout(this.closeTimer);
        this.root.classList.remove('closing', 'hidden');

        // The entry animation carries a transform, which leaves the box on
        // a compositing layer of its own even after it has finished -- and
        // a video surface underneath one of those does not get painted.
        // Drop the animation the moment it is over.
        const box = this.root.querySelector('.media-modal-box');
        if (box) {
            box.classList.remove('settled');
            box.addEventListener('animationend',
                () => box.classList.add('settled'), { once: true });
            // Covers reduced motion, where no animationend is coming
            clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => box.classList.add('settled'), 400);
        }

        this.firstFocus?.focus();
    }

    /** True when it was open and is now on its way out. */
    close() {
        if (!this.isOpen()) return false;

        // The trailer goes at once rather than playing under the fade
        this.stopTrailer();
        this.clearHero();
        this.key = null;

        // Skipped when the viewer asked for less motion: no animationend is
        // coming then, and waiting for one would leave the dialog up.
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (reduced) {
            this.finish();
            return true;
        }

        this.root.classList.add('closing');
        const done = () => {
            clearTimeout(this.closeTimer);
            this.root.removeEventListener('animationend', done);
            this.finish();
        };
        this.root.addEventListener('animationend', done);
        // An animation that never starts must not strand the dialog open
        // with the grid unreachable behind it.
        this.closeTimer = setTimeout(done, CLOSE_FALLBACK_MS);
        return true;
    }

    finish() {
        clearTimeout(this.closeTimer);
        clearTimeout(this.settleTimer);
        this.root?.classList.remove('closing');
        this.root?.classList.add('hidden');
        if (this.returnFocusTo?.isConnected) this.returnFocusTo.focus();
        this.returnFocusTo = null;
        this.onClosed?.();
    }

    // ----------------------------------------------------------
    // Hero band
    // ----------------------------------------------------------

    clearHero() {
        if (!this.heroEl) return;
        this.heroEl.classList.remove('loaded', 'is-poster');
        this.heroEl.removeAttribute('src');
    }

    /**
     * Put the one image up, once it has actually downloaded. Setting src
     * directly paints it in strips as it arrives over the network, which on
     * a television is worse than a moment of empty band -- and showing the
     * poster first and swapping it later reads as loading twice.
     */
    setHero(key, backdrop, poster) {
        const url = backdrop || poster;
        if (!this.heroEl || !url) return;

        const probe = new Image();
        probe.onload = () => {
            if (this.key !== key) return;
            // A 2:3 poster stretched across a 16:9 band shows a strip of
            // chin, so it is fitted rather than cropped when standing in.
            this.heroEl.classList.toggle('is-poster', !backdrop);
            this.heroEl.src = url;
            this.heroEl.classList.add('loaded');
        };
        probe.onerror = () => {
            // The provider's image host is not always up.
            if (this.key !== key || !backdrop || !poster) return;
            this.setHero(key, null, poster);
        };
        probe.src = url;
    }

    // ----------------------------------------------------------
    // Trailer
    // ----------------------------------------------------------

    /**
     * Start the trailer once the viewer has settled rather than
     * immediately: opening a page should not fire motion at someone still
     * walking through the grid.
     */
    armTrailer(key, videoId) {
        this.stopTrailer();
        if (!videoId) return;
        this.trailerTimer = setTimeout(() => {
            if (this.key === key && this.isOpen() && !this.isClosing()) {
                this.playTrailer(videoId);
            }
        }, TRAILER_DELAY_MS);
    }

    playTrailer(videoId) {
        if (!this.trailerEl || !this.heroEl) return;

        // The iframe does not live in the dialog. An Android WebView paints
        // a video surface only for an iframe sitting in a plain fixed layer
        // near the root; nested inside the dialog's box and hero it stays
        // black however the ancestors' clipping and animation are stripped.
        // Established on the device: the same iframe, same page, renders as
        // a child of body and does not render inside the hero.
        //
        // So it is put in a fixed layer of its own, parked exactly over the
        // hero's rectangle and kept there. The dialog looks unchanged.
        const layer = document.createElement('div');
        layer.className = 'trailer-layer';

        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`
            + '?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0'
            + '&playsinline=1&iv_load_policy=3';
        // Muted, because a browser refuses to autoplay anything else, and
        // because a trailer blaring out while you browse is not wanted.
        // tabindex=-1 keeps the d-pad out of the iframe: the selection has
        // to stay on the Play button.
        iframe.allow = 'autoplay; encrypted-media';
        iframe.setAttribute('tabindex', '-1');
        iframe.setAttribute('title', 'Trailer');
        iframe.setAttribute('frameborder', '0');
        layer.appendChild(iframe);

        document.body.appendChild(layer);
        this.trailerLayer = layer;

        // On the television the trailer takes the whole screen. Not a
        // stylistic choice: this WebView hands a playing video to a
        // hardware overlay, and it only paints that overlay when the player
        // is full screen. The identical iframe, in the identical layer,
        // renders at 960x540 and stays black at 368x207. Established by
        // resizing it on the device and watching the picture appear.
        if (document.documentElement.classList.contains('tv-mode')) {
            layer.classList.add('trailer-layer-full');
            // Any key brings the viewer back to the film rather than
            // navigating a dialog they can no longer see.
            this.dismissTrailer = (e) => {
                if (e.altKey || e.ctrlKey || e.metaKey) return;
                this.stopTrailer();
                e.preventDefault();
                e.stopPropagation();
            };
            // On window, so it runs before the d-pad's own capture listener
            window.addEventListener('keydown', this.dismissTrailer, true);
        } else {
            this.positionTrailer();
            // The box scrolls under it, so the layer has to follow the hero
            this.trackTrailer = () => this.positionTrailer();
            this.scroller = this.root.querySelector('.media-modal-box');
            this.scroller?.addEventListener('scroll', this.trackTrailer, { passive: true });
            window.addEventListener('resize', this.trackTrailer);
        }

        this.root?.classList.add('trailer-playing');
    }

    /** Keep the layer exactly over the hero band. */
    positionTrailer() {
        if (!this.trailerLayer || !this.heroEl) return;
        const r = this.heroEl.getBoundingClientRect();
        // Scrolled out of sight: hide rather than float over the text
        const visible = r.bottom > 0 && r.top < window.innerHeight && r.height > 0;
        const s = this.trailerLayer.style;
        s.display = visible ? 'block' : 'none';
        s.left = r.left + 'px';
        s.top = r.top + 'px';
        s.width = r.width + 'px';
        s.height = r.height + 'px';
    }

    stopTrailer() {
        clearTimeout(this.trailerTimer);
        this.trailerTimer = null;

        this.scroller?.removeEventListener('scroll', this.trackTrailer);
        window.removeEventListener('resize', this.trackTrailer);
        this.scroller = null;
        this.trackTrailer = null;

        if (this.dismissTrailer) {
            window.removeEventListener('keydown', this.dismissTrailer, true);
            this.dismissTrailer = null;
        }

        // Removing the layer is what stops playback: an iframe merely
        // hidden keeps its audio and its network stream running.
        this.trailerLayer?.remove();
        this.trailerLayer = null;

        if (this.trailerEl) {
            this.trailerEl.replaceChildren();
            this.trailerEl.hidden = true;
        }
        this.root?.classList.remove('trailer-playing');
    }
}

window.MediaDialog = MediaDialog;
