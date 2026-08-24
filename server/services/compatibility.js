/**
 * What a browser can play, and what has to be done to a stream that it
 * cannot.
 *
 * This lived inside the probe route, which was fine while probing was the
 * only way to learn a stream's codecs. An Xtream provider states them for
 * every film in its catalogue, so the same question now gets asked from two
 * places -- and two copies of this rule would drift, with the consequence
 * that a film is prepared one way and then played another.
 */

// What a browser decodes natively. Anything else has to go through ffmpeg.
const BROWSER_VIDEO_CODECS = ['h264', 'avc', 'avc1'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];

// Containers a browser will take as-is. 'webm' is deliberately absent:
// ffprobe reports MKV as "matroska,webm", and H.264/AAC in MKV is not
// universally supported, so it is better remuxed to MP4.
const BROWSER_CONTAINERS = ['hls', 'mp4', 'mov'];

const includesAny = (value, list) =>
    list.some(c => String(value || '').toLowerCase().includes(c));

/**
 * Decide what a stream needs.
 *
 * @param {object} stream  { video, audio, container } codec and container
 *                         names, however they were learnt.
 * @param {string} url     used only to recognise a raw .ts or a .mkv when
 *                         the container name is not conclusive.
 */
function decide({ video, audio, container }, url = '') {
    const videoOk = includesAny(video, BROWSER_VIDEO_CODECS);
    const audioOk = includesAny(audio, BROWSER_AUDIO_CODECS);
    const containerOk = includesAny(container, BROWSER_CONTAINERS);

    const isRawTs = (includesAny(container, ['mpegts']) || url.endsWith('.ts'))
        && !url.includes('.m3u8');

    // MKV causes decoding failures and memory blowups in the browser's fMP4
    // remux path, so it is pushed down the HLS route even when its codecs
    // are fine. The caller still copies rather than re-encodes the video
    // when it can, so this costs little.
    const isMkv = includesAny(container, ['matroska', 'webm', 'mkv'])
        || url.endsWith('.mkv');

    const needsTranscode = !audioOk || !videoOk || isMkv;
    const needsRemux = !needsTranscode && (!containerOk || isRawTs);

    return {
        videoOk,
        audioOk,
        needsTranscode,
        needsRemux,
        compatible: !needsTranscode && !needsRemux,
        /**
         * Whether ffmpeg has to re-encode the picture or can pass it
         * through. Copying is enormously cheaper, and the video is usually
         * fine on its own -- it is the AC3 soundtrack that a browser
         * refuses. Upscaling forces a real encode, so the caller overrides
         * this when it is on.
         */
        videoMode: videoOk ? 'copy' : 'encode'
    };
}

module.exports = {
    decide,
    BROWSER_VIDEO_CODECS,
    BROWSER_AUDIO_CODECS,
    BROWSER_CONTAINERS
};
