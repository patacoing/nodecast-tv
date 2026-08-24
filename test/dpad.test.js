/**
 * Spatial navigation tests for public/js/dpad.js, run with node's built-in
 * test runner (`node --test`, aka `npm test`).
 *
 * jsdom has no layout engine, so every element gets an explicit rect via a
 * `data-rect="left,top,width,height"` attribute; getBoundingClientRect() is
 * stubbed below to read it back. Real KeyboardEvents are dispatched and we
 * assert on document.activeElement.
 *
 * Two non-obvious bits, preserved on purpose:
 *  - After `window.eval(SRC)`, jsdom is still in readyState 'loading', same
 *    as a real browser mid-parse of a <script> at the end of <body>. dpad.js
 *    waits for DOMContentLoaded to wire itself up, so build() dispatches that
 *    event by hand once the script has been evaluated.
 *  - build()'s HTML wrapping: most tests just hand it a fragment, which gets
 *    wrapped in a single `<div class="page active">` so dpad.js has an
 *    active page to operate on. Tests that need a *specific* page id
 *    (page-live, page-watch) supply their own `class="page ` wrapper already;
 *    wrapping it a second time would nest two `.page` elements and make
 *    `querySelector('.page.active')` resolve to the wrong (outer) one. That's
 *    why the wrapping check below is a literal `class="page ` string match.
 */
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
// jsdom ignores a top-level `userAgent` option: navigator.userAgent comes
// from the resource loader, which is the only way to fake the Android
// wrapper's marker.
const { JSDOM, ResourceLoader } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dpad.js'), 'utf8');

function build(html, opts = {}) {
    // Tests that need a specific page (page-live, page-watch) supply their own
    // .page wrapper; wrapping again would nest pages and make
    // querySelector('.page.active') return the wrong one.
    const body = /class="page /.test(html)
        ? html
        : `<div id="page-movies" class="page active">${html}</div>`;
    const dom = new JSDOM(`<body>${body}</body>`, {
        runScripts: 'outside-only', pretendToBeVisual: true,
        ...(opts.userAgent
            ? { resources: new ResourceLoader({ userAgent: opts.userAgent }) }
            : {})
    });
    const { window } = dom;
    global.window = window;
    global.document = window.document;

    window.Element.prototype.scrollIntoView = function () { };

    // rect comes from data-rect="left,top,width,height"
    window.Element.prototype.getBoundingClientRect = function () {
        const spec = this.dataset?.rect;
        if (!spec) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        const [left, top, w, h] = spec.split(',').map(Number);
        return { left, top, right: left + w, bottom: top + h, width: w, height: h };
    };

    window.eval(SRC);
    // jsdom is still in readyState 'loading' here, exactly like a browser
    // parsing the <script> at the end of <body>: release DOMContentLoaded.
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
    return window;
}

function press(window, key) {
    const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    (window.document.activeElement || window.document.body).dispatchEvent(ev);
    return ev;
}

const id = w => w.document.activeElement?.id || w.document.activeElement?.tagName;

// `actual` and `expected` are evaluated eagerly, right where check() is
// called (normal JS argument evaluation) -- i.e. at the same point in the
// script where the preceding focus()/press() calls already ran. Only the
// assertion itself is deferred into node:test's it(). This matters: an
// it() callback that reads live state (e.g. `id(w)`) lazily would observe
// whatever the DOM looks like once the runner gets around to executing it,
// which is *after* every describe() body in the file has already run and
// moved focus on past the point being asserted.
function check(name, actual, expected) {
    it(name, () => assert.strictEqual(actual, expected));
}

