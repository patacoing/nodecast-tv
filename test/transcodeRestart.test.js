/**
 * Tests for reconnecting a live transcode.
 *
 * A direct went silent at 20:59 and never came back. The provider answered
 * 404 on one playlist reload, ffmpeg gave up -- reporting success, because
 * as far as it is concerned the input ended -- and nothing restarted it.
 * For a live channel an exit nobody asked for is a disconnection.
 */
const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'services',
    'transcodeSession.js'), 'utf8');

function lift(name) {
    const start = SRC.indexOf(`\n    ${name}() {`);
    assert.notEqual(start, -1, `${name} not found`);
    const end = SRC.indexOf('\n    }', start);
    return SRC.slice(start, end + 6);
}

/** A stand-in carrying only the fields scheduleLiveRestart touches. */
function harness(over = {}) {
    const acts = [];
    let fire = null;
    const Stub = new Function('log', 'setTimeout', 'clearTimeout',
        'LIVE_RESTART_ATTEMPTS', 'LIVE_RESTART_DELAY_MS', 'LIVE_RESTART_SETTLE_MS', `
        return class S {
            ${lift('scheduleLiveRestart')}
        };`)(
        { info() { }, warn() { }, error: (...a) => acts.push('error') },
        (fn, ms) => { fire = fn; acts.push('scheduled:' + ms); return { unref() { } }; },
        () => { },
        3, 1000, 30000
    );
    const s = new Stub();
    s.id = 'abc';
    s.retired = false;
    s.stopping = false;
    s.restartCount = 0;
    s.processStartedAt = Date.now();     // just started, so no settle reset
    s.restartTimer = null;
    s.start = () => { acts.push('start'); return Promise.resolve(); };
    Object.assign(s, over);
    return { s, acts, fire: () => fire && fire() };
}

describe('reconnecting a live transcode', () => {
    it('schedules a restart a second after the input drops', () => {
        const h = harness();
        h.s.scheduleLiveRestart();
        assert.deepEqual(h.acts, ['scheduled:1000']);
        assert.equal(h.s.status, 'reconnecting');
        h.fire();
        assert.equal(h.acts.includes('start'), true);
    });

    it('tries three times and then stops', () => {
        const h = harness();
        for (let i = 0; i < 3; i++) { h.s.scheduleLiveRestart(); h.fire(); }
        assert.equal(h.acts.filter(a => a === 'start').length, 3);

        h.acts.length = 0;
        h.s.scheduleLiveRestart();
        assert.equal(h.acts.includes('start'), false);
        assert.equal(h.s.status, 'error');
        assert.match(h.s.error, /repeatedly disconnected/);
    });

    it('starts the count over once a run has held', () => {
        // A provider that hiccups every few hours must be reconnected
        // every time, not three times in its life
        const h = harness();
        for (let i = 0; i < 3; i++) { h.s.scheduleLiveRestart(); h.fire(); }
        h.s.processStartedAt = Date.now() - 31000;   // this one lasted
        h.acts.length = 0;
        h.s.scheduleLiveRestart();
        assert.deepEqual(h.acts, ['scheduled:1000']);
        assert.equal(h.s.restartCount, 1);
    });

    it('does not reconnect a session the viewer stopped', () => {
        const h = harness({ stopping: true });
        h.s.scheduleLiveRestart();
        assert.deepEqual(h.acts, []);
    });

    it('does not reconnect a session that was cleaned up', () => {
        const h = harness({ retired: true });
        h.s.scheduleLiveRestart();
        assert.deepEqual(h.acts, []);
    });

    it('drops a restart that comes due after a stop', () => {
        // The timer is cleared by stop(), but a callback already in the
        // queue has to check for itself
        const h = harness();
        h.s.scheduleLiveRestart();
        h.s.stopping = true;
        h.fire();
        assert.equal(h.acts.includes('start'), false);
    });
});

describe('what the session is told to do', () => {
    it('asks ffmpeg to retry an HTTP error instead of exiting', () => {
        assert.match(SRC, /'-reconnect_on_http_error', '4xx,5xx'/);
        assert.match(SRC, /'-reconnect_delay_max', '10'/);
    });

    it('gives a live channel a sliding playlist with no end marker', () => {
        assert.match(SRC, /'-hls_list_size', live \? '6' : '0'/);
        assert.match(SRC, /delete_segments\+omit_endlist/);
    });

    it('leaves a film keeping every segment, for seeking back', () => {
        assert.match(SRC, /: 'independent_segments\+append_list'/);
    });

    it('clears the restart timer when stopping and when cleaning up', () => {
        for (const name of ['    stop() {', '    async cleanup() {']) {
            const at = SRC.indexOf(name);
            assert.notEqual(at, -1, name);
            assert.match(SRC.slice(at, at + 300), /clearTimeout\(this\.restartTimer\)/, name);
        }
    });

    it('counts the gauge against the process, not the session', () => {
        // A live session spawns ffmpeg again on every reconnection; a
        // gauge counted at the session would climb for ever
        const at = SRC.indexOf("this.process.on('exit'");
        assert.match(SRC.slice(at, at + 400), /transcodeSessions\.add\(-1\)/);
        const stop = SRC.indexOf('    stop() {');
        assert.equal(/transcodeSessions\.add\(-1\)/.test(SRC.slice(stop, stop + 300)), false,
            'stop() must not decrement as well');
    });
});

describe('knowing a channel is live', () => {
    it('is declared by the player that only serves live channels', () => {
        const vp = fs.readFileSync(path.join(__dirname, '..', 'public', 'js',
            'components', 'VideoPlayer.js'), 'utf8');
        assert.match(vp, /isLive: true/);
    });

    it('is not declared by the page that serves films and episodes', () => {
        const wp = fs.readFileSync(path.join(__dirname, '..', 'public', 'js',
            'pages', 'WatchPage.js'), 'utf8');
        assert.equal(/isLive/.test(wp), false);
    });

    it('is carried through the route to the session', () => {
        const route = fs.readFileSync(path.join(__dirname, '..', 'server',
            'routes', 'transcode.js'), 'utf8');
        assert.match(route, /maxResolution, isLive \} = req\.body/);
        assert.match(route, /isLive: !!isLive/);
    });
});
