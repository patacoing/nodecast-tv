const express = require('express');
const { hlsInputArgs } = require('../services/hlsInput');
const router = express.Router();
const { spawn } = require('child_process');

/**
 * Probe endpoint - detects stream codecs and container
 * GET /api/probe?url=...
 * 
 * Returns:
 * {
 *   video: "h264",
 *   audio: "aac",
 *   container: "mpegts",
 *   compatible: true,
 *   needsRemux: false,
 *   needsTranscode: false
 * }
 */

// Probe cache (URL → result)
const probeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// The rule lives in one place: the same question is asked from the film
// dialog, using the codecs the provider states, before anything is probed.
const compatibility = require('../services/compatibility');

/**
 * Probe stream with ffprobe
 */
function probeStream(url, ffprobePath, userAgent = null, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-user_agent', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            ...hlsInputArgs(url),
            url
        ];

        const proc = spawn(ffprobePath, args);
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Probe timeout'));
        }, timeout);

        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (e) {
                reject(new Error('Failed to parse ffprobe output'));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Analyze probe result and determine compatibility
 */
function analyzeProbeResult(probeResult, url) {
    const streams = probeResult.streams || [];
    const format = probeResult.format || {};

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStream = streams.find(s => s.codec_type === 'audio');

    const videoCodec = videoStream?.codec_name?.toLowerCase() || 'unknown';
    const audioCodec = audioStream?.codec_name?.toLowerCase() || 'unknown';
    const container = format.format_name?.toLowerCase() || 'unknown';

    const verdict = compatibility.decide(
        { video: videoCodec, audio: audioCodec, container }, url);

    // Extract subtitle tracks
    const subtitles = streams
        .filter(s => s.codec_type === 'subtitle' && s.codec_name !== 'timed_id3' && s.codec_name !== 'bin_data')
        .map(s => ({
            index: s.index,
            language: s.tags?.language || 'und',
            title: s.tags?.title || s.tags?.language || `Track ${s.index}`,
            codec: s.codec_name
        }));

    const durationSec = parseFloat(format.duration);

    return {
        video: videoCodec,
        audio: audioCodec,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        audioChannels: audioStream?.channels || 0, // For Smart Audio Copy
        container: container,
        compatible: verdict.compatible,
        needsRemux: verdict.needsRemux,
        needsTranscode: verdict.needsTranscode,
        subtitles: subtitles,
        duration: isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : null
    };
}

router.get('/', async (req, res) => {
    const { url, ua } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffprobePath = req.app.locals.ffprobePath;
    const cacheKey = `${url}${ua ? `|${ua}` : ''}`;

    if (!ffprobePath) {
        // No ffprobe available - assume needs transcoding to be safe
        console.log('[Probe] FFprobe not available, assuming transcode needed');
        return res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true
        });
    }

    // Check cache
    const cached = probeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[Probe] Cache hit for: ${url.substring(0, 50)}...`);
        return res.json(cached.result);
    }

    console.log(`[Probe] Probing: ${url.substring(0, 80)}... ${ua ? `(UA: ${ua})` : ''}`);

    try {
        const probeResult = await probeStream(url, ffprobePath, ua);
        const analysis = analyzeProbeResult(probeResult, url);

        // Cache result
        probeCache.set(cacheKey, { result: analysis, timestamp: Date.now() });

        console.log(`[Probe] Result: video=${analysis.video}, audio=${analysis.audio}, ` +
            `container=${analysis.container}, compatible=${analysis.compatible}, ` +
            `needsRemux=${analysis.needsRemux}, needsTranscode=${analysis.needsTranscode}`);

        res.json(analysis);
    } catch (err) {
        console.error('[Probe] Failed:', err.message);

        // On error, assume transcode needed to be safe
        res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true,
            error: err.message
        });
    }
});

module.exports = router;
