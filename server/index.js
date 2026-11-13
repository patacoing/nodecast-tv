// Before everything else. The instrumentations work by patching http and
// express as they load, and a module already loaded is a module already
// missed -- so this line has to stay first, above the requires below.
require('dotenv').config();
require('./telemetry').start();

const log = require('./telemetry/logger');
const express = require('express');
const path = require('path');
const passport = require('passport');
const syncService = require('./services/syncService');

// Initialize database
require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy headers (X-Forwarded-Proto, X-Forwarded-For, etc.)
// Required for correct protocol detection behind reverse proxies (nginx, Caddy, etc.)
app.set('trust proxy', true);

// Middleware
app.use(express.json({ limit: '50mb' }));

// Initialize Passport
const session = require('express-session');
app.use(session({
    secret: process.env.JWT_SECRET || 'keyboard cat',
    resave: false,
    saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());

// Le service worker doit toujours être servi sans cache HTTP pour que les mises à jour soient détectées
app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// FFMPEG Configuration (optional - for transcoding support)
// Priority: 1. System FFmpeg (better Docker DNS support), 2. ffmpeg-static npm package
const { execSync } = require('child_process');

function findFFmpeg() {
    // Try system FFmpeg first (better Docker compatibility)
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        log.info('FFmpeg binary configured at: ffmpeg (system)');
        return 'ffmpeg';
    } catch (e) {
        // System FFmpeg not found, try ffmpeg-static
    }

    // Try ffmpeg-static npm package
    try {
        let ffmpegPath = require('ffmpeg-static');
        // In packaged Electron apps, ffmpeg-static returns path inside .asar archive
        // but the binary is actually unpacked to app.asar.unpacked
        if (ffmpegPath && ffmpegPath.includes('app.asar')) {
            ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
        }
        log.info('FFmpeg binary configured at:', ffmpegPath);
        return ffmpegPath;
    } catch (err) {
        log.warn('FFmpeg not available - transcoding/remuxing will be disabled.');
        log.warn('Install FFmpeg via your package manager or npm install ffmpeg-static');
        return null;
    }
}

function findFFprobe() {
    // Try system ffprobe first
    try {
        execSync('ffprobe -version', { stdio: 'ignore' });
        log.info('FFprobe binary configured at: ffprobe (system)');
        return 'ffprobe';
    } catch (e) {
        // Not found in system
    }

    // Try @ffprobe-installer/ffprobe package
    try {
        const ffprobePath = require('@ffprobe-installer/ffprobe').path;
        if (ffprobePath) {
            log.info('FFprobe binary configured at:', ffprobePath);
            return ffprobePath;
        }
    } catch (err) {
        // Package not available
    }

    log.warn('FFprobe not available - auto transcode will fallback to always transcode');
    return null;
}

app.locals.ffmpegPath = findFFmpeg();
app.locals.ffprobePath = findFFprobe();

// Dynamic services loader - collects exports from files in ./services
const fs = require('fs');
const services = {};
try {
    const servicesDir = path.join(__dirname, 'services');
    const serviceFiles = fs.readdirSync(servicesDir).filter(f => f.endsWith('.js'));
    for (const file of serviceFiles) {
        const name = file.replace(/\.js$/, '');
        try {
            services[name] = require(path.join(servicesDir, file));
        } catch (e) {
            log.warn(`Failed to load service ${file}:`, e.message);
        }
    }
} catch (e) {
    log.warn('No services directory found or failed to read services:', e.message);
}

// Freeze services object to prevent plugins from mutating shared state
Object.freeze(services);

// Plugin loader: loads any .js file inside server/plugins and calls the
// exported function with (app, services).
// Supports both function exports and object exports with lifecycle hooks.
const loadedPlugins = [];

async function loadPlugins() {
    try {
        const pluginsDir = path.join(__dirname, 'plugins');
        if (fs.existsSync(pluginsDir)) {
            // Sort plugin files alphabetically for deterministic load order
            const pluginFiles = fs.readdirSync(pluginsDir)
                .filter(f => f.endsWith('.js'))
                .sort();

            for (const file of pluginFiles) {
                const pluginPath = path.join(pluginsDir, file);
                try {
                    const plugin = require(pluginPath);

                    // Support both function exports and object exports with lifecycle hooks
                    if (typeof plugin === 'function') {
                        // Direct function export (sync or async)
                        await plugin(app, services);
                        loadedPlugins.push({ name: file, plugin: null });
                        log.info(`✓ Loaded plugin: ${file}`);
                    } else if (plugin && typeof plugin.init === 'function') {
                        // Object export with init/shutdown lifecycle
                        await plugin.init(app, services);
                        loadedPlugins.push({ name: file, plugin });
                        log.info(`✓ Loaded plugin: ${file} (with lifecycle hooks)`);
                    } else {
                        log.warn(`⚠ Plugin ${file} does not export a function or object with init(), skipping.`);
                    }
                } catch (err) {
                    log.error(`✗ Failed to load plugin ${file}:`, err);
                }
            }
        }
    } catch (err) {
        log.warn('Plugin loader failed:', err.message);
    }
}

// Graceful shutdown handler for plugins with shutdown hooks
process.on('SIGTERM', async () => {
    log.info('SIGTERM received, shutting down plugins...');
    for (const { name, plugin } of loadedPlugins) {
        if (plugin && typeof plugin.shutdown === 'function') {
            try {
                await plugin.shutdown();
                log.info(`✓ Shutdown plugin: ${name}`);
            } catch (err) {
                log.error(`✗ Error shutting down plugin ${name}:`, err);
            }
        }
    }
    process.exit(0);
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sources', require('./routes/sources'));
app.use('/api/proxy', require('./routes/proxy'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/watchlist', require('./routes/watchlist'));
app.use('/api/transcode', require('./routes/transcode'));
app.use('/api/remux', require('./routes/remux'));
app.use('/api/probe', require('./routes/probe'));
app.use('/api/subtitle', require('./routes/subtitle'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/history', require('./routes/history'));
app.use('/api/tmdb', require('./routes/tmdb'));
app.use('/api/search', require('./routes/search'));
app.use('/api/downloads', require('./routes/downloads'));

// Version endpoint
app.get('/api/version', (req, res) => {
    const pkg = require('../package.json');
    res.json({ version: pkg.version });
});

/**
 * Liveness, for uptime-kuma and for anything that restarts containers.
 * Deliberately cheap and unauthenticated: it answers whether the process
 * is serving, not whether the catalogue is any good.
 */
app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', version: require('../package.json').version,
        uptime_s: Math.round(process.uptime()) });
});

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
    log.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, async () => {
    log.info(`NodeCast TV server running on http://localhost:${PORT}`);

    // Counting rows when something scrapes, rather than pushing a number
    // that goes stale the moment anything changes behind our back.
    try {
        const { registerCatalogueGauges } = require('./telemetry/metrics');
        registerCatalogueGauges(require('./db/sqlite').getDb);
    } catch (err) {
        log.warn('[Telemetry] Catalogue gauges unavailable:', err.message);
    }

    // Before anything slow. A download that was running when the server
    // stopped left a partial file that would otherwise pass for a finished
    // one -- and if this waits behind the catalogue sync, which takes
    // minutes, it marks as interrupted a job that started in the meantime.
    try {
        require('./services/downloadManager').recoverInterrupted();
    } catch (err) {
        log.warn('Download recovery failed:', err.message);
    }

    // Load plugins
    await loadPlugins().catch(err => {
        log.error('Plugin initialization failed:', err);
    });

    // Trigger background sync with delay to allow server to settle
    setTimeout(async () => {
        await syncService.syncAll().catch(err => log.error(err));
        // Start the server-side sync timer after initial sync
        await syncService.startSyncTimer().catch(err => log.error(err));

        // Detect hardware acceleration capabilities
        try {
            const hwDetect = require('./services/hwDetect');
            await hwDetect.detect();
        } catch (err) {
            log.warn('Hardware detection failed:', err.message);
        }

        // TMDB enrichment. Starts its own timer and does nothing at all
        // without a key, so a server with no TMDB account is unaffected.
        try {
            const tmdbEnricher = require('./services/tmdbEnricher');
            tmdbEnricher.start(Number(process.env.TMDB_PASS_INTERVAL_HOURS) || 6);
            // The catalogue has just been synced: whatever arrived today is
            // waiting, and after the first backfill this is a few dozen
            // entries rather than the whole library.
            tmdbEnricher.runPass().catch(err =>
                log.error('[TMDB] Initial pass failed:', err));
        } catch (err) {
            log.warn('TMDB enrichment failed to start:', err.message);
        }
    }, 5000);
});
