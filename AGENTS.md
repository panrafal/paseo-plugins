# Repository instructions

This file is the canonical source of agent guidance for this repository. `CLAUDE.md` imports it;
update rules here only.

## Repository overview

This npm-workspaces monorepo contains trusted local Paseo plugins. Each top-level plugin directory is
independently installable and has its own `paseo-plugin.json`, package metadata, README, TypeScript
configuration, client entrypoint, and optional server entrypoint.

Current plugins:

- `agents-dash-list`: adds an "Agents dash" sidebar surface that lists workspaces and their agents
  grouped by status (waiting, unread, in progress, failing, approved, idle, closed), with quick
  archive and mark-as-unread actions.
- `capitally-tasks`: adds a composer pill for Capitally task IDs and opens the matching Notion page.
- `vscode-open-remote`: adds a remote-editor pill, editor settings, desktop URI handling, and tablet
  `vscode.dev` support. It intentionally hides the pill on phones.

## Runtime boundaries

- `index.client.tsx` and `client/` run inside the Paseo app.
- `index.server.ts` and `server/` run in an unsandboxed subprocess on the Paseo daemon machine.
- `shared/` is imported by both runtimes. Keep it limited to schemas, contracts, types, and plain
  values; do not import Node or React Native runtime APIs there.
- Keep filesystem access, processes, credentials, and machine-local work in server files.
- Use React Native primitives in client UI. Take text and surface colors from the supplied theme and
  account for compact/mobile layouts.
- Gate browser globals and provide native behavior where required. Paseo client code runs on web,
  desktop, iOS, and Android.

Do not run a daemon-side shell command to open an application on the user's computer: for remote
hosts, that command runs on the daemon instead. Paseo's desktop `opener.openUrl` bridge accepts only
HTTP(S) URLs; custom schemes such as `vscode:` and `cursor:` need a client-side protocol handoff.

## Working conventions

- Read the root README and the affected plugin README before changing behavior.
- Follow the current Paseo plugin documentation and the `paseo-plugin` skill when it is available.
- Preserve unrelated and pre-existing work. Do not assume an untracked or modified file is disposable.
- Use npm and keep `package-lock.json` authoritative. Do not introduce another package manager.
- Keep changes scoped to the affected workspace. Update its README when behavior, configuration, or
  installation steps change.
- Do not commit generated output, dependency directories, local settings, credentials, or logs.
- Treat plugin server code as trusted, unsandboxed code. Validate RPC inputs and never log secrets.

## Verification

During iteration, typecheck one plugin:

```bash
npm run typecheck --workspace=<plugin-name>
```

Before finishing, typecheck every workspace:

```bash
npm run typecheck
```

Source edits are not live until the installed runtime is reloaded:

```bash
paseo plugin reload <plugin-id>
paseo plugin ls
paseo plugin logs <plugin-id>
```

Use `--host <target>` for a non-default daemon. Never restart the daemon just to load plugin source;
it may terminate the agent doing the work. If the daemon is unavailable, report that the source and
typecheck are complete but reload verification remains pending.

For UI changes, verify desktop and the relevant compact/mobile form factors, plus light and dark
themes. For composer pills, confirm registration, removal, accessible title, press behavior, and
cleanup on disconnect or plugin reload.
