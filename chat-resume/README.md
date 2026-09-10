# chat-resume

Adds two composer pills to agents whose latest state is an error caused by exhausted provider usage.

- **Resume when renewed** re-fetches the agent, reads the renewal time from its latest provider error,
  and creates one heartbeat with `maxRuns: 1`. It runs two minutes after renewal and continues the
  same agent.
- **Handover** re-fetches the source agent, selects the next enabled, ready provider, and creates an
  idle agent in the same workspace. It carries across the closest planning mode and thinking level,
  then opens an editable handover draft with commands for recovering the source chat through the
  `paseo` CLI.

The public plugin API does not expose the native composer draft, so the handover draft is hosted in
an agent-scoped plugin panel. The new agent does not start until **Start agent** is pressed.

Provider renewal windows are not currently exposed through the public plugin API. The resume pill
therefore uses the latest refreshed agent error as the source of the exhaustion state and reset time.
Errors without a parseable renewal time still get the handover pill, but not the resume pill.

## Limitations

- Pills appear only when the latest agent state is a usage-limit / quota-exhaustion error.
- The resume pill needs a parseable renewal time in that error; otherwise only handover is shown.
- The handover draft lives in a plugin panel, not the native composer. The new agent does not
  start until **Start agent** is pressed.

## Install

```bash
paseo plugin add panrafal/paseo-plugins:chat-resume
```

From a checkout:

```bash
npm install
npm run typecheck --workspace=chat-resume
paseo plugin install /absolute/path/to/paseo-plugins/chat-resume
```

After source changes:

```bash
paseo plugin reload chat-resume
```
