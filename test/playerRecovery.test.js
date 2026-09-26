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

    it('says so when the channel answers with no playlist at all', () => {
        // Measured on TF1 HD: 200 with an empty body, identical direct and
        // through the proxy. Reconnecting for ever against that is a black
        // screen with a reassuring caption on it.
        const dead = { details: 'manifestParsingError', response: { code: 200 } };
        p.recoverNetworkError(dead);
        p.recoverNetworkError(dead);
        assert.match(p.status, /ERROR: .*not broadcasting/);
        const before = p.reloads.length;
        p.recoverNetworkError(dead);
        assert.equal(p.reloads.length, before, 'must stop retrying');
    });

    it('does not reach for the proxy on a 200 that was not a playlist', () => {
        // An HTTP answer is an answer, whatever its status: the proxy gets
        // the same body and spends the account's other connection on it
        p.recoverNetworkError({ details: 'manifestParsingError', response: { code: 200 } });
        assert.equal(p.isUsingProxy, undefined);
    });

    it('treats trouble half an hour later as a fresh start', () => {
        for (let i = 0; i < 4; i++) p.recoverNetworkError(refused(403));
        p.lastNetworkErrorTime = Date.now() - 60000;
        p.recoverNetworkError(refused(403));
        assert.equal(p.reloads[p.reloads.length - 1].delay, 1000);
    });
});

/**
 * The stall watchdog.
 *
 * Two measurements shaped this, both from the Fire TV rather than from
 * reasoning:
 *
 * - `video.seeking` was stuck true. hls.js nudges the position when the
 *   buffer stalls, the seek never completed on a decoder with no usable
 *   data, and the first version of the watchdog bailed out whenever
 *   seeking was true -- which is why it never once fired.
 *
 * - The position advanced in thirty second jumps while 420 frames were
 *   decoded in ten minutes. So currentTime moving is not evidence that
 *   anything is playing: setting it is how a stalled player tries to
 *   escape, and watching it means mistaking the attempts at recovery for
 *   recovery. The frame counter is what tells the truth.
 */
describe('the stall watchdog', () => {
    const WATCH = lift('startStallWatchdog');

    /** A player whose clock, frames and element the test drives by hand. */
    function harness(opts = {}) {
        const acts = [];
        let timerFn = null;
        const v = {
            paused: false, ended: false,
            seeking: opts.seeking ?? false,
            readyState: opts.readyState ?? 1,
            _ct: 100,
            _frames: 1000,
            buffered: { length: 1, start: () => 20, end: () => opts.bufferedEnd ?? 140 },
            getVideoPlaybackQuality: opts.noFrameCounter
                ? undefined
                : function () { return { totalVideoFrames: this._frames }; },
            play: () => { acts.push('play'); return Promise.resolve(); }
        };
        Object.defineProperty(v, 'currentTime', {
            get() { return this._ct; },
            // A stalled element reports the seek target straight away even
            // though no frame ever comes of it -- which is exactly what
            // defeated watching the clock.
            set(x) { acts.push('seek:' + x.toFixed(1)); this._ct = x; }
        });

        const p = new (new Function('console', 'setInterval', 'clearInterval',
            'STALL_SECONDS', `
            return class W {
                constructor(video) { this.video = video; }
                ${WATCH}
            };`)(
            { log() { } },
            (fn) => { timerFn = fn; return 1; },
            () => { },
            6
        ))(v);

        p.currentChannel = { name: 'TF1' };
        p.hls = opts.noHls ? null : {
            recoverMediaError: () => acts.push('recoverMediaError'),
            stopLoad: () => acts.push('stopLoad'),
            loadSource: () => acts.push('loadSource'),
            startLoad: (n) => acts.push('startLoad:' + n),
            url: 'http://provider/live/1.m3u8'
        };
        p.watchdogRecover = () => acts.push('watchdogRecover');
        p.currentUrl = 'http://provider/live/1.m3u8';
        p.startStallWatchdog();
        return { p, v, acts, tick: (n = 1) => { for (let i = 0; i < n; i++) timerFn(); } };
    }

    it('fires even while the element claims to be seeking', () => {
        // A seek that has not finished in six seconds is a stall, not a seek
        const h = harness({ seeking: true });
        h.tick(7);
        assert.notEqual(h.acts.length, 0, 'must act during a stuck seek');
    });

    it('is not fooled by a clock that moves while nothing decodes', () => {
        // The failure as measured: position jumping, picture frozen
        const h = harness({ bufferedEnd: 140 });
        for (let i = 0; i < 7; i++) { h.v._ct += 5; h.tick(1); }
        assert.notEqual(h.acts.length, 0, 'a moving clock is not a moving picture');
    });

    it('stands down when frames are actually being decoded', () => {
        const h = harness();
        for (let i = 0; i < 30; i++) { h.v._frames += 25; h.tick(1); }
        assert.deepEqual(h.acts, []);
    });

    it('rejoins the live edge rather than nudging a fraction of a second', () => {
        // hls.js already nudged by a fraction, and that is what wedged the seek
        const h = harness({ bufferedEnd: 140 });
        h.tick(7);
        assert.deepEqual(h.acts, ['seek:138.5', 'play']);
    });

    it('resets the decoder when moving the position was not enough', () => {
        const h = harness({ bufferedEnd: 140 });
        h.tick(7);
        h.acts.length = 0;
        h.tick(6);
        assert.deepEqual(h.acts, ['recoverMediaError', 'play']);
    });

    it('reloads the stream as a last resort', () => {
        const h = harness({ bufferedEnd: 140 });
        h.tick(19);
        assert.equal(h.acts.includes('watchdogRecover'), true);
    });

    it('escalates one step at a time, not all at once', () => {
        const h = harness({ bufferedEnd: 140 });
        h.tick(7);
        assert.equal(h.acts.filter(a => a.startsWith('seek')).length, 1);
        h.tick(5);
        assert.equal(h.acts.includes('recoverMediaError'), false);
    });

    it('goes straight to the decoder when there is no buffer to skip to', () => {
        const h = harness({ bufferedEnd: 100 });
        h.tick(7);
        assert.deepEqual(h.acts, ['recoverMediaError', 'play']);
    });

    it('falls back to the clock where no frame counter exists', () => {
        const h = harness({ noFrameCounter: true, bufferedEnd: 140 });
        h.tick(7);
        assert.deepEqual(h.acts, ['seek:138.5', 'play']);
    });

    it('leaves a deliberately paused channel alone', () => {
        const h = harness();
        h.v.paused = true;
        h.tick(30);
        assert.deepEqual(h.acts, []);
    });
});

