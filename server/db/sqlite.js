const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', '..', 'data');
const dbPath = path.join(dataDir, 'content.db');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDb() {
    if (!db) {
        console.log('[SQLite] Opening database at', dbPath);
        db = new Database(dbPath);
        // Optimize performance
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        initSchema();
    }
    return db;
}

function initSchema() {
    if (!db) throw new Error('Database not initialized');

    // Categories (Groups)
    db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY, -- Composite key: sourceId:categoryId
            source_id INTEGER NOT NULL,
            category_id TEXT NOT NULL,
            type TEXT NOT NULL, -- 'live', 'movie', 'series'
            name TEXT NOT NULL,
            parent_id TEXT, -- For nested categories
            is_hidden INTEGER DEFAULT 0,
            data JSON -- Extra provider data
        );
        CREATE INDEX IF NOT EXISTS idx_categories_source_type ON categories(source_id, type);
    `);

    // Playlist Items (Channels, Movies, Series, Episodes)
    db.exec(`
        CREATE TABLE IF NOT EXISTS playlist_items (
            id TEXT PRIMARY KEY, -- Composite key: sourceId:itemId
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL, -- Original ID from provider
            type TEXT NOT NULL, -- 'live', 'movie', 'series', 'episode'
            name TEXT NOT NULL,
            category_id TEXT, -- maps to categories.category_id (not our composite id)
            parent_id TEXT, -- For episodes -> series_id
            
            -- Common Media Fields
            stream_icon TEXT,
            stream_url TEXT, -- Direct link if available
            container_extension TEXT,
            
            -- VOD/Series Specific
            rating REAL,
            year TEXT,
            added_at TEXT,
            
            -- App State
            is_hidden INTEGER DEFAULT 0,
            is_favorite INTEGER DEFAULT 0,
            
            data JSON -- Full original JSON object
        );
        CREATE INDEX IF NOT EXISTS idx_items_source_type ON playlist_items(source_id, type);
        CREATE INDEX IF NOT EXISTS idx_items_category ON playlist_items(source_id, category_id);
    `);

    // EPG Programs
    // Optimized for range queries
    db.exec(`
        CREATE TABLE IF NOT EXISTS epg_programs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL, -- matches playlist_items.id if possible, or mapping key
            source_id INTEGER NOT NULL,
            start_time INTEGER NOT NULL, -- Unix timestamp (ms)
            end_time INTEGER NOT NULL,   -- Unix timestamp (ms)
            title TEXT,
            description TEXT,
            data JSON
        );
        CREATE INDEX IF NOT EXISTS idx_epg_channel_time ON epg_programs(channel_id, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_epg_cleanup ON epg_programs(end_time); -- For deleting old programs
    `);

    // Sync Status
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_status (
            source_id INTEGER NOT NULL,
            type TEXT NOT NULL, -- 'live', 'vod', 'series', 'epg'
            last_sync INTEGER NOT NULL,
            status TEXT, -- 'success', 'error', 'syncing'
            error TEXT,
            PRIMARY KEY (source_id, type)
        );
    `);

    // User Favorites (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            item_type TEXT NOT NULL, -- 'channel', 'movie', 'series'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, source_id, item_id, item_type)
        );
        CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
        CREATE INDEX IF NOT EXISTS idx_favorites_user_type ON favorites(user_id, item_type);
    `);

    // Watchlist (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS watchlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, source_id, item_id, item_type)
        );
        CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
        CREATE INDEX IF NOT EXISTS idx_watchlist_user_type ON watchlist(user_id, item_type);
    `);

    // Watch History (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS watch_history (
            id TEXT PRIMARY KEY, -- Composite key: user_id:item_id
            user_id INTEGER NOT NULL,
            source_id INTEGER, -- Source ID for Xtream/M3U
            item_type TEXT NOT NULL, -- 'movie', 'episode'
            item_id TEXT NOT NULL, -- The original item ID (stream_id or composite)
            parent_id TEXT, -- For episodes (series ID)
            progress INTEGER DEFAULT 0, -- Current position in seconds
            duration INTEGER DEFAULT 0, -- Total duration in seconds
            updated_at INTEGER NOT NULL, -- Timestamp
            data JSON -- Snapshot of item data (title, poster, etc)
        );
        CREATE INDEX IF NOT EXISTS idx_history_user_updated ON watch_history(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_history_user_item ON watch_history(user_id, item_id);
    `);

    // TMDB metadata, one row per work rather than per catalogue entry.
    // A provider renumbers its stream ids from time to time and
    // purgeStaleItems then drops the playlist_items row; keeping the
    // metadata here means only the link is lost, never the download. The
    // same work also shows up several times (VF/VOSTFR/4K duplicates,
    // several sources) and is served by a single row.
    db.exec(`
        CREATE TABLE IF NOT EXISTS tmdb_titles (
            kind TEXT NOT NULL,            -- 'movie' | 'tv'
            tmdb_id INTEGER NOT NULL,
            title TEXT,
            original_title TEXT,
            year TEXT,
            overview TEXT,
            poster_path TEXT,
            backdrop_path TEXT,
            genres TEXT,                   -- JSON array of names
            runtime INTEGER,               -- minutes; episode runtime for tv
            vote_average REAL,
            status TEXT,                   -- Released | Returning Series | Ended...
            trailer TEXT,                  -- YouTube video id
            data JSON,                     -- full TMDB payload
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY (kind, tmdb_id)
        );
    `);

    // What a catalogue entry resolved to -- including the entries that
    // resolved to nothing. Recording the failures is the whole point: an
    // unmatched title that is not written down here gets searched again on
    // every single pass, forever.
    db.exec(`
        CREATE TABLE IF NOT EXISTS tmdb_links (
            item_id TEXT PRIMARY KEY,      -- playlist_items.id
            kind TEXT,                     -- 'movie' | 'tv', null when unmatched
            tmdb_id INTEGER,               -- null when unmatched
            status TEXT NOT NULL,          -- 'matched' | 'unmatched'
            confidence REAL,
            matched_name TEXT NOT NULL,    -- the catalogue name this attempt used,
                                           -- so a rename can retry immediately
            attempts INTEGER NOT NULL DEFAULT 1,
            last_attempt_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tmdb_links_status
            ON tmdb_links(status, last_attempt_at);
    `);

    // What the provider says about one catalogue entry, beyond what its
    // listing carries. An Xtream movie listing has a name, a poster and a
    // rating; the synopsis, cast, director and runtime live behind a
    // per-item call, which is fetched once and kept here so that displaying
    // a film never has to reach outside the database.
    //
    // Separate from playlist_items because the sync rewrites that table's
    // data column wholesale on every pass.
    db.exec(`
        CREATE TABLE IF NOT EXISTS item_details (
            item_id TEXT PRIMARY KEY,      -- playlist_items.id
            plot TEXT,
            cast_list TEXT,                -- 'cast' is reserved in SQL
            director TEXT,
            genres TEXT,                   -- JSON array of names
            runtime INTEGER,               -- minutes
            year TEXT,
            trailer TEXT,                  -- YouTube video id
            backdrop TEXT,                 -- 16:9 still, the provider's own
            rating REAL,
            -- The provider states the real codecs of every file it serves.
            -- Knowing them before playback starts is what lets the transcode
            -- session be warmed up while the viewer reads the synopsis.
            video_codec TEXT,
            audio_codec TEXT,
            audio_channels INTEGER,
            height INTEGER,
            fetched_at INTEGER NOT NULL
        );
    `);

    // Films prepared for offline viewing. One row per catalogue entry, and
    // the row is what makes the work resumable: a preparation interrupted
    // by a restart leaves a half-written file that would otherwise pass for
    // a finished one.
    db.exec(`
        CREATE TABLE IF NOT EXISTS downloads (
            item_id TEXT PRIMARY KEY,      -- playlist_items.id
            name TEXT,                     -- kept so the list reads even if
                                           -- the provider drops the entry
            status TEXT NOT NULL,          -- queued | running | ready | failed
            path TEXT,
            size INTEGER,
            duration INTEGER,              -- seconds, for the progress figure
            progress REAL DEFAULT 0,       -- 0..1, best effort
            error TEXT,
            requested_at INTEGER NOT NULL,
            ready_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
    `);

    // Migration: trailers, backdrops and precise ratings arrived after the
    // metadata tables did
    for (const [table, column, type] of [['item_details', 'trailer', 'TEXT'],
                                        ['tmdb_titles', 'trailer', 'TEXT'],
                                        ['item_details', 'backdrop', 'TEXT'],
                                        ['item_details', 'rating', 'REAL'],
                                        ['item_details', 'video_codec', 'TEXT'],
                                        ['item_details', 'audio_codec', 'TEXT'],
                                        ['item_details', 'audio_channels', 'INTEGER'],
                                        ['item_details', 'height', 'INTEGER'],
                                        // An episode has no playlist_items
                                        // row, so its download carries
                                        // everything needed to fetch it
                                        ['downloads', 'kind', 'TEXT'],
                                        ['downloads', 'source_id', 'INTEGER'],
                                        ['downloads', 'stream_id', 'TEXT'],
                                        ['downloads', 'container_extension', 'TEXT'],
                                        ['downloads', 'audio_codec', 'TEXT'],
                                        ['downloads', 'estimate', 'INTEGER']]) {
        try {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
            console.log(`[SQLite] Added ${column} column to ${table}`);
        } catch (e) {
            // Column already exists, ignore
        }
    }

    // Migration: Add source_id column if missing (for existing databases)
    try {
        db.exec(`ALTER TABLE watch_history ADD COLUMN source_id INTEGER`);
        console.log('[SQLite] Added source_id column to watch_history');
    } catch (e) {
        // Column already exists, ignore
    }

    console.log('[SQLite] Schema initialized');
}

// ============================================================
// Favorites CRUD Operations
// ============================================================
const favorites = {
    getAll(userId, sourceId = null, itemType = null) {
        const db = getDb();
        let sql = 'SELECT * FROM favorites WHERE user_id = ?';
        const params = [userId];

        if (sourceId) {
            sql += ' AND source_id = ?';
            params.push(sourceId);
        }
        if (itemType) {
            sql += ' AND item_type = ?';
            params.push(itemType);
        }

        sql += ' ORDER BY created_at DESC';
        return db.prepare(sql).all(...params);
    },

    add(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO favorites (user_id, source_id, item_id, item_type)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    remove(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        const stmt = db.prepare(`
            DELETE FROM favorites 
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    isFavorite(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        const row = db.prepare(`
            SELECT 1 FROM favorites 
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `).get(userId, sourceId, itemId, itemType);
        return !!row;
    },

    // Get all favorites for a user, grouped by type (for bulk checks)
    getAllAsSet(userId) {
        const db = getDb();
        const rows = db.prepare('SELECT source_id, item_id, item_type FROM favorites WHERE user_id = ?').all(userId);
        const set = new Set();
        for (const row of rows) {
            set.add(`${row.source_id}:${row.item_id}:${row.item_type}`);
        }
        return set;
    }
};

// ============================================================
// Watchlist CRUD Operations
// ============================================================
const watchlist = {
    getAll(userId, sourceId = null, itemType = null) {
        const db = getDb();
        let sql = 'SELECT * FROM watchlist WHERE user_id = ?';
        const params = [userId];

        if (sourceId) {
            sql += ' AND source_id = ?';
            params.push(sourceId);
        }
        if (itemType) {
            sql += ' AND item_type = ?';
            params.push(itemType);
        }

        sql += ' ORDER BY added_at DESC';
        return db.prepare(sql).all(...params);
    },

    add(userId, sourceId, itemId, itemType = 'movie') {
        const db = getDb();
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO watchlist (user_id, source_id, item_id, item_type)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    remove(userId, sourceId, itemId, itemType = 'movie') {
        const db = getDb();
        const stmt = db.prepare(`
            DELETE FROM watchlist
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    isInWatchlist(userId, sourceId, itemId, itemType = 'movie') {
        const db = getDb();
        const row = db.prepare(`
            SELECT 1 FROM watchlist
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `).get(userId, sourceId, itemId, itemType);
        return !!row;
    },

    getItemsWithData(userId) {
        const db = getDb();
        const rows = db.prepare(`
            SELECT w.source_id, w.item_id, w.item_type, w.added_at,
                   p.name, p.stream_icon, p.rating, p.year, p.data
            FROM watchlist w
            LEFT JOIN playlist_items p
                ON p.source_id = w.source_id AND p.item_id = w.item_id AND p.type = w.item_type
            WHERE w.user_id = ?
            ORDER BY w.added_at DESC
        `).all(userId);

        return rows.map(row => ({
            ...row,
            data: row.data ? JSON.parse(row.data) : null
        }));
    }
};

module.exports = {
    getDb,
    initSchema,
    favorites,
    watchlist
};