// ---------------------------------------------------------------
// A horizontal row of 5 cards, 200px wide, 300px tall
// ---------------------------------------------------------------
describe('horizontal row', () => {
    const cards = [0, 1, 2, 3, 4]
        .map(i => `<div class="movie-card" id="c${i}" data-rect="${i * 210},100,200,300"></div>`).join('');
    const w = build(cards);

    check('cards were hydrated with tabindex', w.document.getElementById('c0').getAttribute('tabindex'), '0');
    check('cards got role=button', w.document.getElementById('c0').getAttribute('role'), 'button');

    w.document.getElementById('c2').focus();
    press(w, 'ArrowRight');
    check('right moves to next card', id(w), 'c3');

    press(w, 'ArrowLeft');
    check('left moves back', id(w), 'c2');

    w.document.getElementById('c4').focus();
    const ev = press(w, 'ArrowRight');
    check('right at end of row does not move', id(w), 'c4');
    check('unhandled key is not swallowed', ev.defaultPrevented, false);
});

// ---------------------------------------------------------------
// A 3x2 grid: down must land straight below, not diagonally
// ---------------------------------------------------------------
describe('grid', () => {
    let html = '';
    for (let row = 0; row < 2; row++)
        for (let col = 0; col < 3; col++)
            html += `<div class="movie-card" id="r${row}c${col}" data-rect="${col * 210},${row * 320},200,300"></div>`;
    const w = build(html);

    w.document.getElementById('r0c1').focus();
    press(w, 'ArrowDown');
    check('down goes straight below', id(w), 'r1c1');

    press(w, 'ArrowUp');
    check('up goes straight above', id(w), 'r0c1');

    w.document.getElementById('r0c0').focus();
    press(w, 'ArrowDown');
    check('down from left column stays in column', id(w), 'r1c0');

    // A grid is not a carousel: entering a row must not snap to column 0
    w.document.getElementById('r0c2').focus();
    press(w, 'ArrowDown');
    check('down in a grid keeps the column, not the first item', id(w), 'r1c2');
});

// ---------------------------------------------------------------
// Nav bar above a grid: up from the grid reaches the nav
// ---------------------------------------------------------------
describe('nav bar + grid', () => {
    const w = build(`
        <a href="#" id="nav-movies" class="nav-link" data-rect="100,0,120,50"></a>
        <a href="#" id="nav-series" class="nav-link" data-rect="240,0,120,50"></a>
        <div class="movie-card" id="card" data-rect="100,100,200,300"></div>
    `);

    w.document.getElementById('card').focus();
    press(w, 'ArrowUp');
    check('up from card reaches nearest nav link', id(w), 'nav-movies');

    press(w, 'ArrowRight');
    check('right moves along the nav bar', id(w), 'nav-series');
});

// ---------------------------------------------------------------
// Activation and entry point
// ---------------------------------------------------------------
describe('activation', () => {
    const w = build(`<div class="movie-card" id="c0" data-rect="0,100,200,300"></div>
                     <button id="b0" data-rect="0,500,100,40"></button>`);

    let clicks = 0;
    w.document.getElementById('c0').addEventListener('click', () => clicks++);

    w.document.getElementById('c0').focus();
    press(w, 'Enter');
    check('Enter clicks a card', clicks, 1);

    press(w, ' ');
    check('Space clicks a card', clicks, 2);

    // native button must not be double-fired by us
    let btnClicks = 0;
    w.document.getElementById('b0').addEventListener('click', () => btnClicks++);
    w.document.getElementById('b0').focus();
    press(w, 'Enter');
    check('Enter on a native button is left to the browser', btnClicks, 0);

    // entry point
    w.document.activeElement.blur();
    check('nothing focused', id(w), 'BODY');
    press(w, 'ArrowDown');
    check('arrow with nothing focused enters the page', id(w), 'c0');
});