/**
 * Sound but no picture.
 *
 * hls.js demuxes MPEG-TS itself and only understands H.264 and HEVC video.
 * Faced with anything else it does not fail: it builds an audio track and
 * no video track, and the channel plays perfectly behind a black screen.
 * Measured on LIGUE 1+ 4: one source buffer, mp4a.40.2, 0x0 pixels, zero
 * frames decoded, readyState 4 -- the element had everything it wanted.
 */
describe('a stream with no video track', () => {
    const CHECK = lift('checkVideoTrack');

    function harness() {
        const acts = [];
        const p = new (new Function('console', `
            return class C {
                ${CHECK}
            };`)({ log() { }, error() { } }))();
        p.currentChannel = { name: 'LIGUE 1+ 4' };
        p.currentUrl = 'http://provider/live/35448.m3u8';
        p.updateTranscodeStatus = (m, t) => acts.push('status:' + (t || m));
        p.showError = (m) => acts.push('error');
        p.playHls = (u) => acts.push('playHls:' + u);
        p.startTranscodeSession = (url, o) => {
            acts.push('transcode:' + o.videoMode);
            return Promise.resolve('/hls/session/42.m3u8');
        };
        return { p, acts };
    }

    it('sends a picture-less stream to the server to be transcoded', async () => {
        const h = harness();
        h.p.checkVideoTrack({ audio: { codec: 'mp4a.40.2' } });
        await new Promise(r => setImmediate(r));
        assert.deepEqual(h.acts, ['status:Transcoding (Video)', 'transcode:encode',
            'playHls:/hls/session/42.m3u8']);
    });

    it('plays a non-HLS fallback as a plain source', () => {
        // startTranscodeSession falls back to /api/transcode?url= when the
        // session cannot be made, and that streams fragmented MP4. hls.js
        // parses it as a playlist, rejects it and retries -- four rounds
        // of "client disconnected, killing FFmpeg" in the log.
        const h = harness();
        h.p.video = { play: () => { h.acts.push('video.play'); return Promise.resolve(); } };
        h.p.startTranscodeSession = () => Promise.resolve('/api/transcode?url=http%3A%2F%2Fx');
        h.p.checkVideoTrack({ audio: {} });
        return new Promise(r => setImmediate(r)).then(() => {
            assert.equal(h.acts.some(a => a.startsWith('playHls')), false);
            assert.equal(h.p.video.src, '/api/transcode?url=http%3A%2F%2Fx');
            assert.equal(h.acts.includes('video.play'), true);
        });
    });

    it('leaves a normal stream alone', () => {
        const h = harness();
        h.p.checkVideoTrack({ audio: {}, video: { codec: 'avc1.64001f' } });
        assert.deepEqual(h.acts, []);
        assert.equal(h.p.hasVideoTrack, true);
    });

    it('does not transcode the same stream twice', async () => {
        const h = harness();
        h.p.checkVideoTrack({ audio: {} });
        await new Promise(r => setImmediate(r));
        h.acts.length = 0;
        h.p.checkVideoTrack({ audio: {} });
        assert.deepEqual(h.acts, [], 'a second report must not start another session');
    });

    it('drops the result if the viewer has changed channel meanwhile', async () => {
        const h = harness();
        h.p.checkVideoTrack({ audio: {} });
        h.p.currentUrl = 'http://provider/live/99999.m3u8';   // zapped
        await new Promise(r => setImmediate(r));
        assert.equal(h.acts.some(a => a.startsWith('playHls')), false);
    });

    it('tells the watchdog there is no picture to watch', () => {
        // Otherwise it decides a radio station has been stalled for ever
        const h = harness();
        h.p.checkVideoTrack({ audio: {} });
        assert.equal(h.p.hasVideoTrack, false);
    });
});

