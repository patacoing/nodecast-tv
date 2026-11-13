/**
 * The identity of a catalogue entry.
 *
 * It used to be `source:providerId`, and that was wrong in a way that cost
 * this catalogue most of its series. The provider numbers each kind of
 * content from its own sequence, so a live channel and a series routinely
 * carry the same number: measured on this account, 6410 of 6524 series
 * shared an id with a live channel.
 *
 * Both therefore landed on the same row. The upsert that followed updated
 * the name, the artwork and the payload but not the `type` column, so a
 * series was written into a live channel's row and kept calling itself a
 * channel. The sync reported "Saved 6519 series items" and the table held
 * 401 of them; 6082 rows carried a type that contradicted their own
 * contents, which is why the series library was missing and the channel
 * list was full of television shows.
 *
 * The kind belongs in the identity. One function, so the format cannot
 * drift between the sync that writes it and the pages that ask for it.
 */

/** @param {number|string} sourceId @param {string} type @param {number|string} providerId */
function itemId(sourceId, type, providerId) {
    return `${sourceId}:${type}:${providerId}`;
}

/**
 * Split one back apart. Returns null for anything that is not in the
 * current format, which is how the migration tells old rows from new.
 */
function parseItemId(id) {
    const m = /^([^:]+):([a-z_]+):(.+)$/.exec(String(id || ''));
    return m ? { sourceId: m[1], type: m[2], providerId: m[3] } : null;
}

module.exports = { itemId, parseItemId };
