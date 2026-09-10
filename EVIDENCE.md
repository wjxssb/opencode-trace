# Targeted audit — 2026-09-09

The redundant cumulative-checkpoint amplification is fixed. Indefinite retention remains an accepted operational boundary. Exact recovery and native execution passed the bounded non-GPU checks below.

**Qwen BEFORE: same-session recovery timed out at 180 seconds. Qwen AFTER: ENVIRONMENT_BLOCKED_XID43. No post-fix Qwen success, speedup or retrieval-quality improvement is claimed.** GLM results are separate observations.

OpenCode V2 beta-19296; baseline 0.1.0 at `049834c`; corrected runtime 0.1.1. Runtime remains independent, with zero dependencies. Raw synthetic sessions, request bodies, native exports and files remain private. The initial BEFORE snapshot contains 28,397 files; every original SHA-256 was rechecked unchanged. Its manifest SHA-256 is `8d47e67c7ad47a308fee456cecd23a843567fb46f664faf465806f533461015f`.

## Final empirical matrix

N/T counts are emitted native/trace tool calls, including the native `execute` dispatcher. Token totals sum requests, not context length. N/M means not measured, not zero. Plugin OFF storage means zero **additional trace** storage; native OpenCode history storage was not measured.

| Case | Result | Cost / notes |
|---|---|---|
| Short native task OFF, Qwen, 3 trials | PASS | N=1/T=0 each; median 9.485 s; mean input 14,178; no compaction |
| Short native task ON, Qwen, 3 trials | PASS | N=1/T=0 each; median 7.329 s; mean input 15,896; input +12.1%; no compaction; no speedup claim from 3 unequal-output trials |
| Cross-session hidden source OFF, Qwen | 0/3 | 62.122 s; N=7/T=0; input/output 64,771/3,819; 1 compaction |
| Cross-session hidden source ON, Qwen | 3/3 | 150.893 s; N=4/T=6 (4 expansions); input/output 132,486/11,267; 3 compactions |
| Same-session post-compact Qwen OFF | 0/3 | 55.469 s; N=5/T=0; input/output 39,755/3,527; no further compaction |
| Same-session post-compact Qwen ON BEFORE | TIMEOUT | 180.071 s; N=0/T=5; input/output recorded 64,971/12,243 plus one request with missing usage; 2 completed + 1 failed compaction |
| Same-session post-compact Qwen AFTER | ENVIRONMENT_BLOCKED | Both ON/OFF HTTP 502; no valid generation; Xid 43 on both GPUs, service failed |
| Same stored Qwen evidence, GLM Flash | 3/3 | Fresh GLM peer, **not** GLM same-session compaction; 72.050 s; N=2/T=5 (3 expansions); native usage below |
| GLM same-session post-compact OFF | 0/3 | 46.646 s; N=4/T=0; input/output 11,586/446; no further compaction |
| GLM same-session post-compact ON | 3/3 | 66.311 s; N=1/T=2 (1 expansion); input/output 40,133/922; no further compaction; +84,651 logical trace bytes |
| Four processes / sixteen synthetic sessions | PASS before and after | 20 first-poll visibility checks, 10 simultaneous-intent rounds, peer pages 8+7; not 16 simultaneous LLMs |
| Source replaced, then recovered by another process | PASS before and after | Exact stored output; SHA-256 verified; foreign-workspace lookup rejected |
| Store ENOTDIR, real GLM native tools | PASS OFF and ON | write/read/edit/read/shell completed; ON trace explicitly returned `ok:false, error:ENOTDIR` |
| Release bundle ENOTDIR repeat | PASS | 49.162 s; N=5/T=1; file actually edited to `RELEASE_NATIVE_OK`; +0 trace bytes |
| 1,000 identical replays | Deduplicated | 7 files, 28,672 allocated file bytes, same as first observation |
| 1,000 distinct calls, same 1 KiB result | 15.7 MiB BEFORE | 16,416,768 allocated file bytes; distinct event identities prevent envelope deduplication |
| 500 distinct 64 KiB results | 70.3 MiB BEFORE | 73,756,672 allocated file bytes for 31.25 MiB logical output; exact envelope plus separate text blobs |
| 1,000 cumulative-message rounds BEFORE | 73.4 MiB | 77,008,896 allocated file bytes |
| Simulated context shortening every 50 rounds BEFORE | 41.9 MiB | 43,937,792 allocated file bytes; synthetic window, not native compaction |
| Same 1,000 cumulative-message rounds AFTER | 43.0 MiB | 45,080,576 allocated file bytes; 2,000 exact message events retained |
| Historical event expansion BEFORE | 19,236 B | Entire 7,568-byte payload plus UTF-8/base64/metadata |
| Historical event default expansion AFTER | 6,682 B | 2,048 source bytes; explicit next offset |
| Historical event metadata-only AFTER | 1,763 B | No source payload; verified hash and exact refs retained |

