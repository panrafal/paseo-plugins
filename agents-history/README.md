# agents-history

Paseo plugin that adds an **Agents history** entry to the app sidebar. It lists every workspace
the selected daemon has ever had, archived ones included, with the agents that ran in each, and
searches what was said in those conversations by running `grep` over the providers' transcript
files on the daemon host.

Paseo's own History screen searches agent titles and hides archived workspaces; this surface is
for finding the workspace where something was discussed weeks ago.

## What is listed

Every workspace in the daemon's registry, newest activity first, grouped into **Active** and
**Archived** when the archived filter is set to all. Each card carries:

1. **Head** — the workspace title (its name when it has no title), an amber `archived` badge
   when the workspace or its project is archived, and how long ago anything in it last moved.
   Below, each with a small icon: project, branch, worktree name, agent count, and labels. Pressing the head opens
   the workspace; for an archived one Paseo shows its recovery screen and offers to unarchive.
2. **Agent rows** — one per agent, archived ones included: a status glyph (a spinner while
   running), the title, an `archived` badge, the last activity, and under it, each with a small
   icon, provider, model, and last status.
   Pressing a row opens the agent.

Agents whose workspace record no longer exists are grouped under a "Workspace record missing"
card so they stay reachable.

The header sums what is showing: how many workspaces and agents, and, with filters on, out of how
many.

## Search

Typing in the search box does two things:

- **Immediately**, the list narrows to workspaces whose name, title, branch, directory, project,
  labels, or agent titles contain the text.
- **After a short pause** (or on Enter), the daemon runs `grep` over every conversation file of
  the agents that pass the other filters. A workspace whose agent matched is added to the list,
  and under that agent up to three matching lines appear: who said it (`you`, `agent`, `tool`,
  or `meta` for provider bookkeeping), the text around the match, and the match itself in bold.
  "+ N more matching lines" means grep found more than are shown.

The **Regex** toggle treats the text as an extended regular expression (`grep -E`); **Aa** makes
the match case-sensitive. A line under the filters says how many conversations matched across
how many agents, how many agents could not be searched, and whether the search was cut short.
An invalid regular expression is reported there as well.

Message text is ranked above tool input and output, which is ranked above provider bookkeeping
(session metadata, titles); bookkeeping lines are shown only when nothing else matched. Codex
records each message up to three times per turn; duplicates are collapsed.

## Filters

- **Archived** — all, active only, or archived only. A workspace counts as archived when it or
  its project is.
- **Provider** — pick any number of providers, with agent counts; a workspace stays listed when
  at least one of its agents matches, and only those agents are shown.
- **Project** — pick any number of projects, with workspace counts.
- **Label** — pick any number of workspace labels, with workspace counts; a workspace needs at
  least one of them.
- **Period** — last 24 hours, 7, 30, or 90 days, or any time, on the latest activity of the
  workspace or any of its agents.

On a desktop-sized window the dropdowns open as popovers under their trigger; on a phone they
open in Paseo's sheet.

Filter choices are kept while you navigate around the app and reset when the app restarts. The
search text is not kept.

## Where the history comes from

Paseo does not store conversations itself; it replays the provider's own transcript. The plugin
searches those files directly:

| Provider          | File                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Claude Code       | `~/.claude/projects/<encoded cwd>/<session id>.jsonl` plus the subagent files under `<session id>/subagents/` (`CLAUDE_CONFIG_DIR` respected) |
| Codex             | `~/.codex/sessions/<date>/rollout-*-<thread id>.jsonl`, or `~/.codex/archived_sessions/` once the agent is archived (`CODEX_HOME` respected) |
| OMP, Pi           | the session file the daemon recorded as the agent's native handle                                     |
| Cursor, Kilo, Copilot, other ACP providers | nothing on disk; these agents are listed but say "keeps no conversation file to search" during a search |

## How it works

- The plugin SDK lists only live workspaces, so the server entry reads the daemon's own records:
  `$PASEO_HOME/projects/workspaces.json`, `projects.json`, and one JSON file per agent under
  `$PASEO_HOME/agents`. Files are re-parsed only when their size or modification time changes;
  the client re-reads the census every 30 seconds. Agent records also hold provider credentials;
  the server never returns or logs those fields.
- A search is one `grep -n -H -a --null -m 12` invocation (with `-i` unless case-sensitive and
  `-F` unless regex) over every candidate file, spawned without a shell. Its output is parsed as
  a stream: a transcript line can be several megabytes, so lines are cut at 1 MB and the whole
  output at 64 MB. Each hit line is parsed as JSON to find who said what; the match is located
  inside that text and shown with about 120 characters on each side.
- Typing is debounced by 400 ms; a newer search cancels the one still running; at most two run
  at once; a search is cut short after 20 seconds.
- Everything is scoped to the host you are viewing; switching hosts reloads the census.

## Limitations

- Only providers that keep a transcript file on disk are searchable (see the table above).
- Conversation files that have been deleted, or a Claude session directory Paseo cannot map to
  the agent's directory, make that agent "not searchable"; the census still lists it.
- `grep -i` folds case according to the daemon's locale.
- A hit inside a very long line (a large tool result) shows a snippet cut from the first
  megabyte of that line.
- `grep` returns the first hits in file order, and a query that also appears in a record's
  fields (a branch name, a directory, a session id) matches every line of that transcript. Such
  hits are labelled `meta` and shown only when nothing said in the conversation matched, but
  they can use up the per-file quota before a real mention deeper in the file is reached.
- The plugin never archives, unarchives, or deletes anything.

## Install

```bash
npm install            # from the monorepo root
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/agents-history
paseo plugin ls        # expect "running"
```

After editing:

```bash
npm run typecheck
paseo plugin reload agents-history
paseo plugin logs agents-history
```
