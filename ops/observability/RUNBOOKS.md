# Effect Domains observability runbooks

Telemetry is best effort. Preserve application availability while investigating; durable business and security evidence lives in application audit tables, not OTLP.

## Server errors

Filter `rpc.server.call.duration` by `rpc.method` and `error.type`, open a representative Tempo trace, then follow its correlated Loki logs. Never add payloads or identifiers to automatic attributes to debug an incident.

## Server latency

Compare RPC and HTTP p95/p99 with `child_fibers_active`. Inspect slow traces and downstream spans. Confirm collector health before treating absent data as healthy latency.

## Browser failures

Filter `rpc.client.call.duration` by browser service and method. Compare browser spans with their propagated server trace. Browser unload delivery is best effort, so corroborate with server measurements.

## Missing worker

Check the Report Exports worker process, Collector health at port 13133, and Collector queue metrics. Restart the worker gracefully when possible so in-process telemetry flushes.

## Collector export failures

Inspect `otelcol_exporter_send_failed_*`, queue size, backend reachability, TLS, and upstream authentication. The disk queue is durable only after the Collector accepts telemetry.

## Collector dropped data

Treat `otelcol_exporter_enqueue_failed_*` as telemetry loss. Restore backend capacity, preserve the queue volume, and increase queue capacity only after measuring the sustained ingestion and drain rates.
