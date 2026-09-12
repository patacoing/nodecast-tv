/**
 * Tests for putting a stalled live channel back on the air.
 *
 * These were written against measurements from the Fire TV rather than
 * from reasoning. What the recorder caught was: the provider answers a
 * playlist refresh with 403, the player retries three times, gives up and
 * switches to the proxy -- and stays there. The account allows two
 * simultaneous connections; on the proxy the playlist is fetched by the
 * server while the segments are still fetched by the device, so one
 * channel then holds both. Measured at 1/2 direct and 2/2 proxied.
 *
 * The fallback meant to rescue playback was therefore what kept it broken,
 * and the branch handling an error while already proxied called
 * startLoad() with no delay and no limit.
 *
 * VideoPlayer is far too entangled with the DOM to construct here, so the
 * two decision-making methods are lifted onto a stand-in with just the
 * fields they touch. That is a copy of the wiring, not of the logic.
 */
const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'components', 'VideoPlayer.js'), 'utf8');

/** Pull one method's source out of the class by name. */
function lift(name) {
    const start = SRC.indexOf(`\n    ${name}(`);
    assert.notEqual(start, -1, `${name} not found in VideoPlayer.js`);
    // Methods are indented four spaces, so the closing brace is the first
    // line that is exactly "    }"
    const end = SRC.indexOf('\n    }', start);
    assert.notEqual(end, -1, `end of ${name} not found`);
    return SRC.slice(start, end + 6);
}

const CONSTANTS = ['NETWORK_MAX_RETRIES', 'NETWORK_SLOW_RETRY_MS', 'STALL_SECONDS']
    .map(n => {
        const m = SRC.match(new RegExp(`^const ${n} = (.+);$`, 'm'));
        assert.ok(m, `${n} not found`);
        return `const ${n} = ${m[1]};`;
    }).join('\n');

// The method logs what it is doing, which is useful on a television and
// noise in a test run.
const quiet = { log() { }, warn() { }, error() { } };

const Stub = new Function('console', `
    ${CONSTANTS}
    return class Stub {
        constructor() {
            this.reloads = [];
            this.status = null;
            this.hls = { startLoad: (n) => this.reloads.push({ startLoad: n }) };
            this.video = { paused: false, play: () => Promise.resolve() };
            this.currentUrl = 'http://provider/live/1.m3u8';
            this.currentChannel = { name: 'TF1' };
        }
        getProxiedUrl(u) { return '/api/proxy/stream?url=' + encodeURIComponent(u); }
        updateTranscodeStatus(mode, text) { this.status = text || mode; }
        showError(m) { this.status = 'ERROR: ' + m; }
        reloadAfter(delay, url) { this.reloads.push({ delay, url }); }
        ${lift('recoverNetworkError')}
    };
`)(quiet);

/** An hls.js error object as the recorder saw them. */
const refused = code => ({ details: 'levelLoadError', response: { code } });
const noAnswer = { details: 'levelLoadError', response: {} };

describe('recovering a live stream', () => {
    let p;
    beforeEach(() => { p = new Stub(); });

    it('retries a refusal directly instead of reaching for the proxy', () => {
        // 403 is an answer. The proxy gets the same answer and spends the
        // account's other connection to hear it.
        for (let i = 0; i < 5; i++) p.recoverNetworkError(refused(403));
        assert.equal(p.isUsingProxy, undefined, 'must not switch to the proxy');
        assert.equal(p.reloads.every(r => !r.url), true, 'must stay on the same source');
    });

    it('backs off rather than retrying in a tight loop', () => {
        for (let i = 0; i < 4; i++) p.recoverNetworkError(refused(403));
        const delays = p.reloads.map(r => r.delay);
        assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
    });

    it('caps the backoff so a live channel stays watchable', () => {
        for (let i = 0; i < 6; i++) p.recoverNetworkError(refused(503));
        assert.equal(Math.max(...p.reloads.map(r => r.delay)), 8000);
    });

    it('keeps trying slowly instead of giving up for good', () => {
        // Stopping altogether is the behaviour being fixed: a channel that
        // comes back on its own must come back without anyone reaching for
        // the remote.
        for (let i = 0; i < 9; i++) p.recoverNetworkError(refused(403));
        const last = p.reloads[p.reloads.length - 1];
        assert.equal(last.delay, 15000);
        assert.match(p.status, /Reconnecting/);
    });

    it('still uses the proxy when nothing answered at all', () => {
        // No HTTP status is what a CORS or DNS failure looks like from
        // here, and that is the one thing the proxy can actually fix.
        for (let i = 0; i < 3; i++) p.recoverNetworkError(noAnswer);
        assert.equal(p.isUsingProxy, true);
        assert.match(p.reloads[2].url, /^\/api\/proxy/);
    });

    it('comes back off the proxy when it is not helping', () => {
        for (let i = 0; i < 3; i++) p.recoverNetworkError(noAnswer);
        assert.equal(p.isUsingProxy, true);
        for (let i = 0; i < 3; i++) p.recoverNetworkError(noAnswer);
        assert.equal(p.isUsingProxy, false, 'must not stay proxied for ever');
        assert.equal(p.reloads[p.reloads.length - 1].url, p.currentUrl);
    });

    it('treats trouble half an hour later as a fresh start', () => {
        for (let i = 0; i < 4; i++) p.recoverNetworkError(refused(403));
        p.lastNetworkErrorTime = Date.now() - 60000;
        p.recoverNetworkError(refused(403));
        assert.equal(p.reloads[p.reloads.length - 1].delay, 1000);
    });
});
