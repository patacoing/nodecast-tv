# Telemetry

The server emits structured logs, Prometheus metrics and OpenTelemetry
traces. Nothing has to be collecting for the application to run: metrics
are exposed for scraping, logs go to stdout, and traces are built and
discarded until a collector is named.

## Logs

Every line is one JSON object on stdout, captured by Docker's `json-file`
driver as it already was.

```json
{"ts":"2026-11-13T10:38:38.078Z","level":"error","component":"Proxy",
 "msg":"Upstream error ... 404 Not Found",
 "trace_id":"815d3dead7687e77aeb6fbf1a92ebba1","span_id":"5ab330bee633f991"}
```

`component` comes from the `[Prefix]` the lines already carried, so every
line about one subsystem can be selected without matching on message text.
`trace_id` and `span_id` are present whenever the line was written while
serving a request, which is what lets a trace and its logs be read side by
side.

| Variable | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | JSON when not a TTY | `json` or `text` |

In code, prefer passing fields rather than interpolating them:

```js
log.warn('[HLS] playlist refused', { status: 403, channel: name });
```

## Metrics

A Prometheus endpoint on port **9464**, published on the Tailscale address.
It carries counters only -- nothing about the catalogue's contents -- so it
needs no authentication and a scraper needs no token.

```
nodecast_upstream_requests_total{kind,host,outcome,status}
nodecast_upstream_duration_seconds{kind,host,outcome}
nodecast_transcode_sessions_active
nodecast_transcode_starts_total{video_mode,encoder}
nodecast_probe_results_total{video,audio,compatible}
nodecast_downloads_started_total{kind}
nodecast_downloads_finished_total{kind,outcome}
nodecast_download_bytes{kind}
nodecast_sync_runs_total{source_type,outcome}
nodecast_sync_duration_seconds{source_type,outcome}
nodecast_tmdb_requests_total{outcome,status}
nodecast_catalogue_items{type}
nodecast_downloads_held{status}
nodecast_downloads_bytes_held
```

`outcome` on upstream requests is split three ways deliberately, because
the three want different answers:

- `refused` -- the provider answered 4xx. It is saying no.
- `broken` -- the provider answered 5xx. It is failing.
- `unreachable` -- no answer at all. The network between us is the problem,
  and relaying through the server can fix it.

Every live-TV failure diagnosed by hand over several weeks is one of these
lines: bursts of `refused` with status 403, `unreachable` when a domain
lost its A record, `probe_results` with `audio="none"` for a feed that
dropped its audio track.

### Scraping it

Add to `scrape.yml` on the monitoring host:

```yaml
  - job_name: nodecast-tv
    static_configs:
      - targets: ["100.81.187.102:9464"]
        labels: { host: vps }
```

VictoriaMetrics reads Prometheus format directly; no collector is needed.

## Traces

Spans are created for every HTTP request (by the http and express
instrumentations) and for the four things that actually take the time:

- `provider.api` -- an Xtream API call, labelled with the action
- `provider.fetch` -- a playlist or segment through the proxy
- `tmdb.request` -- a metadata lookup
- a sync's own span

They go nowhere until `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector:

```yaml
- OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318
```

Setting it also exports metrics and logs over OTLP, alongside the
Prometheus endpoint. Grafana needs a Tempo datasource to query the traces;
there is none on this host today, which is why the default is unset.

## Where the bootstrap lives

`server/telemetry/index.js`, required as the **first** line of
`server/index.js`. The instrumentations patch `http` and `express` as those
load, so anything required before them is never instrumented. That line has
to stay where it is.