// ---------------------------------------------------------------
// Text inputs keep their horizontal arrows
// ---------------------------------------------------------------
describe('text input', () => {
    // A control on each side of the field, and a card below it
    const w = build(`
        <button id="c0" data-rect="0,0,80,40"></button>
        <input type="text" id="search" class="search-input" data-rect="100,0,300,40">
        <button id="c1" data-rect="420,0,80,40"></button>
        <div class="movie-card" id="c2" data-rect="0,100,200,300"></div>`);

    const field = w.document.getElementById('search');

    // With text in it and the caret in the middle, arrows move the caret
    field.value = 'hello';
    field.setSelectionRange(2, 2);
    field.focus();
    const ev = press(w, 'ArrowRight');
    check('right mid-text is left to the caret', id(w), 'search');
    check('right mid-text is not swallowed', ev.defaultPrevented, false);

    // At the end of the text the arrow leaves the field, otherwise a search
    // box would trap the selection
    field.setSelectionRange(5, 5);
    press(w, 'ArrowRight');
    check('right at the end of the text leaves the field', id(w), 'c1');

    field.focus();
    field.setSelectionRange(0, 0);
    press(w, 'ArrowLeft');
    check('left at the start of the text leaves the field', id(w), 'c0');

    // An empty field never traps
    field.value = '';
    field.focus();
    press(w, 'ArrowRight');
    check('right in an empty field leaves it', id(w), 'c1');

    field.focus();
    press(w, 'ArrowDown');
    check('down leaves the text field', id(w), 'c2');
});

// ---------------------------------------------------------------
// Hidden / inactive content is skipped
// ---------------------------------------------------------------
describe('visibility', () => {
    const w = build(`<div class="movie-card" id="c0" data-rect="0,100,200,300"></div>
                     <div class="hidden"><div class="movie-card" id="hid" data-rect="210,100,200,300"></div></div>
                     <div class="movie-card" id="c1" data-rect="420,100,200,300"></div>`);

    w.document.getElementById('c0').focus();
    press(w, 'ArrowRight');
    check('hidden cards are skipped', id(w), 'c1');
});

// ---------------------------------------------------------------
// An element can keep a valid rect and still refuse focus. The
// collapsed sidebar hides its header with visibility:hidden, which
// kept a full-size box: navigation "moved" onto it and the selection
// froze, because .focus() silently does nothing there.
// ---------------------------------------------------------------
describe('elements that refuse focus', () => {
    const w = build(`
        <button id="a" data-rect="0,0,80,40"></button>
        <button id="ghost" style="visibility:hidden" data-rect="100,0,80,40"></button>
        <button id="b" data-rect="200,0,80,40"></button>
    `);

    w.document.getElementById('a').focus();
    press(w, 'ArrowRight');
    check('right skips the invisible button', id(w), 'b');

    press(w, 'ArrowLeft');
    check('left skips it coming back', id(w), 'a');

    // and it is not an entry point either
    w.document.activeElement.blur();
    press(w, 'ArrowDown');
    check('entering the page ignores it', id(w), 'a');
});

// ---------------------------------------------------------------
// Live TV: the channel list is a tall column on the left and the
// player controls are pinned at the bottom right. Nothing shares a
// row, so leaving the column has to be possible.
// ---------------------------------------------------------------
describe('live tv: channel list to player controls', () => {
    let channels = '';
    for (let i = 0; i < 12; i++) {
        channels += `<div class="channel-item" id="ch${i}" ` +
            `data-rect="0,${100 + i * 44},280,40"></div>`;
    }

    const w = build(`
      <div class="page active" id="page-live">
        <div class="channel-list">${channels}</div>
        <div id="player-controls-overlay">
          <button id="btn-play" data-rect="320,940,48,48"></button>
          <button id="btn-mute" data-rect="380,940,48,48"></button>
          <button id="btn-pip" data-rect="1035,940,48,48"></button>
          <button id="btn-fullscreen" data-rect="1095,940,48,48"></button>
        </div>
      </div>`);

    // From a channel near the top, nothing at all shares its row
    w.document.getElementById('ch1').focus();
    press(w, 'ArrowRight');
    check('right leaves the channel list for the controls', id(w), 'btn-play');

    // once on the bar, movement is along it again
    press(w, 'ArrowRight');
    check('right moves along the control bar', id(w), 'btn-mute');
    press(w, 'ArrowRight');
    check('right reaches picture-in-picture', id(w), 'btn-pip');
    press(w, 'ArrowRight');
    check('right reaches fullscreen', id(w), 'btn-fullscreen');

    // and back to the list
    press(w, 'ArrowLeft');
    press(w, 'ArrowLeft');
    press(w, 'ArrowLeft');
    check('left comes back to the first control', id(w), 'btn-play');
    press(w, 'ArrowLeft');
    check('left returns to the channel list', id(w), 'ch11');

    // vertical movement inside the list is unaffected
    w.document.getElementById('ch5').focus();
    press(w, 'ArrowDown');
    check('down stays in the channel list', id(w), 'ch6');
    press(w, 'ArrowUp');
    check('up stays in the channel list', id(w), 'ch5');
});

