/**
 * Input options needed to read this provider's HLS playlists.
 *
 * ffmpeg refuses a segment whose file extension is not on a whitelist --
 * a sensible guard against a playlist pointing somewhere it should not.
 * This provider's segments carry no extension at all: the URLs look like
 *
 *   http://205.237.107.237:80/hls/hASHnAxCPf6Q61n6lfr4F65OMK...
 *
 * so every one of them is refused and the input fails outright with
 * "Invalid data found when processing input". Playback worked because
 * hls.js in the browser has no such rule; anything going through ffmpeg
 * -- the transcode sessions, the probe, the remux -- did not.
 *
 * The option belongs to the HLS demuxer, so it is only recognised when
 * the input actually is a playlist: passing it for an mkv aborts the
 * command with "Option extension_picky not found". Hence the test on the
 * URL rather than passing it everywhere.
 */
function hlsInputArgs(url) {
    return /\.m3u8(\?|$)/i.test(String(url || '')) ? ['-extension_picky', '0'] : [];
}

module.exports = { hlsInputArgs };
