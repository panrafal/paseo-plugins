# session-usage

Adds **Session usage** to Paseo's sidebar and Command Center. It reads Claude Code and Codex
transcripts on the selected daemon, including archived sessions, subagents, and sessions started
outside Paseo, then joins them with Paseo's project, workspace, and agent records.

## Using the surface

- The **sortable table** defaults to one row per provider session. Choose **Columns** to show any
  measurement, press a heading to sort in either direction, and press a session name for all
  measurements, its tool-call breakdown, and a link to its agent or workspace. Missing values
  sort last in both directions. The session column stays fixed while the other columns scroll
  horizontally, on desktop and mobile. The table pages through 40 rows at a time.
- **Table grouping** independently switches between Sessions, provider, project, workspace,
  label, model, effort, day, week, and month. It preserves the selected metric columns and does
  not change Compare providers or the calendar. Group rows show metric totals, weighted
  percentages, session counts, and coverage for partially known measurements. Click a group
  for all metrics and its member sessions; session details show that member's activity in the group.
  Sessions with multiple labels appear once in each label group, so label totals can overlap.
  Unlabeled sessions get their own group. Date/model/effort groups split recorded activity;
  session span and transcript size remain unknown there because they cannot be divided across
  those groups. Other groupings sum those lifetime values once per member within each group.
  Numeric cell backgrounds scale independently per metric across all filtered table rows,
  including other pages. Zero and unknown values have no tint.
- **Effort**, beside Models, shows the recorded levels for the selected activity (for example,
  `low` or `xhigh`). A session that changed effort lists each level; sorting uses its highest
  recorded level. Details and CSV include effort too. An em dash means effort was not recorded;
  provider defaults and current agent settings are not inferred for historical usage.
- **Compare providers** shows Claude and Codex bars on the same zero-based scale. Choose a
  metric, total or average per known session, and group by provider, day, week, month, project,
  or model. Weeks start on Monday. Large charts initially show 14 groups; **Show more** reveals
  the rest. Time charts initially show the latest groups.
- **Daily activity**, below the bars, shows a GitHub-style calendar for the last 12 months on
  desktop or one month on compact/narrow screens. Previous/next controls browse older periods.
  It uses the bars' selected metric and total/average setting, combining the selected providers.
  Each day's color is normalized against the highest value across the visible calendar.
  Selecting a day filters the cards, bars, table, details and CSV to that UTC day; selecting the
  same day again clears the date filter. The calendar
  ignores date filters so its days and color scale stay visible; all other filters still apply.
  **Clear date filter** restores the report's full date range. Empty days remain selectable;
  future days are disabled. Hover or focus a day to see its value and measurement coverage.
  Dashed cells mark unknown measurements. Lifetime session span and file size leave the calendar
  uncolored because those measurements cannot be attributed to individual days.
- Filters include provider, project, workspace, label, model, active/archived state, source
  (Paseo linked/outside Paseo), main/subagent, data availability, and UTC calendar dates.
  Search matches session metadata, titles, directories, branches, labels, models, and effort.
  Filter, column, table grouping, and sort choices survive navigation per host until the app restarts.
- **Export CSV** exports every filtered row in the current sort order, with all measurements
  as raw numbers (durations in milliseconds, ratios from 0 to 1, USD, bytes). On native clients
  it uses the platform share sheet. Spreadsheet formulas in text fields are neutralized.
  When the table is grouped, the export contains grouped totals and per-metric known-session counts.
- **Refresh** scans for new or changed files. The surface also refreshes every 30 seconds and
  polls scan progress every two seconds. A previous completed snapshot stays visible during
  refresh; data from a different host is never used as a placeholder.

## Measurements

| Category | Measurements |
| --- | --- |
| Tokens | Total input, uncached input, cache reads, cache writes, Claude 1-hour cache writes, output, reported reasoning/thinking, total input + output, weighted cache hit percentage |
| Calls and messages | Model responses, user messages, assistant messages, model tool calls, explicit tool errors, tool error percentage, named tool-call counts |
| Executions | Codex completed command, MCP, file-change and search events, and their explicit failures, including operations inside an `exec` call |
| Length and time | User/assistant/tool input/tool output character counts, first/last timestamps, lifetime session span, recorded completed/aborted turn time, transcript bytes, compactions |
| Cost | Explicitly reported USD where present; standard short-context API token cost estimate for known models |

**Token categories are normalized.** Claude's base input excludes cache reads/writes, so those
categories are added to produce total input. Codex's input already includes them, so they are
subtracted to obtain uncached input. Cache writes include the 1-hour subset. Reasoning is a subset
of output and is never added a second time to total tokens. Character counts use Unicode code
points, exclude images, and are not estimates of token counts.

**Dates filter activity, not session creation.** A session spanning several days contributes only
the daily/model/effort buckets selected. Date presets include today and the preceding 6, 29, or 89 UTC
calendar days. Unknown-date buckets appear only without date bounds. Recorded turn duration is
attributed to the completion day. Session span and transcript size always cover the entire file;
those two metrics can be charted only by provider or project. Model filters omit activity that
cannot be attributed to the selected model, such as initial prompts before a model is recorded.

**Unknown is different from zero.** An em dash means a measurement is absent. Cards and bars
show the number of sessions with that measurement. Aggregates are known subtotals, and averages
divide by known sessions. Cache/error percentages use the ratio of sums for sessions with both
values. A partially readable session can contribute known values; its badge and details explain
the missing coverage. Token totals cannot recover deleted requests or unrecorded usage.

