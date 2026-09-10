# chat-resume

Adds two composer pills to agents whose latest state is a provider usage-limit / quota
exhaustion — including Claude's "You've hit your monthly spend limit" assistant message,
which leaves the agent idle instead of in `error`.

Pills are offered when that state is the latest provider error **or** the last assistant
line in the transcript, both live and when you reopen the thread later.

- **Continue** sends a follow-up on the same agent. Shown when the parsed renewal time has
  already passed, or when the message has no parseable renewal time.
- **Resume when renewed** creates one heartbeat with `maxRuns: 1`. Shown while the renewal
  time is still in the future. It runs two minutes after renewal and continues the same
  agent. Once that time arrives, the pill becomes **Continue**.
- **Handover** re-fetches the source agent, selects the next enabled, ready provider, and
  creates an idle agent in the same workspace. It carries across the closest planning mode
  and thinking level, then opens an editable handover draft with commands for recovering
  the source chat through the `paseo` CLI.

The public plugin API does not expose the native composer draft, so the handover draft is
hosted in an agent-scoped plugin panel. The new agent does not start until **Start agent**
is pressed.

Provider renewal windows are not currently exposed through the public plugin API. The
plugin reads the latest refreshed agent error and the last transcript assistant message
for the exhaustion state and reset time, including times such as `resets 12am (Europe/Warsaw)`.

## Limitations

- Pills appear when the latest idle or error state is a usage-limit / quota-exhaustion
  message, not for context-window overflows or other failures.
- ACP providers that keep no on-disk transcript are detected only through `lastError`.
- The handover draft lives in a plugin panel, not the native composer. The new agent does
  not start until **Start agent** is pressed.

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
