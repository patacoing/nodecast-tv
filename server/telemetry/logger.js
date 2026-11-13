/**
 * Structured logging.
 *
 * The server used to write 233 free-text console lines. They were readable
 * over someone's shoulder and useless for anything else: no severity a
 * machine could filter on, no way to group every line about downloads, and
 * nothing tying a line to the request that produced it. Diagnosing the
 * live-TV failures earlier meant reading `docker compose logs` by eye and
 * grepping for words.
 *
 * Every line is now one JSON object on stdout, which Docker's json-file
 * driver already captures and which Loki or anything else can ingest
 * unchanged whenever it is set up.
 *
 * The call shape is deliberately console's, so the existing calls could be
 * converted without rewriting each one by hand: several arguments are
 * joined the way console joins them. An object passed last is merged into
 * the line as fields rather than stringified, which is how new code should
 * add detail.
 */

const util = require('util');
const { trace, context } = require('@opentelemetry/api');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Anything below this is dropped. Quiet enough for a television in a
// living room, turned up with LOG_LEVEL=debug when something is wrong.
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()]
    ?? LEVELS.info;

// Pretty single lines for a terminal, JSON for anything that collects
// them. Docker runs without a TTY, so a deployed container emits JSON and
// a developer running `npm start` gets something readable.
const asJson = process.env.LOG_FORMAT
    ? process.env.LOG_FORMAT === 'json'
    : !process.stdout.isTTY;

/**
 * "[Downloads] Preparing X" -> component "Downloads", message "Preparing X".
 *
 * The prefix convention was already there in most of the existing lines,
 * and it is the closest thing the server had to a component field. Pulling
 * it out means every line about downloads can be selected without matching
 * on the text of the message.
 */
function splitPrefix(text) {
    const m = /^\[([^\]]{1,40})\]\s*(.*)$/s.exec(text);
    return m ? { component: m[1], message: m[2] } : { component: undefined, message: text };
}

/**
 * The message, formatted the way console would.
 *
 * util.format is what console.log itself uses, so "%s" and friends in the
 * calls that were converted keep working. Errors are reduced to one line
 * here: their stack belongs in the error field, not spliced through the
 * middle of the message.
 */
function formatMessage(parts) {
    const safe = parts.map(p => p instanceof Error ? `${p.name}: ${p.message}` : p);
    return util.format(...safe);
}

/**
 * JSON that cannot throw.
 *
 * This is called from catch blocks. A line that fails to serialise --
 * a circular object among the fields is the usual way -- must still be
 * written, or the logger becomes the thing that replaces the failure it
 * was asked to report.
 */
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        const seen = new WeakSet();
        try {
            return JSON.stringify(value, (k, v) => {
                if (typeof v === 'bigint') return String(v);
                if (v && typeof v === 'object') {
                    if (seen.has(v)) return '[circular]';
                    seen.add(v);
                }
                return v;
            });
        } catch {
            return '{"level":"error","msg":"log line could not be serialised"}';
        }
    }
}

function emit(level, args) {
    if (LEVELS[level] < threshold) return;

    // A trailing plain object carries fields rather than text
    let fields = {};
    const parts = [...args];
    const last = parts[parts.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last)
        && !(last instanceof Error) && Object.getPrototypeOf(last) === Object.prototype) {
        fields = parts.pop();
    }

    // An Error anywhere in the arguments is worth more than its string
    const err = parts.find(p => p instanceof Error);

    const { component, message } = splitPrefix(formatMessage(parts));

    const line = {
        ts: new Date().toISOString(),
        level,
        ...(component ? { component } : {}),
        msg: message,
        ...fields
    };

    if (err) {
        line.error = { name: err.name, message: err.message, stack: err.stack };
    }

    // Tie the line to the request that caused it, so a trace and its logs
    // can be read together once anything collects both.
    const span = trace.getSpan(context.active());
    if (span) {
        const sc = span.spanContext();
        line.trace_id = sc.traceId;
        line.span_id = sc.spanId;
    }

    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    if (asJson) {
        out.write(safeStringify(line) + '\n');
    } else {
        const where = component ? ` [${component}]` : '';
        out.write(`${line.ts} ${level.toUpperCase().padEnd(5)}${where} ${line.msg}`
            + (Object.keys(fields).length ? ' ' + safeStringify(fields) : '')
            + (err ? '\n' + err.stack : '') + '\n');
    }
}

const log = {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a)
};

module.exports = log;
module.exports.splitPrefix = splitPrefix;
module.exports.LEVELS = LEVELS;
