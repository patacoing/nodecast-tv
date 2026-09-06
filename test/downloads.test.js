/**
 * Tests for the signed download links.
 *
 * A phone's download manager does not send the Authorization header -- the
 * app adds it from JavaScript, and a plain link leaves without it. So the
 * link has to prove itself, and these are the ways that proof can be got
 * wrong.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const manager = require('../server/services/downloadManager');

describe('signed links', () => {
    it('accepts a link it just made', () => {
        const { expires, signature } = manager.signLink('10:123');
        assert.equal(manager.verifyLink('10:123', expires, signature), true);
    });

    it('refuses a signature made for another film', () => {
        // Or one film's link would fetch another's file
        const { expires, signature } = manager.signLink('10:123');
        assert.equal(manager.verifyLink('10:999', expires, signature), false);
    });

    it('refuses a tampered expiry', () => {
        // Extending the life of a link must invalidate it, not extend it
        const { expires, signature } = manager.signLink('10:123');
        assert.equal(manager.verifyLink('10:123', expires + 3600000, signature), false);
    });

    it('refuses a link that has run out', () => {
        const { signature } = manager.signLink('10:123', -1000);
        const expired = Date.now() - 1000;
        assert.equal(manager.verifyLink('10:123', expired, signature), false);
    });

    it('refuses a signature of the wrong length without throwing', () => {
        // timingSafeEqual throws on mismatched lengths, so the guard has to
        // come first
        const { expires } = manager.signLink('10:123');
        assert.equal(manager.verifyLink('10:123', expires, 'short'), false);
        assert.equal(manager.verifyLink('10:123', expires, ''), false);
        assert.equal(manager.verifyLink('10:123', expires, undefined), false);
    });

    it('refuses nonsense in place of an expiry', () => {
        const { signature } = manager.signLink('10:123');
        assert.equal(manager.verifyLink('10:123', 'soon', signature), false);
        assert.equal(manager.verifyLink('10:123', NaN, signature), false);
    });

    it('gives two films different signatures at the same instant', () => {
        const a = manager.signLink('10:1', 60000);
        const b = manager.signLink('10:2', 60000);
        assert.notEqual(a.signature, b.signature);
    });
});
