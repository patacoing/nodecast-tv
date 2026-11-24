/**
 * What the relay agrees to fetch.
 *
 * The log for a channel that would not start said only this, twice:
 *
 *   error  Stream proxy error (attempt 1/2): Invalid URL
 *   error  Stream proxy error (attempt 2/2): Invalid URL
 *
 * which describes the probe sent to explain the outage, not the outage.
 * The start-timeout diagnostic asks the server to fetch what the device
 * could not, and it had no address to ask about: encodeURIComponent makes
 * the string "undefined" out of a missing value, that string is truthy,
 * and new URL() threw on it one attempt at a time.
 */
const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { parseTarget } = require('../server/routes/proxy');

describe('deciding what the relay will fetch', () => {
    it('takes an absolute http url', () => {
        const t = parseTarget('http://chatfand.live:9798/live/u/p/471.m3u8');
        assert.equal(t.ok, true);
        assert.equal(t.url.origin, 'http://chatfand.live:9798');
    });

    it('takes https too', () => {
        assert.equal(parseTarget('https://epgshare01.online/x.xml.gz').ok, true);
    });

    it('refuses the word a missing value encodes to', () => {
        for (const raw of ['undefined', 'null']) {
            const t = parseTarget(raw);
            assert.equal(t.ok, false);
            assert.equal(t.why, 'URL required');
            assert.equal(t.shown, raw, 'says what actually arrived');
        }
    });

    it('refuses nothing at all', () => {
        for (const raw of [undefined, null, '']) {
            assert.equal(parseTarget(raw).ok, false);
        }
    });

    it('refuses a relative path, which it could not resolve anyway', () => {
        // The manifest it came from was rewritten, so this server's own
        // address is all there would be to resolve it against.
        const t = parseTarget('seg0001.ts');
        assert.equal(t.ok, false);
        assert.equal(t.why, 'URL is not absolute');
    });

    it('refuses a scheme that is not ours to fetch', () => {
        for (const raw of ['file:///etc/passwd', 'ftp://host/x']) {
            const t = parseTarget(raw);
            assert.equal(t.ok, false);
            assert.match(t.why, /is not proxied/);
        }
    });

    it('hands back the string as it arrived, not a tidied copy', () => {
        // What gets fetched is the provider's URL verbatim. new URL().href
        // normalises -- a trailing slash, percent-encoding -- and a
        // provider is entitled to its own spelling.
        const raw = 'http://chatfand.live:9798/live/u/p/471.m3u8?a=1&b=%20';
        assert.equal(parseTarget(raw).raw, raw);
    });

    it('keeps the offending value short enough to log', () => {
        const t = parseTarget('x'.repeat(5000));
        assert.equal(t.ok, false);
        assert.ok(t.shown.length <= 120);
    });

    it('is decided before the retry loop, not inside it', () => {
        const SRC = fs.readFileSync(
            path.join(__dirname, '../server/routes/proxy.js'), 'utf8');
        const at = SRC.indexOf("router.get('/stream'");
        const loop = SRC.indexOf('for (let attempt', at);
        const check = SRC.indexOf('parseTarget(req.query.url)', at);
        assert.notEqual(check, -1);
        assert.ok(check < loop,
            'a url that does not parse will not start parsing on attempt two');
    });
});

/**
 * The caller that sent the probe in the first place.
 */
describe('the start-timeout diagnostic', () => {
    const SRC = fs.readFileSync(
        path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8');

    function lift(name) {
        const start = SRC.indexOf(`\n    ${name}(`);
        assert.notEqual(start, -1, `${name} not found`);
        const end = SRC.indexOf('\n    }', start);
        return SRC.slice(start, end + 6);
    }

    let fired, calls;

    // The method reads a module-level constant, so it comes along.
    const CONSTANTS = ['START_TIMEOUT_MS'].map(n => {
        const m = SRC.match(new RegExp(`^const ${n} = (.+);$`, 'm'));
        assert.ok(m, `${n} not found`);
        return `const ${n} = ${m[1]};`;
    }).join('\n');

    function make(currentUrl) {
        const Stub = new Function('setTimeout', 'clearTimeout', 'fetch', 'record', `
            ${CONSTANTS}
            return class Stub {
                ${lift('armStartTimeout')}
                showError(m) { record('showError', m); }
                retryFromSource() { record('retryFromSource'); }
                stop() { }
            };
        `)(
            (fn) => { fired = fn; return { unref() { } }; },
            () => { },
            (u) => { calls.push(u); return Promise.resolve({ ok: false, status: 0 }); },
            (...a) => calls.push(a)
        );
        const s = new Stub();
        s.currentUrl = currentUrl;
        s.currentChannel = { name: 'TF1' };
        s.video = { paused: true, readyState: 0 };
        return s;
    }

    beforeEach(() => { fired = null; calls = []; });

    it('does not ask the relay about an address it never had', async () => {
        const s = make(null);
        s.armStartTimeout();
        await fired();
        assert.deepEqual(calls.filter(c => typeof c === 'string'), [],
            'nothing was fetched');
        assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'showError'),
            'the viewer is still told the channel did not start');
    });

    it('still probes when it has one', async () => {
        const s = make('http://provider/live/471.m3u8');
        s.armStartTimeout();
        await fired();
        const fetched = calls.filter(c => typeof c === 'string');
        assert.equal(fetched.length, 1);
        assert.match(fetched[0], /url=http%3A%2F%2Fprovider/);
    });
});