/**
 * Every hls.js instance gets the common handlers.
 *
 * This file builds four of them. The picture-less-stream check was added
 * to exactly one -- the one live TV does not use -- so the fix shipped,
 * the channel still played sound behind a black screen, and nothing in the
 * logs said why. A test that reads the file is the only kind that catches
 * a fifth construction site being added later.
 */
describe('hls instances', () => {
    const PLAYER = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'js', 'components', 'VideoPlayer.js'), 'utf8');

    it('routes every construction through attachCommonHandlers', () => {
        const built = PLAYER.match(/new Hls\(/g) || [];
        const wrapped = PLAYER.match(/attachCommonHandlers\(new Hls\(/g) || [];
        assert.equal(wrapped.length, built.length,
            `${built.length} instances built, ${wrapped.length} wrapped`);
        assert.ok(built.length >= 4, 'expected the known construction sites');
    });

    it('hooks the codec report there, so it holds for all of them', () => {
        const fn = PLAYER.slice(PLAYER.indexOf('attachCommonHandlers(hls) {'));
        assert.match(fn.slice(0, 400), /BUFFER_CODECS/);
    });
});

/**
 * A channel that never starts.
 *
 * Found in the field: the provider's domain lost its A record, so nothing
 * resolved. hls.js retries a playlist it cannot load on its own schedule
 * and reports nothing until those are exhausted -- one attempt took 66
 * seconds on the Fire TV -- so the spinner turned for minutes and the app
 * looked broken while it was the provider that had gone.
 */
describe('a channel that never starts', () => {
    const ARM = lift('armStartTimeout');

    function harness(proxyAnswer) {
        const acts = [];
        let fire = null;
        const p = new (new Function('console', 'setTimeout', 'clearTimeout',
            'START_TIMEOUT_MS', 'fetch', `
            return class S {
                ${ARM}
            };`)(
            { log() { } },
            (fn) => { fire = fn; return 7; },
            () => { acts.push('cleared'); },
            14000,
            async () => proxyAnswer
        ))();
        p.currentChannel = { name: 'CANAL+ HD' };
        p.currentUrl = 'http://gone.example/live/1.m3u8';
        p.video = { paused: true, readyState: 0 };
        p.loadingSpinner = { classList: { remove: () => acts.push('spinner off') } };
        p.showError = (m) => acts.push('message:' + m);
        p.armStartTimeout();
        return { p, acts, fire: () => fire() };
    }

    const unreachable = {
        status: 502,
        json: async () => ({ unreachable: true, cause: 'ENOTFOUND', host: 'gone.example' })
    };
    const other = { status: 500, json: async () => ({ error: 'fetch failed' }) };

    it('names the host when the server cannot reach it either', async () => {
        const h = harness(unreachable);
        await h.fire();
        assert.equal(h.acts.includes('spinner off'), true);
        assert.match(h.acts.find(a => a.startsWith('message:')),
            /Cannot reach gone\.example/);
    });

    it('still says something when the reason is not known', async () => {
        const h = harness(other);
        await h.fire();
        assert.match(h.acts.find(a => a.startsWith('message:')), /did not start/);
    });

    it('says nothing if the picture arrived while it waited', async () => {
        const h = harness(unreachable);
        h.p.video = { paused: false, readyState: 4 };
        await h.fire();
        assert.deepEqual(h.acts.filter(a => a.startsWith('message:')), []);
    });

    it('says nothing if the viewer has changed channel', async () => {
        const h = harness(unreachable);
        h.p.currentChannel = { name: 'M6' };
        await h.fire();
        assert.deepEqual(h.acts.filter(a => a.startsWith('message:')), []);
    });

    it('survives the server being unreachable too', async () => {
        const h = harness(null);   // fetch resolves to null -> reading .status throws
        await h.fire();
        assert.match(h.acts.find(a => a.startsWith('message:')) || '', /did not start/);
    });
});