## Cost estimates

The **Base API estimate** uses a fixed price table checked on **2026-09-07** against
[OpenAI pricing](https://developers.openai.com/api/docs/pricing) and
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Each usage record is priced using its recorded model, including separate read/write rates and
Claude's reported 1-hour cache-write rate. Without a recorded cache TTL, writes use the 5-minute
rate. Supported families are listed explicitly in `shared/pricing.ts`; unknown/private models
(including `codex-auto-review`) remain unpriced. Dated model IDs use the corresponding base model
rate. Historical usage is valued at this price snapshot, not historical prices.

This is a **standard, short-context API equivalent**, not a bill or subscription allowance meter.
It excludes priority/fast processing, long-context and regional premiums, tool fees, negotiated
discounts, tax, and plan charges. It does not infer what you paid for Claude Pro/Max or ChatGPT.
**Reported cost** is separate and usually unknown because native transcripts rarely contain
the SDK's `result.total_cost_usd` events. No pricing or provider account API is contacted at runtime.

## Data sources and accounting

| Source | Location |
| --- | --- |
| Claude | `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`, default `~/.claude/projects`, including nested `subagents` files |
| Codex | `$CODEX_HOME/sessions/**/rollout-*.jsonl` and `$CODEX_HOME/archived_sessions/**/rollout-*.jsonl`, default `~/.codex` |
| Paseo | `$PASEO_HOME/projects/{projects,workspaces}.json` and `$PASEO_HOME/agents/*/*.json`, default `~/.paseo` |

- No transcript, registry, configuration, or provider state is changed. Only metadata, numeric
  statistics, tool names and coverage notices are sent to the client. Message text, tool arguments,
  tool results, and provider credentials never leave the parser. Session titles are metadata.
- A provider session referenced by several Paseo agents is counted once; an active agent record
  wins over an archived one. Duplicate active/archive Codex files use the largest copy, then the
  newest on a tie. Claude subagent files are separate rows linked to their parent's workspace.
  Codex subagent metadata identifies child/review sessions, even without a recorded parent ID.
- Project matching uses the recorded workspace first, then directory matches and the most specific
  project root. Active/archived state includes the agent, workspace, project, or Codex archive
  directory. “Active” means not archived; it does not mean currently running. Untracked Claude
  sessions have no provider archive flag and are considered active.
- Missing transcripts stay listed when Paseo still has an agent record. If both the transcript
  and registry record were deleted, there is nothing to recover. A missing environment directory
  is empty; inaccessible or malformed metadata produces a visible scan warning.
- Claude usage snapshots are merged per assistant message ID, using the highest reported value
  per token category to handle repeated content blocks/final updates. Tool calls use call IDs.
- Effort comes from Claude assistant records and Codex turn contexts or applied thread settings.
  Changes split activity buckets without changing token totals. Missing effort stays unknown.
- Modern Codex `token_usage_record` entries are deduplicated by response ID and are authoritative
  once present. Their lifetime counters differ from legacy `token_count` counters after compaction;
  the two counter streams are never summed. Earlier legacy-only sections use positive cumulative
  differences, with repeated totals ignored and resets counted as separate segments and flagged.
  Legacy response counts mean observed nonzero increments, not necessarily individual API calls.
  Explicit token records belonging to another thread are excluded.
- Codex canonical `response_item` messages take precedence over mirrored `event_msg` messages.
  Model tool calls and completed execution events are separate metrics: one model `exec` call
  can run several commands. Error detection uses explicit flags/status/exit codes, not a search
  for the word “error”. Calls with unstructured or missing outcomes may have unobserved errors.
- Recorded user messages may include injected instructions, automated prompts and compaction
  context. Copied conversation context without stable identities may affect message/character
  counts. These are transcript statistics, not a count of human keystrokes.
- Four file streams run at once. Parsed results are cached by path, size and modification time
  in memory; only changed files are reparsed. Each JSONL line is capped at 16 MiB. Oversized,
  malformed, and unfinished lines are skipped with a partial-data notice. Scan errors retain the
  previous snapshot. Plugin cleanup aborts active streams and clears the cache.

## Development and installation

From the monorepo root (Node 22.7+ for the test runner):

```bash
paseo plugin add panrafal/paseo-plugins:session-usage
```

From a checkout:

```bash
npm install
npm test --workspace=session-usage
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/session-usage
paseo plugin ls
paseo plugin logs session-usage
```

After editing, typecheck and run `paseo plugin reload session-usage`. Use `--host <target>` for
another daemon. The plugin registers a sidebar surface and a global Command Center action;
both registrations and the server index are removed on plugin cleanup.

The UI uses React Native primitives and theme colors. Filters use anchored popovers on desktop
and Paseo sheets on compact clients; the statistics table remains horizontally scrollable.

Regression tests cover provider accounting, duplicate events, compaction counters, child metadata,
malformed/oversized records, active/archive copies, missing files, metadata joins, changed-file
refresh, credential/content exclusion, date/model filters, weighted aggregation, chart totals,
effort changes and missing levels, calendar date selection and normalization, leap-year/month
boundaries, calendar deselection, table group accounting, overlapping labels, sorting, and CSV escaping.