The later recovery prompt never contained the three random target codes. The file had been replaced; both pre-query native compacted contexts contained zero target codes. The successful Qwen peer expanded the original reader's immutable event. GLM's separate same-session test also verified zero target codes in both compacted contexts before recovery. These are demonstrated benefits on bounded fixtures, not success-rate estimates across arbitrary tasks.

The short-task ON first request carried approximately 1,121 bytes of recall plus additional tool schemas. Different generated reasoning/output lengths confound the observed latency difference. The successful Qwen cross-session retrieval was substantially more expensive than returning unavailable OFF.

## Qwen page diagnosis

The five actual expansion requests in the failed same-session turn were:

| Source | Offset | Effective limit | Total bytes | Next offset | Source bytes returned | Whole result bytes | Exact tuple repeated? |
|---|---:|---:|---:|---:|---:|---:|---|
| Original read event | 0 | 24,000 explicit | 7,568 | null | 7,568 | 19,236 | No |
| Its JSON payload blob | 2,500 | 2,500 | 7,568 | 5,000 | 2,500 | 6,248 | No |
| Same payload blob | 5,068 | 2,500 | 7,568 | null | 2,500 | 6,263 | No |
| Same payload blob | 0 | 2,500 | 7,568 | 2,500 | 2,500 | 6,246 | No |
| Same payload blob | 1,900 | 300 | 7,568 | 2,200 | 300 | 1,069 | No |

All payload pages after the first revisited already returned bytes. The second-to-third request skipped the advertised next offset by 68 bytes. A separate 3,671-byte exact text blob was already present in `metadata.outputs` and `related_refs`; it was not selected. Source and note anchors remained in the system recall in all six requests, including compaction requests. There is no receipt evidence that anchor loss forced this rediscovery.

The failed turn did **not** contain an exact duplicate `(ref, offset, limit)` tuple. The successful cross-session Qwen turn did contain one exact duplicate, and also fetched the same full event with different limits. Full refs, related refs and per-page byte counts for every captured expansion are in [measured-results.json](evidence/measured-results.json).

The 23,838-token input peak belonged to the earlier ON seed/read phase. The timeout turn's maximum **recorded** input was 16,210; one request supplied no usage. It attempted three additional native compactions: two completed and one failed when interrupted. Those are not zero-cost tool-free successes.

Reducing the default from 12,000 to 2,048 bytes alone cannot explain improvement in a turn whose first call explicitly requested 24,000. The fix also offers metadata-only inspection, direct text refs, prominent full-blob hashes/page coordinates and static no-repeat guidance. It performs no semantic summarization, answer search, keyword filtering or source selection. Explicitly requested large pages remain supported. Metadata inspection still reads and verifies the local blob; this reduces model-facing payload, not local I/O volume.

For the AFTER Qwen attempt, official export/import restored the same session IDs, canonical workspace and byte-identical pre-query native context in an isolated host database. Trace events were restored to the original query boundary. Early fixture mistakes (missing entrypoint, import-location default, startup race) are preserved and excluded. The valid fixture's request schemas contained all four trace tools and recall, but every request failed upstream. Kernel records at 21:43:05–06 PDT showed Xid 43 on both GPUs; `qwen27b.service` failed at 21:43:09. No GPU restart or stress followed fault discovery. The cause of the GPU fault was not diagnosed by this plugin audit.

## Storage accounting

Exact measured file bytes for the same 1,000-round cumulative-context workload. Rows above the total are mutually exclusive. Checkpoint/compaction rows below it are subsets and must not be added again.

