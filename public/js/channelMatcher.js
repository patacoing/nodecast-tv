/**
 * Matching a provider's channel to an EPG channel by name.
 *
 * Only 5% of the channels in a typical Xtream catalogue carry an EPG id,
 * so almost everything has to be matched by name -- and the names are
 * written for a list on a set-top box, not for a database:
 *
 *     FR || TF1 [SD]        vs   TF1
 *     [#] BeIN SPORTS 1 HD  vs   beIN SPORTS 1
 *     |FR| CANAL+ FHD       vs   Canal+
 *
 * Comparing those as they stand matches nothing, which is why the guide
 * was empty for all but a handful of channels.
 */

// Quality and format markers that decorate a channel name without being
// part of it. Whole words only, so "HD" goes and "HDTV News" survives.
const CHANNEL_TAGS = [
    'sd', 'hd', 'fhd', 'uhd', '4k', '8k', 'hq', 'lq',
    'h265', 'hevc', 'h264', '50fps', '60fps', 'raw', 'backup', 'alt'
];

// Leading country or language markers: "FR ||", "|FR|", "[FR]", "FR:",
// "[#]", "• FR -". Anything up to and including the separator.
const PREFIX_RE = /^\s*[\[({|#•*-]*\s*(?:[a-z]{2,3}|#|\d{1,3})?\s*[\])}|#•*]*\s*(?:\|\||[|:>\-–])\s*/i;

/**
 * The form two channel names are compared in. Everything that is not a
 * letter or a digit goes, along with the decoration around the name.
 *
 *     "FR || TF1 [SD]"  ->  "tf1"
 *     "[#] TF1"         ->  "tf1"
 *     "beIN SPORTS 1 HD" -> "bein sports 1"
 */
function normalizeChannel(rawName) {
    let name = String(rawName || '');

    // Strip the leading marker, possibly repeated: "FR || [#] TF1"
    let previous;
    do {
        previous = name;
        name = name.replace(PREFIX_RE, '');
    } while (name !== previous && name.length > 0);

    // Bracketed decoration: [SD], (HD), {FR}
    name = name.replace(/[[({][^\])}]*[\])}]/g, ' ');

    name = name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    // Bare quality tags, wherever they ended up
    const words = name.split(' ').filter(w => w && !CHANNEL_TAGS.includes(w));
    return words.join(' ');
}

/**
 * Index EPG channels by their normalised name.
 *
 * Two entries can share a name for opposite reasons. Usually it is the
 * same channel described by two sources -- the provider's own EPG and an
 * external XMLTV both carry TF1 -- and then the one with a real schedule
 * is the one to keep; dropping both is how the guide came to say "No data"
 * against TF1 while holding seventy thousand programmes.
 *
 * Sometimes it is genuinely two channels, and then guessing is worse than
 * showing nothing, because nothing on screen would say it is wrong. With
 * no way to tell them apart -- equal weight -- the name is dropped.
 *
 * @param weigh  how much schedule an entry has; the heavier one wins.
 */
function indexByName(epgChannels, weigh = () => 0) {
    const byName = new Map();
    const dropped = new Set();

    for (const epg of epgChannels || []) {
        const key = normalizeChannel(epg.name);
        if (!key) continue;

        const held = byName.get(key);
        if (!held || held.id === epg.id) {
            byName.set(key, epg);
            continue;
        }

        const a = weigh(held), b = weigh(epg);
        if (a === b) { dropped.add(key); continue; }
        if (b > a) byName.set(key, epg);
        dropped.delete(key);
    }
    for (const key of dropped) byName.delete(key);
    return byName;
}

/**
 * Find the EPG channel for one of the provider's channels: by its stated
 * id first, since that is authoritative, then by name.
 */
function matchChannel(sourceChannel, byId, byName) {
    const id = sourceChannel.tvgId || sourceChannel.epg_channel_id;
    if (id && byId?.has(id)) return byId.get(id);

    const key = normalizeChannel(sourceChannel.name);
    return (key && byName?.get(key)) || null;
}

if (typeof window !== 'undefined') {
    window.ChannelMatcher = { normalizeChannel, indexByName, matchChannel, CHANNEL_TAGS };
}
if (typeof module !== 'undefined') {
    module.exports = { normalizeChannel, indexByName, matchChannel, CHANNEL_TAGS };
}
