/**
 * Whether a stream URL names a live channel.
 *
 * The caller used to be the only one who knew. The player posts
 * isLive: true, and the server took its word for it -- which held right
 * up until a client that predated the flag asked for a channel. The app
 * had been open on the box since before the deploy, so it was still
 * running the old script, and the session it opened got the VOD output
 * options: a playlist that only ever grows. Fifty-five minutes of a
 * single channel came to 1.4 GB on a disk with 2.6 GB left on it.
 *
 * The server can tell on its own. Xtream puts the kind in the path:
 *
 *   http://host:9798/live/user/pass/471.m3u8     a channel
 *   http://host:9798/movie/user/pass/61610.mkv   a film
 *   http://host:9798/series/user/pass/8821.mkv   an episode
 *
 * so a live URL is treated as live whatever the caller says, and an old
 * client -- or a new bug in a new caller -- cannot fill the disk again.
 * A plain .m3u8 is not enough to go on: a VOD playlist is one too.
 */
function isLiveUrl(url) {
    return /(^|\/)live\//i.test(String(url || ''));
}

module.exports = { isLiveUrl };
