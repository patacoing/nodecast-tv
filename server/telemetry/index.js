/**
 * OpenTelemetry bootstrap.
 *
 * This must be required before express, http or anything that talks to
 * the network: the instrumentations work by patching those modules as
 * they load, and a module already loaded is a module already missed.
 *
 * Nothing here needs a collector to be running. Traces are built either
 * way and simply go nowhere until OTEL_EXPORTER_OTLP_ENDPOINT names
 * somewhere to send them, which costs a span object per request and no
 * network at all. Metrics are exposed for scraping from the start, since
 * the monitoring on this host is VictoriaMetrics pulling Prometheus
 * endpoints and that needs no new infrastructure to be useful.
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. http://tempo:4318 -- turns on
 *                                 exporting of traces, metrics and logs
 *   OTEL_SERVICE_NAME             defaults to nodecast-tv
 *   OTEL_TRACES_SAMPLER_ARG       fraction of requests traced, default 1
 *   METRICS_PORT                  Prometheus endpoint, default 9464
 *   METRICS_ENABLED=false         turns the endpoint off
 */

const pkg = require('../../package.json');

let sdk = null;
let started = false;

function start() {
    if (started) return sdk;
    started = true;

    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
    const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const readers = [];
    let traceExporter;
    let logRecordProcessors;

    if (process.env.METRICS_ENABLED !== 'false') {
        readers.push(new PrometheusExporter({
            port: Number(process.env.METRICS_PORT) || 9464,
            // Its own listener, deliberately: the catalogue is behind
            // authentication and a scraper should not have to hold a
            // token, nor should /metrics sit on the port the television
            // uses.
            host: process.env.METRICS_HOST || '0.0.0.0'
        }));
    }

    if (endpoint) {
        const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
        const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
        const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
        const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
        const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');

        traceExporter = new OTLPTraceExporter();
        readers.push(new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter(),
            exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 60000
        }));
        logRecordProcessors = [new BatchLogRecordProcessor(new OTLPLogExporter())];
    }

    sdk = new NodeSDK({
        serviceName: process.env.OTEL_SERVICE_NAME || 'nodecast-tv',
        traceExporter,
        metricReaders: readers,
        logRecordProcessors,
        instrumentations: [
            new HttpInstrumentation({
                // Scrapes and health checks would otherwise be most of the
                // traffic and none of the interest.
                ignoreIncomingRequestHook: (req) =>
                    /^\/(metrics|healthz)\b/.test(req.url || ''),
                // The provider's segment URLs carry a one-time token and
                // run to three hundred characters; the host is what is
                // worth knowing.
                applyCustomAttributesOnSpan: (span, req) => {
                    const target = req.url || req.path;
                    if (target && target.length > 200) {
                        span.setAttribute('http.target.truncated', true);
                    }
                }
            }),
            new ExpressInstrumentation()
        ]
    });

    sdk.start();

    const stop = () => { sdk.shutdown().catch(() => { }); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);

    return sdk;
}

module.exports = { start, version: pkg.version };
