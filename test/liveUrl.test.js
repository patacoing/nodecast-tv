const test = require('node:test');
const assert = require('node:assert');
const { isLiveUrl } = require('../server/services/liveUrl');
const transcodeSession = require('../server/services/transcodeSession');

test('a live Xtream path is live whatever the caller says', () => {
    assert.equal(isLiveUrl('http://host:9798/live/user/pass/471.m3u8'), true);
    assert.equal(isLiveUrl('http://host:9798/LIVE/user/pass/471.ts'), true);
});

test('films and episodes are not live', () => {
    assert.equal(isLiveUrl('http://host:9798/movie/user/pass/61610.mkv'), false);
    assert.equal(isLiveUrl('http://host:9798/series/user/pass/8821.mkv'), false);
});

test('a bare playlist is not enough to call it live', () => {
    // A VOD playlist is an .m3u8 too, so the extension cannot decide.
    assert.equal(isLiveUrl('http://host/hls/abcdef.m3u8'), false);
});

test('a missing url does not throw', () => {
    for (const u of ['', null, undefined, 0, {}]) {
        assert.equal(isLiveUrl(u), false);
    }
});

// --- reuse must not hand back a session configured differently ---------

function fakeSession(url, options) {
    return { url, status: 'running', options, touched: 0, touch() { this.touched++; } };
}

test('a session started without isLive is not reused for a live request', () => {
    // This is the incident: the app was reopened to pick up the fix and
    // was handed back the very session that lacked it.
    const sessions = new Map();
    sessions.set('a', fakeSession('u', { isLive: false, maxResolution: '1080p' }));
    const found = [...sessions.values()].find(s =>
        s.url === 'u' && s.status === 'running' &&
        transcodeSession.sameOptions(s, { isLive: true, maxResolution: '1080p' }));
    assert.equal(found, undefined);
});

test('a session with the same options is reused', () => {
    const s = fakeSession('u', { isLive: true, maxResolution: '1080p' });
    assert.equal(transcodeSession.sameOptions(s, { isLive: true, maxResolution: '1080p' }), true);
});

test('a lower resolution ceiling is not silently ignored', () => {
    // The picture-less-channel fallback asks for 720p; handing back a
    // 1080p session is what made it look like it did nothing.
    const s = fakeSession('u', { isLive: true, maxResolution: '1080p' });
    assert.equal(transcodeSession.sameOptions(s, { isLive: true, maxResolution: '720p' }), false);
});

test('an omitted option still joins a session started without it', () => {
    const s = fakeSession('u', { isLive: true, maxResolution: '1080p', videoCodec: undefined });
    assert.equal(transcodeSession.sameOptions(s, { isLive: true, maxResolution: '1080p' }), true);
});

test('a different codec request gets its own session', () => {
    const s = fakeSession('u', { isLive: true, maxResolution: '1080p', videoMode: 'copy' });
    assert.equal(transcodeSession.sameOptions(s, { isLive: true, maxResolution: '1080p', videoMode: 'encode' }), false);
});

test('the route trusts the url over a caller that omits the flag', () => {
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '../server/routes/transcode.js'), 'utf8');
    assert.match(src, /isLive:\s*!!isLive\s*\|\|\s*isLiveUrl\(url\)/,
        'the session route must infer isLive from the url as well');
});
