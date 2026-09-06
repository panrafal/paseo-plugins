# schedule-runs

Paseo plugin that adds a **Schedule runs** entry to the app sidebar, next to "New workspace",
"History" and "Schedules". It is one feed of every run that every schedule on the selected host
has ever produced: which schedule ran, when, whether it succeeded, which workspace and agent it
created, whether those have since been archived, and the agent's final response.

Paseo's own Schedules screen shows the schedules; this surface shows what came out of them.

## What is listed

Every run record of every schedule under the daemon's `$PASEO_HOME/schedules` directory, newest
first. Paseo never prunes run records, so the feed is the full history. The server returns the
newest 500 runs; the header says "oldest not shown" when the daemon holds more.

Schedules that prompt an existing agent (Paseo calls them heartbeats) are hidden by default and
appear when **Show heartbeats** is on. Their runs carry no workspace of their own; the targeted
agent's workspace is shown instead.

## Row anatomy

Each run is one card:

1. **Main line** — the status glyph (a spinner while running, a check or cross afterwards), the
   schedule name, and how long ago the run started. Pressing the line expands the card.
2. **Meta line** — status, elapsed time (still counting while running), the workspace name and
   branch (a link that opens the workspace), the pull request as `#123` when one is known (a
   link that opens it in the browser, colored by its state), the agent title, and an amber badge
   when the agent or the workspace has been archived. "agent gone" or "workspace gone" means the
   daemon no longer lists it at all.
3. **Preview** — the first three lines of the final response, or of the error in red.

Expanding a card shows the full response rendered as Markdown (headings, lists, code, quotes,
emphasis, and links that open in the browser), the error if any, absolute timestamps, the
duration, and the run, schedule, agent, and workspace ids.

The header above the list sums the whole feed: how many runs, how many succeeded, how many
failed, and how many are running. With filters on, it also says how many are showing.

## Filters

- **Search** — every word must appear, case-insensitively, in the response, the error, the
  schedule name, the workspace name or branch, or the agent title.
- **Schedule** — a dropdown listing every schedule with its run count; pick any number. "All"
  clears the selection. Dropdowns open as a popover under their trigger on desktop and as a
  sheet on phones.
- **Status** — a dropdown of running, succeeded, failed with counts; pick any number.
- **Archived** — a dropdown: all runs, hide runs whose agent or workspace was archived, or only
  those.
- **Heartbeats** — a toggle that includes schedules that prompt an existing agent.

Schedule, status, archived and heartbeat choices are kept while you navigate around the app and
reset when the app restarts. The search text is not kept.

## Actions

The workspace name and the pull request on the meta line are links. The rest sit at the bottom
of an expanded card:

- **Open #123** — opens the pull request in the browser, when one is known.
- **Open agent** and **Open workspace** — navigate to the target. They work for archived targets
  too: Paseo lands on its recovery screen and offers to unarchive. They disappear only when the
  daemon no longer lists the target at all.
- **Load from transcript** — offered when the run recorded no response (a run still going, or an
  older or failed run). It reads the agent's last message straight from its transcript. For an
  archived agent the daemon reopens the session in history mode to answer, which costs a provider
  session, so this is never done for the list, only on request. The result is kept for the rest
  of the app session.

## How it works

- The plugin SDK exposes no schedules API, so the server entry reads the daemon's own records:
  one JSON file per schedule under `$PASEO_HOME/schedules` (each run record carries the
  agent's final message as `output`), and the workspace registry at
  `$PASEO_HOME/projects/workspaces.json`, which is the only place archived workspaces are still
  listed with their name, branch and `archivedAt`. `PASEO_HOME` is resolved the way the daemon
  resolves it, including a leading `~`.
- Agents, archived ones included, come from the SDK's agent directory and are joined to runs by
  agent id, falling back to the `paseo.schedule-run` label the daemon stamps on every agent a
  schedule creates.
- The pull request comes from the SDK's workspace directory while the workspace is open (with
  its live state), from the registry's auto-archive record once it was archived on merge, and
  failing both, from the first pull request URL the agent linked in its response (state unknown).
- Files are re-parsed only when their size or modification time changes; the agent and workspace
  directories are re-listed at most every 10 seconds. The client polls every 15 seconds and filters locally.
- Each run's response is cut at 50,000 characters; the expanded view says so when that happened.
- Everything is scoped to the host you are viewing; switching hosts reloads the feed.

## Limitations

- A pull request opened by the agent after Paseo archived the workspace is only found if the
  response links to it.
- The Markdown renderer covers common agent output; tables and raw HTML are shown as monospace
  text rather than laid out.
- The feed is polled, not streamed. A run that just started shows up within 15 seconds.
- Runs whose schedule file is unreadable are skipped with a warning in the plugin logs.
- The plugin never changes schedules; use Paseo's Schedules screen to pause, edit, or run one.

## Install

```bash
npm install            # from the monorepo root
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/schedule-runs
paseo plugin ls        # expect "running"
```

After editing:

```bash
npm run typecheck
paseo plugin reload schedule-runs
paseo plugin logs schedule-runs
```
