# CLAUDE.md

Code-level notes for `foundryvtt-streamdeck-module` (module id `foundryvtt-streamdeck`). The
Foundry-side companion to `../foundryvtt-streamdeck-plugin`. User-facing docs are in `README.md`.

## Transport: piggybacking on the REST module's relay socket

There is no socket of our own. Events go out through the `foundry-rest-api` module's existing relay
connection as `hook-event` frames with a custom hook name:

```js
game.modules.get("foundry-rest-api").api.getWebSocketManager()
  .send({ type: "hook-event", data: { hook: "foundryvtt-streamdeck.sheet", args: [payload] } });
```

This works because the relay's `hook-event` fanout
(`foundryvtt-rest-api-relay/go-relay/internal/server/server.go`, `fanoutHookEvent`) never checks the
hook name against the REST module's `FORWARDED_HOOKS` allowlist, and forwards to every `/ws/api`
client subscribed to the `hooks` channel. A plain `Hooks.callAll("foundryvtt-streamdeck.sheet")` is
**not** forwarded — the allowlist is private and fixed.

- `isRelayConnected()` is checked before `getWebSocketManager()`: the latter logs a warning on every
  call from a browser that has no relay token, i.e. every player client.
- Only the browser holding the relay connection emits. That is the same browser the plugin's
  `execute-js` scripts run in, so the events describe the sheets the plugin toggles.
- Side effect: the plugin's `hooks` subscription makes the REST module turn on its 33 built-in
  forwarded hooks. The plugin drops them. WS subscribers can't filter server-side (the relay's
  `AddWSEventFunc` ignores `filters`).

The plugin receives:

```json
{"type":"hook-event","hook":"foundryvtt-streamdeck.sheet",
 "data":{"type":"hook-event","data":{"hook":"foundryvtt-streamdeck.sheet","args":[PAYLOAD]}}}
```

## Payloads on `foundryvtt-streamdeck.sheet`

| Payload | Meaning |
|---|---|
| `{event:"sheet", uuid, open}` | one actor sheet opened or closed |
| `{event:"snapshot", open:[uuid...]}` | the complete set of open actor sheets; anything absent is closed |

A snapshot is sent on `ready` and on `foundry-rest-api.relayConnected` (fired after relay auth in
`webSocketManager.ts`). This covers a GM browser reload, which closes every sheet while the
plugin's own relay session stays up. Whichever of the two fires while disconnected is a no-op; the
other one delivers.

`api.snapshot()` returns `{version, open}`. The plugin calls it once per relay session through
`execute-js`, which doubles as its "is the companion installed" probe.

## Sheet hooks

`renderActorSheetV2` / `closeActorSheetV2`. ApplicationV2 dispatches `render{Class}` and
`close{Class}` for every class in the inheritance chain (`application.mjs`, `#callHooks`), so
dnd5e's sheet subclasses fire these too. AppV1 actor sheets are not handled.

`render` fires on **every** re-render (each actor update), so a module-level `Set` deduplicates and
only real transitions are emitted. A render refused for lack of permission never reaches `_onRender`,
so it emits nothing.