| Category | BEFORE logical B | BEFORE allocated B | AFTER logical B | AFTER allocated B |
|---|---:|---:|---:|---:|
| Immutable event envelope files | 3,299,687 | 20,480,000 | 3,310,786 | 20,480,000 |
| Event payload blobs | 39,672,256 | 56,496,128 | 6,698,969 | 24,559,616 |
| Separate extracted output blobs | 1,024 | 4,096 | 1,024 | 4,096 |
| Session snapshot | 19,257 | 20,480 | 20,523 | 24,576 |
| Recall snapshot | 3,103 | 4,096 | 4,767 | 8,192 |
| Schema state | 195 | 4,096 | 201 | 4,096 |
| **Total files** | **42,995,522** | **77,008,896** | **10,036,270** | **45,080,576** |
| Checkpoint payload subset | 38,073,470 | Included above | 5,088,183 | Included above |
| Cumulative ID array subset | 35,036,000 | Included above | 0 | Included above |
| Replacement count/digest/tail metadata subset | 0 | Included above | 405,028 | Included above |
| Compaction data in this synthetic workload | 0 | 0 | 0 | 0 |
| File block padding (allocated minus logical) | — | 34,013,374 | — | 35,044,306 |
| Directory allocation, additional | — | 1,691,648 | — | 1,703,936 |
| **Whole workspace including directories** | — | **78,700,544** | — | **46,784,512** |

Inode metadata was not separately measured. Directory allocation above belongs to the frozen snapshot/AFTER directories; file allocation is the consistently measured 73.4/43.0 MiB comparison. Workspace path lengths and filesystem block sizes affect reproducibility of exact byte totals.

The cumulative arrays contributed 35,036,000 bytes, approximately 81.5% of BEFORE logical file bytes. Each round repeated two additional message IDs, giving a sum proportional to 1+2+…+1,000. Count/digest/eight-ID tail removes that growing prefix. Allocated file storage fell 41.5%; logical file bytes fell 76.7%. All 2,000 individual message events remain durable. A 1,000-message test recovers the first exact message after restart; original-source replacement and byte-page/tamper regressions still pass.

The windowed 1,000-round workload measured 43.0 MiB AFTER versus 41.9 MiB BEFORE: extra explicit anchors/lifecycle metadata have a cost even when cumulative IDs were already small. It must not be advertised as a universal space reduction. Distinct same-output calls still use about 15.7 MiB; 500 unique 64 KiB outputs still use about 70.3 MiB. Fifty explicitly large expansion-chain observations measured 9.66 MiB BEFORE; the page limit does not cap complete result JSON size.

History, event identity sets, session counts and startup replay still grow. The 5,000-event long-session restart measured about 490 ms BEFORE and 454 ms AFTER on this machine; this is not a long-term performance guarantee. No automatic retention, quota or minimum-free-space guard exists. On-demand telemetry reports file bytes, event/blob counts and available filesystem space. An administrator must explicitly archive/prune in a future task. A full shared filesystem can affect native OpenCode independently of observer fail-open behavior.

## Final closure regressions

| Finding | Reproduction | Small fix / measured gate |
|---|---|---|
| Multiple compactions out of order | Newest-first C3,C2,C1 selected C1 | Use native `time.created`; oldest-first, newest-first, reordered, duplicate observation and restart all select C3. Legacy payload chronology also recovers. Corrupt legacy payload warns without preventing other recovery. |
| Lost watcher delivery | Closed reader watcher; durable peer event remained unseen | Context/status advance a coalesced cursor, default 64 entries/call. 151 missed events recovered without restart, including an event after cursor wrap. Normal 4-process convergence is a separate test. |
| Hidden observer jobs after timeout | 64 stalled calls all started in baseline | 1,088 submissions start only 8 real jobs; 1,080 are dropped without queueing. Outstanding jobs stay at 8 until released, then return to zero. Linux FD count 23→23; memory samples are in TAP, not claimed as a heap-size bound. Watcher burst also caps pending reads at 16 and reconciles overflow. |
| Adversarial peer intent text | Fake SYSTEM/current-intent/ref and multiline Unicode prose appeared in automatic recall | Automatic peer projection omits prose structurally, retains typed refs/status/paths/resources/timestamps. Test strings never enter recipient recall or current intent; exact original prose remains explicitly expandable. No keyword filter and no model-immunity claim. |
| Declared intent confused with liveness | Owner could disappear while last declaration stayed active | Real host completion shows unknown current liveness; explicit deletion shows host deletion evidence. Declaration remains active in both. No semantic expiration. |

Reconciliation needs future context/status calls; an idle process does not run a polling daemon. A bounded number of permanently stalled filesystem operations can remain alive, and saturated hooks may lose observations. Missing host compact timestamps are labeled `chronology_unknown`; deterministic tie-breaks cannot establish missing chronology.