// ---------------------------------------------------------------
// Live TV with the sidebar collapsed: the only way back is the small
// expand button at the top left. The navbar sits up there too and
// used to win, which looked like nothing happening.
// ---------------------------------------------------------------
describe('live tv: collapsed sidebar', () => {
    const w = build(`
      <div class="page active" id="page-live">
        <a href="#" id="nav-home" class="nav-link" data-rect="100,8,90,34"></a>
        <a href="#" id="nav-live" class="nav-link" data-rect="200,8,90,34"></a>
        <button id="sidebar-expand-btn" data-rect="0,60,40,40"></button>
        <div id="player-controls-overlay">
          <button id="btn-play" data-rect="320,940,48,48"></button>
          <button id="btn-fullscreen" data-rect="1095,940,48,48"></button>
        </div>
      </div>`);

    w.document.getElementById('btn-play').focus();
    press(w, 'ArrowLeft');
    check('left reaches the expand button, not the navbar', id(w), 'sidebar-expand-btn');
});

// ---------------------------------------------------------------
// Live TV with nothing playing and nothing selected: the vertical
// arrows have to get into the interface, or the page is a dead end.
// ---------------------------------------------------------------
describe('live tv: entering with nothing selected', () => {
    const w = build(`
      <div class="page active" id="page-live">
        <a href="#" id="nav-live" class="nav-link" data-rect="200,8,90,34"></a>
        <button id="sidebar-expand-btn" data-rect="0,60,40,40"></button>
        <div id="player-controls-overlay">
          <button id="btn-play" data-rect="320,940,48,48"></button>
          <button id="btn-mute" data-rect="380,940,48,48"></button>
        </div>
      </div>`);

    check('nothing is selected to begin with', id(w), 'BODY');

    // The vertical arrows zap rather than reach for the interface. LivePage
    // owns the channel change, so the key has to arrive there untouched:
    // grabbing the selection here is what left zapping dead on the remote.
    const down = press(w, 'ArrowDown');
    check('down does not take the selection', id(w), 'BODY');
    check('down reaches the zapping handler', down.defaultPrevented, false);

    const up = press(w, 'ArrowUp');
    check('up does not take the selection', id(w), 'BODY');
    check('up reaches the zapping handler', up.defaultPrevented, false);

    // horizontal arrows with nothing selected stay with playback
    const ev = press(w, 'ArrowRight');
    check('right is left to the playback shortcuts', id(w), 'BODY');
    check('right is not swallowed', ev.defaultPrevented, false);

    // OK is now the way in
    press(w, 'Enter');
    check('enter reaches the controls', id(w), 'btn-play');

    // and from there the sidebar's expand button is reachable
    press(w, 'ArrowLeft');
    check('left reaches the expand button', id(w), 'sidebar-expand-btn');
});

// ---------------------------------------------------------------
// The zapping exception is Live TV only: a movie has no next channel,
// so the arrows there still have to reach the control bar.
// ---------------------------------------------------------------
describe('watch page: entering with nothing selected', () => {
    const w = build(`
      <div class="page active" id="page-watch">
        <button id="watch-play-pause" data-rect="320,940,48,48"></button>
        <button id="watch-mute" data-rect="380,940,48,48"></button>
      </div>`);

    check('nothing is selected to begin with', id(w), 'BODY');

    press(w, 'ArrowDown');
    check('down still enters the interface', id(w), 'watch-play-pause');

    w.document.activeElement.blur();
    press(w, 'ArrowUp');
    check('up still enters the interface', id(w), 'watch-play-pause');
});

