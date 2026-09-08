# agent-heartbeats

Paseo plugin that adds a compact heartbeat icon and count to every active agent's composer. Pressing
the pill opens an agent-scoped panel for reviewing and managing that agent's heartbeats.

## Interface

- The composer pill contains only a heartbeat icon and the number of currently scheduled
  heartbeats.
- The panel lists each prompt, human-readable cadence, raw cron expression, next run, completed run
  count, and maximum run count.
- Heartbeats can be edited or deleted. Cron-only edits preserve their run history. Paseo does not
  expose prompt or maximum-run updates for heartbeats, so changing either creates a replacement and
  resets the daemon's run history for that heartbeat.
- The add form is always visible. Its schedule field accepts five-field cron, one-shot delays such as
  `15m`, `15 minutes`, or `in one hour`, and recurring phrases such as `every 15 minutes`. Suggested
  common schedules appear directly below the field.
- One-shot delays are compiled to a UTC cron occurrence with a one-run limit. Recurring phrases are
  accepted only when five-field cron can represent the interval exactly.

The count and panel refresh every 15 seconds and immediately after a mutation. Completed heartbeats
are not counted or listed.

## Runtime behavior

The plugin reads the daemon's atomic schedule records under `$PASEO_HOME/schedules` to list
agent-target heartbeats, including heartbeats created outside this plugin. Mutations run Paseo's
supported `heartbeat create`, `heartbeat update`, and `heartbeat delete` commands without a shell,
after checking that the heartbeat belongs to the selected agent.

## Install

```bash
paseo plugin add panrafal/paseo-plugins:agent-heartbeats
```

From a checkout:

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/agent-heartbeats
paseo plugin ls
```

After editing:

```bash
npm run typecheck
paseo plugin reload agent-heartbeats
paseo plugin logs agent-heartbeats
```
