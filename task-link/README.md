# task-link

Adds a composer pill when an agent's branch, title, or workspace name contains a task ID.
Press the pill to open the configured link. Previously named `capitally-tasks`.

## Settings

Open **Settings → Plugins → task-link → Task link**, or choose **Configure task link** in the
Command Center. Requires a Paseo client with `addSettingsScreen`, `openSettings`, and
`@getpaseo/plugin/client/ui` support. Paseo owns settings navigation, scrolling, mobile layout, and theme.

- **Task regular expression**: a JavaScript pattern without `/` delimiters or flags. Matching is
  case-sensitive; use character classes such as `[Cc][Tt]` to accept either case. For each match,
  the first non-empty capture group, in group order, is the task ID. If there are no capture groups,
  the whole match is used. Matches with only empty/unmatched groups are skipped.
- **Task link**: an HTTP(S) URL containing `{ID}`. Every `{ID}` is replaced with the URL-encoded
  captured text. Case and punctuation in the ID are preserved.
- **Preview**: try a branch or title to inspect the extracted ID and destination before saving.

| Pattern | Input | Task ID |
| --- | --- | --- |
| `\b(CT-\d+)\b` | `feature/CT-1234-fix` | `CT-1234` |
| `(\[CT-\d+\])|-(ct-\d+)` | `Fix [CT-1234]` | `[CT-1234]` |
| `(\[CT-\d+\])|-(ct-\d+)` | `feature-ct-42` | `ct-42` |
| `CT-(\d+)` | `CT-1234` | `1234` |

For example, `https://tracker.example/tasks/{ID}` opens task `CT-1234` at
`https://tracker.example/tasks/CT-1234`. A bracketed ID becomes `%5BCT-1234%5D`.

Defaults match `\b([Cc][Tt]-\d+)\b` and open `https://www.notion.so/{ID}`. Unlike the old plugin,
IDs are no longer forced to uppercase.

Settings use validated plugin RPCs and are saved atomically under
`$PASEO_HOME/plugin-data/task-link/settings.json` (default Paseo home: `~/.paseo`). They are shared
by clients of that daemon and survive plugin reloads. Saving updates this client's pills immediately;
other clients refresh within 15 seconds and also read the latest settings before opening a link.

## How it works

Sources are checked in this order: branch, agent title, workspace title, workspace name.
Within each source, matches are checked from left to right.

- `shared/link.ts` extracts task IDs and builds links; `shared/settings.ts` validates settings.
- `server/branch.ts` reads the checked-out branch with `git rev-parse --abbrev-ref HEAD`.
- `client/pill.tsx` follows agent/workspace updates and refreshes branches after agent turns.
- Pills disappear when no task matches or the agent is archived, and are removed on disconnect
  or plugin reload along with subscriptions and the settings refresh timer.

## Install

```bash
paseo plugin add panrafal/paseo-plugins:task-link
```

From a checkout:

```bash
npm install            # from the monorepo root
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/task-link
paseo plugin ls        # expect "running"
```

When replacing an installed `capitally-tasks`, remove that old installation and install `task-link`
from its renamed directory to avoid duplicate pills. The old plugin had no saved settings.

After editing:

```bash
npm run typecheck
npm test --workspace=task-link
paseo plugin reload task-link
paseo plugin logs task-link
```
