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