// ---------------------------------------------------------------
// Fullscreen confines the selection to the player
// ---------------------------------------------------------------
describe('fullscreen confinement', () => {
    const w = build(`
      <div class="page active" id="page-live">
        <a href="#" id="nav-home" class="nav-link" data-rect="100,8,90,34"></a>
        <div class="video-container css-fullscreen" data-rect="0,0,1280,1000">
          <button id="fs-play" data-rect="320,940,48,48"></button>
          <button id="fs-full" data-rect="1095,940,48,48"></button>
        </div>
      </div>`);

    w.document.getElementById('fs-play').focus();
    press(w, 'ArrowUp');
    check('up cannot escape to the navbar behind', id(w), 'fs-play');

    press(w, 'ArrowRight');
    check('right still works inside the player', id(w), 'fs-full');

    press(w, 'ArrowLeft');
    check('left still works inside the player', id(w), 'fs-play');
});

// ---------------------------------------------------------------
// Watch page control bar: the volume slider sits in the middle of it
// and used to trap the selection, leaving fullscreen unreachable.
// ---------------------------------------------------------------
describe('player control bar', () => {
    // Real order and rough geometry of the watch page bottom bar
    const w = build(`
      <div class="page active" id="page-watch">
        <input type="range" id="watch-progress" data-rect="0,900,1280,20">
        <button id="watch-skip-back" data-rect="40,940,48,48"></button>
        <button id="watch-play-pause" data-rect="100,940,56,48"></button>
        <button id="watch-skip-fwd" data-rect="170,940,48,48"></button>
        <button id="watch-mute" data-rect="800,940,48,48"></button>
        <input type="range" id="watch-volume" data-rect="860,940,100,48">
        <button id="watch-captions-btn" data-rect="975,940,48,48"></button>
        <button id="watch-pip" data-rect="1035,940,48,48"></button>
        <button id="watch-fullscreen" data-rect="1095,940,48,48"></button>
        <button id="watch-overflow" data-rect="1155,940,48,48"></button>
      </div>`);

    w.document.getElementById('watch-mute').focus();
    press(w, 'ArrowRight');
    check('right steps over the volume slider', id(w), 'watch-captions-btn');

    press(w, 'ArrowRight');
    check('right reaches picture-in-picture', id(w), 'watch-pip');

    press(w, 'ArrowRight');
    check('right reaches fullscreen', id(w), 'watch-fullscreen');

    press(w, 'ArrowRight');
    check('right reaches the overflow menu', id(w), 'watch-overflow');

    // and back the other way, still skipping the slider:
    // fullscreen, pip, captions, then mute
    press(w, 'ArrowLeft');
    press(w, 'ArrowLeft');
    press(w, 'ArrowLeft');
    press(w, 'ArrowLeft');
    check('left comes back to mute', id(w), 'watch-mute');

    press(w, 'ArrowLeft');
    check('left reaches skip forward', id(w), 'watch-skip-fwd');

    // the progress bar above is skipped too
    w.document.getElementById('watch-play-pause').focus();
    press(w, 'ArrowUp');
    check('up does not land on the progress slider', id(w), 'watch-play-pause');
});

