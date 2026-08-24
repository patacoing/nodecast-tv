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
        if (!this.trailerEl) return;

        // Muted, because a browser refuses to autoplay anything else, and
        // because a trailer blaring out while you browse is not wanted.
        // tabindex=-1 keeps the d-pad out of the iframe: the selection has
        // to stay on the Play button in front of it.
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`
            + '?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0'
            + '&playsinline=1&iv_load_policy=3';
        iframe.allow = 'autoplay; encrypted-media';
        iframe.setAttribute('tabindex', '-1');
        iframe.setAttribute('title', 'Trailer');
        iframe.setAttribute('frameborder', '0');

        this.trailerEl.replaceChildren(iframe);
        this.trailerEl.hidden = false;
        this.root?.classList.add('trailer-playing');
    }

    stopTrailer() {
        clearTimeout(this.trailerTimer);
        this.trailerTimer = null;
        if (this.trailerEl) {
            // Emptying the host is what stops playback: a hidden iframe
            // keeps its audio and its network stream running.
            this.trailerEl.replaceChildren();
            this.trailerEl.hidden = true;
        }
        this.root?.classList.remove('trailer-playing');
    }
}

window.MediaDialog = MediaDialog;
