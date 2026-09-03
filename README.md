# paseo-plugins

Monorepo of [Paseo](https://paseo.sh) plugins. Each plugin lives in its own top-level directory
and is installed independently.

| Plugin | Description |
| --- | --- |
| [`capitally-tasks`](./capitally-tasks) | Shows a `CT-1234` pill on agents whose branch or task name references a Capitally task, linking to it in Notion. |
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
