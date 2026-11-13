/**
 * A small wrapper for the spans this application adds itself.
 *
 * The HTTP and express instrumentations already produce a span per
 * request. What they cannot show is why a request took the time it did,
 * which here is almost always one of four things: a call to the provider,
 * an ffmpeg run, a TMDB lookup, or a catalogue sync. Those get a span of
 * their own so a slow request names its own cause.
 */

const { trace, context, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('nodecast-tv', require('../../package.json').version);

/**
 * Run `fn` inside a span, recording a thrown error on it.
 *
 * @param {string} name        e.g. 'provider.playlist'
 * @param {object} attributes  set on the span before fn runs
 * @param {function} fn        receives the span, so it can add more
 */
async function span(name, attributes, fn) {
    return tracer.startActiveSpan(name, { attributes }, async (s) => {
        try {
            return await fn(s);
        } catch (err) {
            s.recordException(err);
            s.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            throw err;
        } finally {
            s.end();
        }
    });
}

/** The same, for code that is not async. */
function spanSync(name, attributes, fn) {
    return tracer.startActiveSpan(name, { attributes }, (s) => {
        try {
            return fn(s);
        } catch (err) {
            s.recordException(err);
            s.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            throw err;
        } finally {
            s.end();
        }
    });
}

/** The span covering whatever is running now, for adding an attribute. */
function current() {
    return trace.getSpan(context.active());
}

module.exports = { tracer, span, spanSync, current, SpanStatusCode };
