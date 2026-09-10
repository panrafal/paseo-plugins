# agents-dash-list

Paseo plugin that adds an **Agents dash** entry to the app sidebar, next to "New workspace",
"History" and "Schedules". It lists every workspace on the selected host and the agents inside
it, grouped by what needs your attention.

![Agents dash](./images/agents-dash-list.png)

## Groups

Workspaces are sorted into exactly one group, in this order, and within a group by last activity
(newest first):

| Group | Shown when |
| --- | --- |
| Waiting for you | An agent (or the workspace itself) is waiting for a question or permission to be answered. |
| Unread | An agent finished with new results you have not seen yet, or you marked the workspace unread from the dash. |
| In progress | An agent is currently working. |
| Failing | An agent errored, the pull request has a failing check, or a reviewer requested changes. |
| Approved | The pull request is approved by reviewers and nothing above applies. |
| Idle | Everything is done and read. |
| Merged or closed | The pull request was merged or closed. |

Only non-empty groups are shown. Each group is a bordered section with a bold heading; pressing
the heading folds the group shut or open, and the choice is kept for the rest of the app session.

## Row anatomy

Each workspace is one row:

1. **Main line** — the project icon, the workspace name, the time of last activity, and (for the
   groups that have them) quick-action buttons.
2. **Meta line** — project name, branch, host, and, when the workspace has a pull request: its
   state, checks, and review decision. Workspace labels render last, as the same colored chips
   the built-in sidebar workspace list uses.
3. **Agents line** — a row of small pills, one per agent, each showing a shortened agent name and
   an icon for that agent's own activity (waiting, unread, working, failing, idle). Pills are
   sorted by activity, then by last activity.

Pressing the main line navigates to the workspace's first agent (or the workspace itself when it
has no agents); pressing an agent pill navigates straight to that agent. Pressing the pull request
item on the meta line opens it in the browser instead of navigating.

## Quick actions

Quick actions only appear on the two "calm" groups; every other group is navigate-only:

- **Merged or closed** — Archive.
- **Idle** — Mark as unread, Archive.

Archiving a workspace that has uncommitted changes or unpushed commits asks for confirmation
first, listing what would be left behind.

## Unread marks

"Mark as unread" is a marker owned by this plugin, not by Paseo itself — the built-in sidebar has
no notion of it. The mark clears automatically the moment the workspace is opened from the dash,
or the moment the workspace produces newer activity than the mark (a finished run, a new pull
request check, and so on), whichever comes first. Marks are stored per daemon under
`$PASEO_HOME/plugin-data/agents-dash-list/unread.json` and pruned after 90 days, or when their
workspace no longer exists and the dash was able to list the daemon's whole workspace directory
(a directory too large to enumerate is never treated as a census, so no mark is dropped by
mistake).

## How it works

- The client subscribes to Paseo's workspace and agent directories for the selected host (the
  same `list` + `subscribe` streams the rest of the app uses) and recomputes the grouped model
  locally whenever either stream changes or an unread mark is set or cleared.
- The server side exposes small RPCs the client can't do itself because they need the daemon's
  filesystem: reading the workspace-label color catalog, resolving project icons (custom upload
  or automatic discovery), and reading/writing this plugin's own unread marks — all under
  `$PASEO_HOME` on the daemon machine (resolved the way the daemon resolves it, including a
  leading `~`).
- Project icons in SVG or ICO form only render on web and desktop. React Native cannot decode
  those containers on iOS or Android, and a plugin cannot bring its own SVG renderer, so on
  phones and tablets those projects show the same lettered color square Paseo falls back to.
- Everything is scoped to the host you're currently viewing; switching hosts in Paseo re-seeds the
  dash for the new host.

## Limitations

- The dash only shows a workspace's root agents as pills; subagents running inside their parent's
  workspace contribute to that workspace's activity but do not get their own pill.
- Pull request state, checks, and review decision are only as fresh as what Paseo's daemon has
  already synced from the forge; the plugin does not poll the forge itself.
- Unread marks are local to the daemon that stores them; they do not sync across daemons or
  follow a workspace if it is moved.

## Install

```bash
paseo plugin add panrafal/paseo-plugins:agents-dash-list
```

From a checkout:

```bash
npm install            # from the monorepo root
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/agents-dash-list
paseo plugin ls        # expect "running"
```

After editing:

```bash
npm run typecheck
paseo plugin reload agents-dash-list
paseo plugin logs agents-dash-list
```
