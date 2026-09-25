# trace_find: CJK recall fix (derived index schema 4)

## Defects (measured on the production index, 103,492 events, 11,841 containing CJK)

1. **FTS5 tokenization.** The default `unicode61` tokenizer keeps a run of CJK characters as ONE token.
   - A two-character word inside a longer run ("清理" inside "…残留单元已清理") never matched.
   - `trigram` does not help: it needs ≥ 3 characters, and most Chinese words have 2.
2. **The FTS fallback in `trace.find` was dead for text queries.** Every FTS candidate was re-checked with `matchesFilters(entry, f)`, which includes the whole-query hint substring test. So the fallback could never add a result the hint path had missed.
3. **No ranking.** Candidates came back as `SELECT DISTINCT … LIMIT`.

## Fix (minimal)

- **Indexed text:** the original text (Latin tokens unchanged), plus each CJK run's character bigrams (`expandCjk`).
- **Query:** each whitespace word must match (implicit AND). CJK parts become adjacent-bigram phrases, so the order matters and there are no bag-of-characters hits. Other parts become plain phrases (`ftsQuery`).
- **Ranking:** `ORDER BY rank` (FTS5 bm25).
- **FTS fallback:** all filters except the text one are applied to FTS candidates; the FTS match is the text criterion.
- **Snippet:** the whole query first, else the longest query word.
- **Schema:** `SCHEMA_VERSION` 3 → 4. The disposable index rebuilds itself; CAS stays authoritative.

## Measurement (copy of the production index, read-only)

"Truth" is the set of events in which every query word occurs as a substring.

| query | truth | hint-substring path | old FTS | new FTS (all ⊆ truth) |
|---|---|---|---|---|
| 清理 | 215 | 215 | 14 | 215 |
| 模型请求 | 5 | 5 | 0 | 5 |
| 上下文压缩 | 6 | 6 | 1 | 6 |
| 上下文 压缩 | 9 | 0 | 0 | 9 |
| 清理 残留 | 51 | 0 | 0 | 51 |
| 文档 插件 | 11 | 0 | 2 | 11 |
| runParseJob | 47 | 47 | 47 | 47 |
| ENOENT | 81 | 81 | 81 | 81 |

- **End to end, before:** multi-word Chinese queries recalled 0 events. The hint path needs a contiguous substring, and the fallback was filtered away (defect 2).
- **After:** 100% recall, with no hits outside the truth set.
- **Cost:** query top-20 ranked takes 0.1–0.2 ms; rebuilding 103,492 rows takes 0.7 s (one-time, on the schema bump).

## Known limits

- Single CJK characters are not indexed. A one-character query still works through the hint substring path.
- Only the hint text is indexed, as before (≤ 4000 characters per event). Exact payload bytes stay behind `deep: true`.
