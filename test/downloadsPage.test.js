/**
 * Tests for the Downloads page.
 *
 * The server side of this feature was tested against a real film; the page
 * itself had never been run at all. These exercise it: what each state
 * shows, and the one detail the whole design turns on -- that a ready film
 * is offered as a plain link, so the phone's own download manager takes it
 * rather than a fetch that would carry the app's Authorization header.
 */
const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'pages', 'DownloadsPage.js'), 'utf8');

function mount(payload) {
    const dom = new JSDOM(`<body>
        <p id="downloads-hint"></p>
        <div id="downloads-list"></div>
      </body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.API = { downloads: { list: async () => payload, remove: async () => ({}), request: async () => ({}) } };
    window.eval(SRC);
    return window;
}

const ready = {
    item_id: '10:1', name: 'Vol de nuit', status: 'ready',
    size: 4610080218, progress: 1, link: '/api/downloads/10%3A1/file?e=1&s=abc'
};
const running = { item_id: '10:2', name: 'Speed Demon', status: 'running', progress: 0.42 };
const failed = { item_id: '10:3', name: 'Anora', status: 'failed', error: 'ffmpeg exited 1' };

describe('Downloads page', () => {
    it('says what is kept and what is free', async () => {
        const w = mount({ items: [ready], max: 2, freeBytes: 10 * 1024 ** 3 });
        const page = new w.DownloadsPage({});
        await page.show(); page.hide();
        assert.match(w.document.getElementById('downloads-hint').textContent,
            /1 of 2 kept · 10\.0 GB free/);
    });

    it('offers a ready film as a plain link the phone can take', async () => {
        // Not a button calling fetch: that would carry the Authorization
        // header the download manager cannot send, which is the whole
        // reason the URL is signed
        const w = mount({ items: [ready], max: 2, freeBytes: 1e10 });
        const page = new w.DownloadsPage({});
        await page.show(); page.hide();

        const a = w.document.querySelector('.download-row a');
        assert.equal(a.getAttribute('href'), ready.link);
        assert.equal(a.hasAttribute('download'), true);
        assert.match(w.document.querySelector('.download-state').textContent, /4\.3 GB/);
    });

    it('shows progress while a film is being prepared', async () => {
        const w = mount({ items: [running], max: 2, freeBytes: 1e10 });
        const page = new w.DownloadsPage({});
        await page.show(); page.hide();

        assert.match(w.document.querySelector('.download-state').textContent, /Preparing… 42%/);
        assert.equal(w.document.querySelector('.download-bar span').style.width, '42%');
        assert.equal(w.document.querySelector('.download-row').className,
            'download-row status-running');
    });

    it('shows why a film failed, and offers another go', async () => {
        const w = mount({ items: [failed], max: 2, freeBytes: 1e10 });
        const page = new w.DownloadsPage({});
        await page.show(); page.hide();

        assert.match(w.document.querySelector('.download-state').textContent, /ffmpeg exited 1/);
        const labels = [...w.document.querySelectorAll('.download-actions button')]
            .map(b => b.textContent);
        assert.deepEqual(labels, ['Try again', 'Remove']);
    });

    it('calls a running job Cancel rather than Remove', async () => {
        const w = mount({ items: [running], max: 2, freeBytes: 1e10 });
        const page = new w.DownloadsPage({});
        await page.show(); page.hide();
        assert.equal(w.document.querySelector('.download-actions button').textContent, 'Cancel');
    });

    it('says something useful when there is nothing', async () => {
        const w = mount({ items: [], max: 2, freeBytes: 1e10 });
        const page = new w.DownloadsPage({});
        await page.show(); page.hide();
        assert.match(w.document.getElementById('downloads-list').textContent,
            /Nothing downloaded/);
    });

    it('only polls while something is being prepared', async () => {
        // A page that keeps asking forever is a page nobody notices is
        // wrong until the logs are full
        const quiet = mount({ items: [ready], max: 2, freeBytes: 1e10 });
        const idle = new quiet.DownloadsPage({});
        await idle.show();
        assert.equal(idle.timer, null);

        const busyWin = mount({ items: [running], max: 2, freeBytes: 1e10 });
        const busy = new busyWin.DownloadsPage({});
        await busy.show();
        assert.notEqual(busy.timer, null);
        busy.hide();
        assert.equal(busy.timer, null);
    });

    it('survives the server refusing to answer', async () => {
        const w = mount({ items: [], max: 2, freeBytes: 0 });
        w.API.downloads.list = async () => { throw new Error('down'); };
        const page = new w.DownloadsPage({});
        await page.show(); page.hide();
        assert.match(w.document.getElementById('downloads-list').textContent,
            /Could not read the list/);
    });
});
