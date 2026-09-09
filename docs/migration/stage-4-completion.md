# Stage 4 completion record

Date: 2026-09-09

Scope: SSH, host trust, remote and local terminals, SFTP, remote health, and port forwarding.
LLM and Agent Runtime remain Rust-owned; Stage 5 work is intentionally absent.

## Ownership decision

The complete `host-trust`, `terminal`, `remote-fs`, `remote-health`, and `port-forward` domains now
default to Node: 40 commands total. Together with Stages 2 and 3, 84 commands across eleven
domains are Node-owned by default. All five Stage 4 domains must be switched together, and a Node
connection stack requires Node credentials. The same whole-domain routes provide rollback to Rust;
no SSH session, SFTP pool, terminal, or forwarding operation is split between backends.

## Deliverables

| Requirement              | Evidence                                                                                                                                                                                                                                                                                        | Status   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Host trust and preflight | `host-trust.ts` supports exact and OpenSSH hashed entries, atomic trust/removal, fingerprints, mismatch detection, and trustable first-use results. `preflight.ts` records DNS, TCP, jump-key, jump-auth, tunnel, target-key, and target-auth steps.                                            | complete |
| Credential ordering      | `ssh.ts` uses asynchronous `hostVerifier` callbacks before SSH authentication; direct and jump target credentials cannot be transmitted until the corresponding known-host entry matches.                                                                                                       | complete |
| SSH terminal             | `terminal.ts` implements password/key/passphrase/keyboard-interactive connections, jump tunnels, xterm PTYs, resize, gated startup output, pause/resume, UTF-8 decoding, status, close, and reconnect-by-new-session behavior.                                                                  | complete |
| Local terminal           | `node-pty` supplies Unix PTY and Windows ConPTY behavior. A separate guardian kills the terminal process tree if Node Core exits abnormally; normal close also terminates the entire Unix process group.                                                                                        | complete |
| SFTP                     | `remote-fs.ts` owns the reusable SFTP pool, superseded directory requests, create/rename/chmod/delete, bounded previews, open-file copies, owner lookup, recursive upload/download, same/cross-host copy, conflict policies, staged files, progress, and type-specific cancellation registries. | complete |
| Port forwarding          | `port-forward.ts` implements loopback local and remote forwarding, connection isolation, byte counters, lifecycle events, duplicate protection, and deterministic socket/listener cleanup.                                                                                                      | complete |
| Remote health            | `remote-health.ts` uses fixed, read-only Linux and macOS command sets, bounded output, one-second CPU sampling, auditable source metadata, authorization, timeout, unsupported-platform, failure, and cancellation outcomes.                                                                    | complete |
| Packaging                | `ssh2` uses its pure-JavaScript fallback; unnecessary `cpu-features` is excluded. `node-pty` and Keychain bindings are rebuilt for Electron, while the Unix spawn helper is made executable before packaging.                                                                                   | complete |
| Public compatibility     | Contract Schema v1, Renderer, and Preload sources are unchanged. The original 141-command bridge and sequenced terminal/ACK channel remain the only public desktop boundary.                                                                                                                    | complete |

## Security and failure evidence

- An untrusted-host preflight uses a deliberately invalid password yet returns `attention` with
  authentication blocked. Trust requires the exact presented fingerprint, changed keys report
  `mismatch`, and both jump and target keys are verified before their credentials are used.
- Direct, jump-host, wrong-credential, key-change, remote-shell, and disconnect paths run against
  isolated OpenSSH containers. All diagnostics remain behind the existing recursive redaction
  boundary; pool keys contain only SHA-256 digests.
- Transfer files are staged beside their destination and removed on error or cancellation.
  `overwrite`, `replace`, `skip`, and `fail` preserve file-kind checks, recursive operations check
  cancellation between entries, and stream pipelines abort active file I/O.
- The isolation smoke transfers a 64-entry directory, runs three concurrent 2 MiB uploads, cancels
  a 32 MiB upload, and verifies that no `.shellspan-*` temporary file remains.
- A local PTY test starts a background child and proves ordinary session close kills it. A separate
  fault test sends `SIGKILL` to Node Core and proves the external guardian still removes the child
  process tree.
- The existing dedicated terminal pipe continues to enforce UTF-8 framing, sequence continuity,
  Renderer ACK credits, reload credit reset, bounded writes, and hard shutdown deadlines.

## Platform and packaging evidence

- macOS arm64 development and packaged Electron runs start the real local terminal through the
  unchanged UI. The packaged `pty.node` is rebuilt for Electron 44, lives outside ASAR, and its
  adjacent `spawn-helper` is executable.
- Windows uses node-pty's ConPTY path on supported Windows builds and the guardian uses
  `taskkill.exe /T /F` only after its Node Core owner disappears. The `windows-2025` quality job now
  runs `pnpm test:desktop`, so ConPTY input/output, resize, ordinary tree cleanup, Electron ABI, and
  all platform-neutral connection tests are mandatory before merge. This macOS workstation cannot
  truthfully record that external Windows run; its result remains a required CI acceptance signal.
- Ubuntu's isolated job now runs both the Rust baseline and the Node Stage 4 smoke against separate
  target and jump containers, including local and remote forwarding and Linux remote health.

## Verification record

- `pnpm test:desktop`: 65 tests passed.
- `pnpm test`: 1,319 tests passed and 1 test was skipped.
- `pnpm test:native`: 682 tests passed and 27 environment-gated tests were ignored.
- `pnpm test:e2e:ssh`: 10 Rust isolated tests plus the Node Stage 4 acceptance smoke passed.
- `pnpm test:desktop:smoke`: native lifecycle, Stages 1–3 differential checks, Node default routing,
  original UI terminal/SFTP navigation, and Electron shutdown passed.
- `pnpm electron:pack` and `node scripts/electron-smoke.ts --packaged`: macOS arm64 ASAR, Electron
  ABI, real local terminal, storage/credentials, and original Renderer/Preload bridge passed. Local
  signing was unavailable and intentionally skipped.
- `pnpm lint`, `pnpm format:check`, `pnpm contract:check`, and `git diff --check`: passed.

## Exit decision

Stage 4 implementation and every test executable on this macOS/Ubuntu-Docker environment pass.
The Windows implementation is covered by the repository's mandatory `windows-2025` desktop gate;
that external run must be green before this stage is merged or released. Stage 5 is not present.
