# capitally-tasks

Paseo plugin for Capitally work. Every agent whose git branch, workspace name, or task title
references a Capitally task (`CT-1234`, matched case-insensitively as a whole word) gets a
composer pill showing the task number in uppercase. Pressing the pill opens the task in Notion at
`https://www.notion.so/CT-1234`.

## How it works

- `shared/task.ts` holds the `CT-<number>` pattern, the Notion URL builder, and the RPC contract.
- `server/branch.ts` runs on the daemon and reads the checked-out branch of an agent's directory
  with `git rev-parse --abbrev-ref HEAD`. `index.server.ts` registers its handler.
- `client/pill.tsx` runs in the Paseo app, driven by `index.client.tsx`. It follows the agent and
  workspace update streams, refreshes the branch when an agent finishes a turn, and adds or
  removes the pill per agent.

Sources are checked in this order: branch, agent title, workspace title, workspace name.

## Install

```bash
npm install            # from the monorepo root
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/capitally-tasks
paseo plugin ls        # expect "running"
```

After editing:

```bash
npm run typecheck
paseo plugin reload capitally-tasks
paseo plugin logs capitally-tasks
```
