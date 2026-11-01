# keepalive

`targets.json` is the `KEEPALIVE_TARGETS` array the keepalive Worker sweeps on its cron
(`infra/keepalive.tf` passes it through). `worker.mjs` is the vendored Worker; its header documents
the target shape.
