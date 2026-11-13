/**
 * The instruments this application reports.
 *
 * Chosen from what actually went wrong, not from what is easy to count.
 * Every failure diagnosed over the last weeks was invisible until someone
 * watched a television and said something had stopped: a provider
 * answering 403 in bursts, a channel whose feed quietly dropped its audio
 * track, a domain that lost its A record, a host the living room could not
 * reach while the server could, ffmpeg refusing extensionless segments.
 * Each one of those is a line on a graph here.
 *
 * Instruments are created once and are cheap to record to when nothing is
 * collecting, so the call sites do not need guarding.
 */

const { metrics } = require('@opentelemetry/api');

const meter = metrics.getMeter('nodecast-tv', require('../../package.json').version);

// --- The provider -------------------------------------------------------
// Upstream is the thing that breaks, and it breaks in ways worth telling
// apart: refused (4xx), broken (5xx), unreachable (no answer at all).
const upstreamRequests = meter.createCounter('nodecast_upstream_requests_total', {
    description: 'Requests to the IPTV provider, by kind and outcome'
});

const upstreamDuration = meter.createHistogram('nodecast_upstream_duration_seconds', {
    description: 'How long the provider took to answer',
    unit: 's'
});

// --- Playback -----------------------------------------------------------
const transcodeSessions = meter.createUpDownCounter('nodecast_transcode_sessions_active', {
    description: 'Transcode sessions running right now'
});

const transcodeStarts = meter.createCounter('nodecast_transcode_starts_total', {
    description: 'Transcode sessions started, by reason and video mode'
});

const probeResults = meter.createCounter('nodecast_probe_results_total', {
    description: 'Stream probes, by what was found in the stream'
});

// --- Downloads ----------------------------------------------------------
const downloadsStarted = meter.createCounter('nodecast_downloads_started_total', {
    description: 'Offline downloads begun, by kind'
});

const downloadsFinished = meter.createCounter('nodecast_downloads_finished_total', {
    description: 'Offline downloads that ended, by outcome'
});

const downloadBytes = meter.createHistogram('nodecast_download_bytes', {
    description: 'Size of a prepared download',
    unit: 'By'
});

// --- Catalogue ----------------------------------------------------------
const syncRuns = meter.createCounter('nodecast_sync_runs_total', {
    description: 'Catalogue and EPG synchronisations, by source type and outcome'
});

const syncDuration = meter.createHistogram('nodecast_sync_duration_seconds', {
    description: 'How long a synchronisation took',
    unit: 's'
});

const tmdbRequests = meter.createCounter('nodecast_tmdb_requests_total', {
    description: 'Calls to TMDB, by outcome'
});

/**
 * Gauges read straight from SQLite when something scrapes, rather than
 * being pushed. Counting rows is cheap and always current, where a pushed
 * value goes stale the moment anything changes behind our back.
 */
function registerCatalogueGauges(getDb) {
    meter.createObservableGauge('nodecast_catalogue_items', {
        description: 'Entries in the catalogue, by type'
    }).addCallback(result => {
        try {
            for (const row of getDb().prepare(
                `SELECT type, COUNT(*) n FROM playlist_items GROUP BY type`).all()) {
                result.observe(row.n, { type: row.type });
            }
        } catch { /* a scrape must never be the thing that breaks the app */ }
    });

    meter.createObservableGauge('nodecast_downloads_held', {
        description: 'Offline downloads held on disk, by status'
    }).addCallback(result => {
        try {
            for (const row of getDb().prepare(
                `SELECT status, COUNT(*) n FROM downloads GROUP BY status`).all()) {
                result.observe(row.n, { status: row.status });
            }
        } catch { /* table may not exist yet on a fresh install */ }
    });

    meter.createObservableGauge('nodecast_downloads_bytes_held', {
        description: 'Disk taken by prepared downloads',
        unit: 'By'
    }).addCallback(result => {
        try {
            const row = getDb().prepare(
                `SELECT COALESCE(SUM(size), 0) b FROM downloads WHERE status = 'ready'`).get();
            result.observe(row.b);
        } catch { /* as above */ }
    });
}

module.exports = {
    meter,
    upstreamRequests, upstreamDuration,
    transcodeSessions, transcodeStarts, probeResults,
    downloadsStarted, downloadsFinished, downloadBytes,
    syncRuns, syncDuration, tmdbRequests,
    registerCatalogueGauges
};