// ---------------------------------------------------------------
// The watch page scrolls: the recommended movies sit below the
// player. Moving along the control bar must not drop into them.
// ---------------------------------------------------------------
describe('control bar with content below', () => {
    let recommended = '';
    for (let i = 0; i < 6; i++) {
        recommended += `<div class="watch-recommended-card" id="rec${i}" ` +
            `data-rect="${i * 200},1300,180,260"></div>`;
    }

    const w = build(`
      <div class="page active" id="page-watch">
        <button id="watch-skip-back" data-rect="40,940,48,48"></button>
        <button id="watch-play-pause" data-rect="100,940,56,48"></button>
        <button id="watch-skip-fwd" data-rect="170,940,48,48"></button>
        <button id="watch-mute" data-rect="800,940,48,48"></button>
        <input type="range" id="watch-volume" data-rect="860,940,100,48">
        <button id="watch-fullscreen" data-rect="1095,940,48,48"></button>
        <div class="watch-recommended-grid">${recommended}</div>
      </div>`);

    // The gap between skip-fwd and mute is 582px; rec1 is only 30px to the
    // right but 360px below. The button on the same row has to win.
    w.document.getElementById('watch-skip-fwd').focus();
    press(w, 'ArrowRight');
    check('right stays on the control bar, not the movies below', id(w), 'watch-mute');

    press(w, 'ArrowRight');
    check('right carries on to fullscreen', id(w), 'watch-fullscreen');

    // leaving the bar downwards is still possible
    press(w, 'ArrowDown');
    check('down reaches the recommended movies', id(w), 'rec5');

    // and moving along that row stays in it
    press(w, 'ArrowLeft');
    check('left stays among the recommended movies', id(w), 'rec4');
});

// ---------------------------------------------------------------
// Movies page: the header controls above the grid must be reachable
// ---------------------------------------------------------------
describe('movies page header controls', () => {
    let grid = '';
    for (let row = 0; row < 2; row++)
        for (let col = 0; col < 4; col++)
            grid += `<div class="movie-card" id="g${row}${col}" ` +
                `data-rect="${col * 180},${140 + row * 310},160,290"></div>`;

    const w = build(`
        <div class="movies-header">
          <select id="src" data-rect="0,60,180,36"></select>
          <select id="cat" data-rect="190,60,180,36"></select>
          <input type="text" id="search" class="search-input" data-rect="380,60,220,36">
          <button id="fav" data-rect="610,60,110,36"></button>
          <button id="rating" data-rect="730,60,100,36"></button>
        </div>
        <div class="movies-grid">${grid}</div>
    `);

    w.document.getElementById('g00').focus();
    press(w, 'ArrowUp');
    check('up from the first row reaches the header', id(w), 'src');

    press(w, 'ArrowRight');
    check('right moves along the header', id(w), 'cat');
    press(w, 'ArrowRight');
    check('right reaches the search field', id(w), 'search');

    // left/right inside the field belong to the caret, down gets out
    press(w, 'ArrowDown');
    check('down leaves the header for the grid', id(w), 'g02');

    // and the filter buttons are reachable
    w.document.getElementById('cat').focus();
    press(w, 'ArrowRight');
    press(w, 'ArrowRight');
    check('right reaches the favourites filter', id(w), 'fav');
    press(w, 'ArrowRight');
    check('right reaches the sort button', id(w), 'rating');
});

// ---------------------------------------------------------------
// Overlay action buttons live inside the card. They are real <button>s,
// so they used to catch the selection and make the grids unusable.
// ---------------------------------------------------------------
describe('card overlay action buttons', () => {
    const card = (name, x) => `
        <div class="movie-card" id="${name}" data-rect="${x},100,160,290">
            <button class="watchlist-btn" data-rect="${x + 8},108,32,32"></button>
            <button class="favorite-btn" data-rect="${x + 120},108,32,32"></button>
        </div>`;
    const w = build(card('m0', 0) + card('m1', 180) + card('m2', 360));

    w.document.getElementById('m0').focus();
    press(w, 'ArrowRight');
    check('right reaches the next card, not a button', id(w), 'm1');

    press(w, 'ArrowRight');
    check('right again reaches the third card', id(w), 'm2');

    press(w, 'ArrowLeft');
    check('left goes back one card', id(w), 'm1');

    // nor are they an entry point
    w.document.activeElement.blur();
    press(w, 'ArrowDown');
    check('entering the page lands on a card', id(w), 'm0');
});

