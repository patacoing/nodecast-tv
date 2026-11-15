/**
 * Tests for CategoryRows.cleanTitle.
 *
 * Category names arrive decorated the way channel groups do -- "─ ✧･ﾟ||
 * Comédies" -- and the decoration is noise on a heading. The names below
 * are real ones from the catalogue.
 */
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// A browser script that hangs itself off window
global.window = {};
global.IntersectionObserver = class { observe() {} disconnect() {} };
eval(fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'categoryRows.js'), 'utf8'));
const { cleanTitle } = global.window.CategoryRows;

describe('cleanTitle', () => {
    it('drops the ornament this provider prefixes every category with', () => {
        assert.equal(cleanTitle('─ ✧･ﾟ|| Comédies'), 'Comédies');
        assert.equal(cleanTitle('─ ✧･ﾟ|| TOP 2025'), 'TOP 2025');
    });

    it('drops box-drawing rules on either side', () => {
        assert.equal(cleanTitle('── Animes ──'), 'Animes');
    });

    it('leaves a name that is only a name', () => {
        assert.equal(cleanTitle('Action & Aventure'), 'Action & Aventure');
        assert.equal(cleanTitle('LOONEY TUNES PACK VIP'), 'LOONEY TUNES PACK VIP');
    });

    it('keeps both halves when the part before the pipe is a real word', () => {
        // Ornament has no letters; "Canal+" does, and losing it would
        // rename the category
        assert.equal(cleanTitle('Canal+ | Ciné'), 'Canal+ | Ciné');
        assert.equal(cleanTitle('FR || Sport'), 'FR || Sport');
    });

    it('never returns nothing', () => {
        assert.equal(cleanTitle('─ ✧･ﾟ'), '─ ✧･ﾟ');
        assert.equal(cleanTitle(''), '');
        assert.equal(cleanTitle(null), '');
    });
});

/**
 * Seeing a whole category.
 *
 * A row shows twelve of what a category holds and the rest was reachable
 * nowhere at all -- the biggest category in this catalogue has 1644 films.
 * The way through is a grid rather than a longer row: nobody walks past a
 * dozen cards with a remote, and a row of that length is the decoded
 * bitmap problem the recycling exists to avoid.
 */
const { JSDOM } = require('jsdom');

describe('seeing a whole category', () => {
    const SRC = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'js', 'categoryRows.js'), 'utf8');

    function mount(groups) {
        const dom = new JSDOM('<div id="grid" class="movies-grid"></div>',
            { runScripts: 'outside-only', pretendToBeVisual: true });
        const { window } = dom;
        const observed = [];
        window.IntersectionObserver = class {
            constructor(cb) { this.cb = cb; observed.push(this); }
            observe(el) { this.el = el; }
            disconnect() { this.disconnected = true; }
            fire() { this.cb([{ isIntersecting: true }]); }
        };
        window.eval(SRC);

        const container = window.document.getElementById('grid');
        const made = [];
        const rows = new window.CategoryRows(container, (item) => {
            const el = window.document.createElement('div');
            el.className = 'movie-card';
            el.textContent = item.name;
            made.push(item.name);
            return el;
        });
        rows.render(groups);
        return { window, container, rows, made, observed };
    }

    const many = (n, prefix = 'f') =>
        Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}` }));

    it('offers the way through only when there is more than a row holds', () => {
        const h = mount([
            { title: 'Petite', items: many(5, 'a') },
            { title: 'Grande', items: many(40, 'b') }
        ]);
        const buttons = [...h.container.querySelectorAll('.cat-row-more')];
        assert.equal(buttons.length, 1);
        assert.match(buttons[0].textContent, /See all 40/);
    });

    it('says how many there are, not just that there are more', () => {
        const h = mount([{ title: 'Grande', items: many(1644) }]);
        assert.equal(h.container.querySelector('.cat-row-more').textContent,
            'See all 1644');
    });

    it('opens the category as a grid, not a longer row', () => {
        const h = mount([{ title: 'Grande', items: many(40) }]);
        h.container.querySelector('.cat-row-more').click();
        assert.equal(h.container.classList.contains('showing-rows'), false);
        assert.equal(h.container.querySelector('.cat-row'), null);
        assert.equal(h.container.querySelector('.cat-all-title').textContent,
            'Grande (40)');
    });

    it('fills the grid in batches rather than all at once', () => {
        // 1644 cards in the document at once is what the row recycling
        // was written to prevent
        const h = mount([{ title: 'Grande', items: many(1644) }]);
        h.made.length = 0;
        h.container.querySelector('.cat-row-more').click();
        const first = h.container.querySelectorAll('.movie-card').length;
        assert.ok(first > 0 && first < 1644, `first batch was ${first}`);

        const grid = h.observed[h.observed.length - 1];
        grid.fire();
        assert.ok(h.container.querySelectorAll('.movie-card').length > first);
    });

    it('stops observing once the category is fully shown', () => {
        const h = mount([{ title: 'Petite mais longue', items: many(70) }]);
        h.container.querySelector('.cat-row-more').click();
        const grid = h.observed[h.observed.length - 1];
        grid.fire();   // 60 + 10
        assert.equal(h.container.querySelectorAll('.movie-card').length, 70);
        assert.equal(grid.disconnected, true);
        assert.equal(h.container.querySelector('.cat-all-sentinel'), null);
    });

    it('comes back to the rows it was opened from', () => {
        const h = mount([
            { title: 'Un', items: many(40, 'a') },
            { title: 'Deux', items: many(40, 'b') }
        ]);
        h.container.querySelector('.cat-row-more').click();
        h.container.querySelector('.cat-all-back').click();
        assert.equal(h.container.classList.contains('showing-rows'), true);
        assert.equal(h.container.querySelectorAll('.cat-row').length > 0, true);
        assert.equal(h.container.querySelector('.cat-all-head'), null);
    });

    it('leaves the grid behind when the page renders something else', () => {
        // Typing in the search box re-renders; an open category must not
        // survive it
        const h = mount([{ title: 'Grande', items: many(40) }]);
        h.container.querySelector('.cat-row-more').click();
        h.rows.render([{ title: 'Résultats', items: many(3) }]);
        assert.equal(h.container.querySelector('.cat-all-head'), null);
        assert.equal(h.rows.showingAll, null);
    });

    it('puts a back button where a remote can reach it', () => {
        const h = mount([{ title: 'Grande', items: many(40) }]);
        h.container.querySelector('.cat-row-more').click();
        const back = h.container.querySelector('.cat-all-back');
        assert.equal(back.tagName, 'BUTTON');   // the d-pad walks real buttons
        assert.equal(back.type, 'button');      // never submits anything
    });
});