Local regression: **25/25**, including installer/rollback, exact recovery, tampering, ordering, watcher loss, observer saturation and peer-prose checks. The final release bundle also passed the real GLM ENOTDIR/native-tool smoke. [GitHub Actions](https://github.com/wjxssb/opencode-trace/actions/workflows/test.yml) runs the same suite on Node 20 and Node 22; the delivery receipt records the exact run and head SHA.

## What sessions actually share and plan

Instances in the same canonical workspace publish immutable events into the same content-addressed store. Watch notifications and bounded reconciliation update local projections. A context hook appends bounded recall (default 12 KiB, maximum 16 KiB); full outputs remain outside that automatic block and require explicit expansion. Models save selected notes and source refs, declare intent, inspect peer status, and decide their own next actions. The plugin neither sends autonomous peer instructions nor delegates work.

In the real planning fixture, worker A declared an active path. With an explicit instruction to check peers, worker B chose the alternate file ON and the original file OFF. A forced diagnostic write still completed despite overlap; both sessions saw the advisory. That forced Qwen turn subsequently timed out at 180 seconds, so the file effect and advisory succeeded while the whole model turn failed. This is evidence of advisory influence and native execution transparency, not automatic planning or locking.

Notes are a bounded projection: after one unresolved note and 80 later findings, the old unresolved note disappeared from default status/recall but remained exact by known ref. Missing/malformed native compact maps similarly reduce discoverability without destroying the archive or blocking compaction. In BEFORE, 11 completed compact archives contained one valid map and ten missing-map gaps. Recall is not a complete history index.

## Classifications and verdict

| Finding | Classification |
|---|---|
| Redundant cumulative checkpoint amplification | FIXED |
| Large default expansion/interface cost | FIXED — interface-cost evidence only |
| Host compaction ordering | FIXED |
| Lost watcher notification recovery on future context/status calls | FIXED |
| Unbounded outstanding timed-out hook work | FIXED |
| Automatic inclusion of adversarial peer intent prose | FIXED — structural projection boundary |
| Indefinite history / no quota or free-space guard | ACCEPTED_BOUNDARY |
| Active declaration surviving owner disappearance, with separate factual lifecycle | ACCEPTED_BOUNDARY |
| Finite recall/note windows; absent compact maps; startup growth; drop-on-saturation | ACCEPTED_BOUNDARY |
| Shared canonical-workspace trust; explicit expanded prose remains untrusted | ACCEPTED_BOUNDARY |
| Qwen pre-fix 180-second same-session retrieval timeout | MODEL_SPECIFIC_LIMIT |
| Qwen forced-overlap turn timeout despite completed write/advisory | MODEL_SPECIFIC_LIMIT |
| Qwen post-fix validation after Xid 43 | ENVIRONMENT_BLOCKED |
| Other open non-environment audit defects | UNRESOLVED: none found by these bounded gates |

opencode-trace is a transparent observer, not an authority kernel. It does not block native tools, own workspace mutation, schedule agents, supervise native processes or semantically interpret shell commands. It retains exact host-observed evidence, exposes bounded recall and exact expansion, preserves model-selected notes, assists native compact recovery and provides advisory peer awareness. It promises neither unlimited storage nor strong isolation between sessions sharing the documented workspace trust boundary.

The external GPU failure does not invalidate passing non-GPU plugin criteria. Qwen AFTER remains `ENVIRONMENT_BLOCKED_XID43`; GLM success does not erase that result or the Qwen BEFORE timeout.

## Complete captured live costs

Qwen I/O are proxy prompt/completion tokens; completion includes reasoning and compaction requests. GLM I/O/R/C are native input/output/reasoning/cache-read counters; cached input is reported separately. CLI final-step events can omit a final usage row, so persisted native exports (or exact archived native messages for the deliberately deleted fixture session) supply GLM totals. Do not directly equate the two accounting conventions. Earlier BEFORE GLM and Qwen probe windows overlapped; they are attributed by provider, not by timestamp alone, and those latency samples are not a controlled throughput comparison.

BEFORE storage deltas were not sampled per turn. AFTER deltas are best-effort file snapshots; +0 at ENOTDIR is expected. Manual compact seed stages are separate from recovery-turn compaction counts. All offsets, related refs, duplicate-page checks, request counts and available storage deltas are in the [machine-readable measurements](evidence/measured-results.json).

| Phase / live case | N / T | Input / output | Reasoning / cache-read | Native compactions C/F | Seconds | Logical trace delta B |
|---|---:|---:|---:|---:|---:|---:|
| BEFORE recovery-1-off-seed | 7 / 0 | 74,778 / 4,736 | included / N/M | 1 / 0 | 79.813 | N/M |
| BEFORE recovery-1-on-seed | 2 / 8 | 156,431 / 9,347 | included / N/M | 3 / 0 | 149.443 | N/M |
| BEFORE recovery-1-off-new_peer | 7 / 0 | 64,771 / 3,819 | included / N/M | 1 / 0 | 62.122 | N/M |
| BEFORE recovery-1-on-new_peer | 4 / 6 | 132,486 / 11,267 | included / N/M | 3 / 0 | 150.893 | N/M |
| BEFORE recovery-1-off-same_session_after_compact | 5 / 0 | 39,755 / 3,527 | included / N/M | 0 / 0 | 55.469 | N/M |
| BEFORE recovery-1-on-same_session_after_compact | 0 / 5 | 64,971 / 12,243 + unknown | included / N/M | 2 / 1 | 180.071 | N/M |
| BEFORE probe-0-off | 1 / 0 | 14,158 / 349 | included / N/M | 0 / 0 | 9.485 | N/M |
| BEFORE probe-0-on | 1 / 0 | 15,951 / 170 | included / N/M | 0 / 0 | 8.229 | N/M |
| BEFORE probe-1-on | 1 / 0 | 15,867 / 101 | included / N/M | 0 / 0 | 7.329 | N/M |
| BEFORE probe-1-off | 1 / 0 | 14,006 / 178 | included / N/M | 0 / 0 | 7.178 | N/M |
| BEFORE probe-2-off | 1 / 0 | 14,370 / 558 | included / N/M | 0 / 0 | 12.538 | N/M |
| BEFORE probe-2-on | 1 / 0 | 15,869 / 93 | included / N/M | 0 / 0 | 7.178 | N/M |
| BEFORE planning-off-owner | 0 / 0 | 6,930 / 436 | included / N/M | 0 / 0 | 8.080 | N/M |
| BEFORE planning-off-peer | 4 / 0 | 43,079 / 3,120 | included / N/M | 0 / 0 | 52.915 | N/M |
| BEFORE planning-on-owner | 0 / 1 | 16,247 / 485 | included / N/M | 0 / 0 | 11.385 | N/M |
| BEFORE planning-on-peer | 1 / 2 | 36,950 / 1,533 | included / N/M | 0 / 0 | 28.823 | N/M |
| BEFORE planning-on-forced-overlap | 2 / 3 | 84,466 / 13,054 + unknown | included / N/M | 3 / 0 | 180.064 | N/M |
| BEFORE planning-on-owner-observes | 0 / 1 | 19,602 / 713 | included / N/M | 0 / 0 | 13.137 | N/M |
| BEFORE storage-failure-native | 3 / 1 | 23,913 / 921 | included / N/M | 0 / 0 | 18.199 | N/M |
| BEFORE glm-existing-history | 2 / 5 | 77,485 / 1,265 | 1,379 / 14,144 | 0 / 0 | 72.050 | N/M |
| AFTER recovery-after-on-same_session_after_compact | 0 / 0 | N/M | included / N/M | 0 archived / N/M | 30.466 | N/M |
| AFTER recovery-after-off-same_session_after_compact | 0 / 0 | N/M | included / N/M | 0 archived / N/M | 31.165 | N/M |
| AFTER closure-failure-off | 5 / 0 | 17,316 / 424 | 1,061 / 46,272 | 0 / 0 | 45.592 | 0 |
| AFTER closure-failure-on | 5 / 1 | 19,218 / 420 | 298 / 56,384 | 0 / 0 | 45.042 | 0 |
| AFTER glm-off-seed | 3 / 0 | 24,626 / 117 | 773 / 28,736 | 0 / 0 | 26.461 | 0 |
| AFTER glm-off-same_session_after_compact | 4 / 0 | 11,586 / 446 | 1,139 / 14,848 | 0 / 0 | 46.646 | 0 |
| AFTER glm-on-seed | 3 / 3 | 55,766 / 370 | 3,423 / 29,312 | 0 / 0 | 120.734 | 105314 |
| AFTER glm-on-same_session_after_compact | 1 / 2 | 40,133 / 922 | 1,549 / 4,800 | 0 / 0 | 66.311 | 84651 |
| AFTER closure-lifecycle-declare | 0 / 1 | 17,739 / 34 | 304 / 2,560 | 0 archived / N/M | 17.345 | 26664 |
| AFTER closure-lifecycle-observe-completion | 0 / 1 | 12,541 / 212 | 191 / 5,824 | 0 / 0 | 17.344 | 29374 |
| AFTER closure-lifecycle-observe-deletion | 0 / 1 | 8,582 / 248 | 283 / 12,224 | 0 / 0 | 18.045 | 26844 |
| AFTER glm-release-failopen | 5 / 1 | 18,212 / 404 | 419 / 57,984 | 0 / 0 | 49.162 | 0 |