// ---------------------------------------------------------------
// Dashboard: horizontal rows of unequal length must not be skipped.
// A long row scrolled to the right used to jump straight past a
// shorter row onto the one below, because a far but well-aligned
// card beat a near but offset one.
// ---------------------------------------------------------------
describe('dashboard sections of unequal length', () => {
    // Section A: 20 cards, row scrolled right by 1400px
    // Section B: only 3 cards, not scrolled
    // Section C: 20 cards, not scrolled
    const row = (prefix, count, top, scrollLeft) => {
        let out = '';
        for (let i = 0; i < count; i++) {
            out += `<div class="dashboard-card" id="${prefix}${i}" ` +
                `data-rect="${i * 200 - scrollLeft},${top},180,200"></div>`;
        }
        // Real dashboard markup: cards live inside a horizontal carousel
        return `<div class="horizontal-scroll">${out}</div>`;
    };

    const w = build(
        row('a', 20, 100, 1400) +   // a7 sits at x=0, a10 at x=600
        row('b', 3, 350, 0) +       // b0..b2 at x=0,200,400
        row('c', 20, 600, 0)
    );

    w.document.getElementById('a10').focus();
    check('starting point', id(w), 'a10');

    // Entering a carousel always starts at its first item
    press(w, 'ArrowDown');
    check('down enters the next section at its first item', id(w), 'b0');

    press(w, 'ArrowDown');
    check('down again enters the third section at its first item', id(w), 'c0');

    press(w, 'ArrowUp');
    check('up enters the short section at its first item', id(w), 'b0');

    press(w, 'ArrowUp');
    check('up enters the long section at its first item', id(w), 'a0');

    // Within a row, movement is still card by card
    press(w, 'ArrowRight');
    check('right moves one card along', id(w), 'a1');
    press(w, 'ArrowLeft');
    check('left moves back', id(w), 'a0');
});

// ---------------------------------------------------------------
// Every clickable-but-not-native class must be reachable.
// This is the regression guard: favourite channels (.channel-tile)
// shipped unreachable because the class was missing from the list.
// ---------------------------------------------------------------
describe('clickable class coverage', () => {
    // Every class that gets a click listener somewhere in public/js
    // and is not a <button>/<a>.
    const CLICKABLE = [
        'movie-card', 'series-card', 'dashboard-card', 'channel-item',
        'channel-tile', 'episode-item', 'watch-episode-item',
        'watch-recommended-card', 'season-header', 'watch-season-header',
        'group-header', 'content-group-header', 'epg-program',
        'epg-channel-name'
    ];

    const html = CLICKABLE
        .map((c, i) => `<div class="${c}" id="el${i}" data-rect="0,${i * 60},200,50"></div>`)
        .join('');
    const w = build(html);

    CLICKABLE.forEach((c, i) => {
        const el = w.document.getElementById(`el${i}`);
        check(`.${c} is focusable`, el.getAttribute('tabindex'), '0');
    });

    // and reachable by actually walking down through all of them
    w.document.getElementById('el0').focus();
    let reached = 1;
    for (let i = 0; i < CLICKABLE.length - 1; i++) {
        press(w, 'ArrowDown');
        reached++;
    }
    check('down reaches the last one', id(w), `el${CLICKABLE.length - 1}`);
    check('walked through every element', reached, CLICKABLE.length);
});

// ---------------------------------------------------------------
// Android wrapper detection. Both the television layout and the CSS
// fullscreen workaround hang off the user agent marker, and both must
// stay off in an ordinary browser.
// ---------------------------------------------------------------
const WRAPPER_UA = 'Mozilla/5.0 (Linux; Android 9; AFTKA) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 NodeCastTV-Android/1';

