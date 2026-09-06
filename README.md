# paseo-plugins

Monorepo of [Paseo](https://paseo.sh) plugins. Each plugin lives in its own top-level directory
and is installed independently.

| Plugin | Description |
| --- | --- |
| [`agents-dash-list`](./agents-dash-list) | Adds an "Agents dash" sidebar entry that lists workspaces and their agents grouped by status (waiting, unread, in progress, failing, approved, idle, closed), with quick archive and mark-as-unread actions. |
| [`agent-heartbeats`](./agent-heartbeats) | Adds a compact per-agent heartbeat count and a panel for creating, reviewing, editing, and deleting heartbeats. |
| [`agents-history`](./agents-history) | Adds an "Agents history" sidebar surface listing every workspace and agent, archived ones included, with filters and a grep search over on-disk conversation transcripts that shows matching lines under each agent. |
| [`capitally-tasks`](./capitally-tasks) | Shows a `CT-1234` pill on agents whose branch or task name references a Capitally task, linking to it in Notion. |
| [`chat-resume`](./chat-resume) | Resumes quota-exhausted agents after allowance renewal or prepares a handover to the next ready provider. |
| [`vscode-open-remote`](./vscode-open-remote) | Opens a remote agent's current directory in VS Code, Cursor, a custom editor, or vscode.dev on mobile. |

## Development

```bash
npm install          # installs typecheck dependencies for every plugin
npm run typecheck    # typechecks every plugin
```

## Installing a plugin

From a checkout on the daemon machine:

```bash
paseo plugin install /absolute/path/to/paseo-plugins/<plugin>
```

Or straight from Git:

```bash
paseo plugin add <owner>/paseo-plugins:<plugin>
```

After editing a plugin, run `npm run typecheck` and `paseo plugin reload <plugin>`.
