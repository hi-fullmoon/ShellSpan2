# Native Core performance baseline

The JSON files in this directory record the Rust Core baseline that Node migration waves must compare against. Results are environment-specific; compare implementations on the same machine, operating system, architecture, fixture size, and SSH container.

The baseline captures:

- Core ready handshake latency.
- Core child-process resident memory after initialization.
- Twenty `list_profiles` control-channel round trips.
- Ten local PTY command/output round trips after terminal readiness.
- A 16 MiB local copy through the desktop command boundary.
- A 16 MiB upload and download against the isolated SSH/SFTP fixture.
- Stable wire behaviors and the SQLite v7 schema/data snapshot.

## Capture without SSH

```sh
pnpm native:build
pnpm baseline:native
```

The resulting `remoteTransfer.status` is `not-configured`.

## Capture with the isolated SSH fixture

Start `tests/ssh-e2e/compose.yml`, then run:

```sh
SHELLSPAN_BASELINE_SSH=1 pnpm baseline:native
```

Always stop the Compose project and remove its volumes after capture. The fixture uses only the local loopback ports configured in the Compose file.

## Comparison budgets

Before a Node domain becomes the default, capture Rust and Node results back-to-back and apply these initial budgets:

| Metric                                   | Node budget relative to Rust                                   |
| ---------------------------------------- | -------------------------------------------------------------- |
| Ready latency                            | no more than 15% slower                                        |
| Resident memory                          | no more than 20% higher                                        |
| Control-channel p95                      | no more than 20% or 1 ms slower, whichever allowance is larger |
| Terminal round-trip p95                  | no more than 20% or 5 ms slower, whichever allowance is larger |
| Local copy throughput                    | no more than 15% lower                                         |
| Isolated SFTP upload/download throughput | no more than 15% lower                                         |

APFS and other copy-on-write filesystems may report very high effective local-copy throughput. Treat that metric as a regression detector on the same filesystem, not as physical disk bandwidth.

Any budget change requires a reviewed update to this file with the reason and supporting measurements.