describe('android wrapper detection', () => {
    const desktop = build('<button id="b" data-rect="0,0,40,40"></button>');
    check('no tv layout in a plain browser',
        desktop.document.documentElement.classList.contains('tv-mode'), false);
    check('fullscreen stays with the native API',
        desktop.Fullscreen.inAndroidWrapper, false);

    const tv = build('<button id="b" data-rect="0,0,40,40"></button>',
        { userAgent: WRAPPER_UA });
    check('the wrapper gets the tv layout',
        tv.document.documentElement.classList.contains('tv-mode'), true);
    check('the wrapper takes over fullscreen',
        tv.Fullscreen.inAndroidWrapper, true);

    // In the wrapper, toggle() reports that it handled things itself and
    // lays the element out in CSS rather than calling requestFullscreen.
    const el = tv.document.getElementById('b');
    check('toggle claims the fullscreen', tv.Fullscreen.toggle(el), true);
    check('toggle lays it out in CSS', el.classList.contains('css-fullscreen'), true);
    check('toggle is a toggle', tv.Fullscreen.toggle(el) && el.classList.contains('css-fullscreen'), false);

    check('toggle declines outside the wrapper',
        desktop.Fullscreen.toggle(desktop.document.getElementById('b')), false);
});

// ---------------------------------------------------------------
// A modal owns the selection while it is open. The grid behind it stays
// laid out and focusable, so without confinement the arrows walk out of
// the dialog onto cards nobody can see.
// ---------------------------------------------------------------
describe('modal confinement', () => {
    const w = build(`
      <div id="page-movies" class="page active">
        <a href="#" id="nav-home" class="nav-link" data-rect="100,8,90,34"></a>
        <div class="movie-card" id="card-behind" data-rect="40,120,200,300"></div>
        <div class="dpad-trap" data-rect="300,200,700,500">
          <button id="modal-close" data-rect="960,220,40,40"></button>
          <button id="modal-play" data-rect="330,600,120,48"></button>
        </div>
      </div>`);

    w.document.getElementById('modal-play').focus();

    // Whatever is pressed, and however often, the selection has to stay on
    // one of the modal's own controls. The card and the navbar behind it
    // are laid out and focusable, and are exactly what used to catch it.
    const inside = ['modal-close', 'modal-play'];
    let escaped = null;
    for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
                       'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
        press(w, key);
        if (!inside.includes(id(w))) { escaped = key + ' -> ' + id(w); break; }
    }
    check('the selection never leaves the modal', escaped, null);

    // and it does move between the modal's own controls
    w.document.getElementById('modal-play').focus();
    press(w, 'ArrowUp');
    check('up reaches the close button', id(w), 'modal-close');
});

// ---------------------------------------------------------------
// A closed dialog is still in the document -- that is what hiding it
// means -- so its .dpad-trap is always there to be found. Matching one
// that is not on screen confined the selection to an invisible box and
// broke navigation on every page at once.
// ---------------------------------------------------------------
describe('a hidden trap confines nothing', () => {
    const w = build(`
      <div id="page-home" class="page active">
        <a href="#" id="nav-movies" class="nav-link" data-rect="100,8,90,34"></a>
        <div class="dashboard-card" id="card-a" data-rect="40,120,200,300"></div>
        <div class="dashboard-card" id="card-b" data-rect="260,120,200,300"></div>
        <div id="film-dialog" class="media-modal hidden">
          <div class="media-modal-box dpad-trap" data-rect="300,200,700,500">
            <button id="dialog-play" data-rect="330,600,120,48"></button>
          </div>
        </div>
      </div>`);

    w.document.getElementById('nav-movies').focus();

    press(w, 'ArrowDown');
    check('down from the navbar reaches the content', id(w), 'card-a');

    press(w, 'ArrowRight');
    check('and the row is walkable', id(w), 'card-b');

    // and once it is actually open, it takes over again
    w.document.getElementById('film-dialog').classList.remove('hidden');
    w.document.getElementById('dialog-play').focus();
    press(w, 'ArrowUp');
    check('an open dialog still owns the selection', id(w), 'dialog-play');
});
