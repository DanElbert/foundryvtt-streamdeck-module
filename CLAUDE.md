# CLAUDE.md

Code-level notes for `foundryvtt-streamdeck-module` (module id `foundryvtt-streamdeck`). The
Foundry-side companion to `../foundryvtt-streamdeck-plugin`. User-facing docs are in `README.md`.

## Transport: piggybacking on the REST module's relay socket

There is no socket of our own. Events go out through the `foundry-rest-api` module's existing relay
connection as `hook-event` frames with a custom hook name:

```js
game.modules.get("foundry-rest-api").api.getWebSocketManager()
  .send({ type: "hook-event", data: { hook: "foundryvtt-streamdeck.event", args: [payload] } });
```

This works because the relay's `hook-event` fanout
(`foundryvtt-rest-api-relay/go-relay/internal/server/server.go`, `fanoutHookEvent`) never checks the
hook name against the REST module's `FORWARDED_HOOKS` allowlist, and forwards to every `/ws/api`
client subscribed to the `hooks` channel. A plain `Hooks.callAll("foundryvtt-streamdeck.event")` is
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
{"type":"hook-event","hook":"foundryvtt-streamdeck.event",
 "data":{"type":"hook-event","data":{"hook":"foundryvtt-streamdeck.event","args":[PAYLOAD]}}}
```

## Payloads on `foundryvtt-streamdeck.event`

The hook name was `foundryvtt-streamdeck.sheet` in 0.1.0. The plugin matches it exactly, so module
and plugin must be upgraded together.

| Payload | Meaning |
|---|---|
| `{event:"sheet", uuid, open}` | one actor sheet opened or closed |
| `{event:"snapshot", open:[uuid...]}` | the complete set of open actor sheets; anything absent is closed |
| `{event:"selection", count, statuses:{id: n}}` | `count` distinct selected actors; `n` of them have status `id`. Covers every status on any selected actor, not just the offered conditions. `count: 0` = nothing selected |
| `{event:"combat", combat: null \| {id, round, started, combatant: null \| {id, name, actorUuid}}}` | the combat the GM is looking at and whose turn it is; `null` = no combat |

A snapshot, followed by a forced `selection` and `combat`, is sent on `ready` and on `foundry-rest-api.relayConnected` (fired after relay auth in
`webSocketManager.ts`). This covers a GM browser reload, which closes every sheet while the
plugin's own relay session stays up. Whichever of the two fires while disconnected is a no-op; the
other one delivers.

`api.snapshot()` returns `{version, open, selection, combat}`. The plugin calls it once per relay session through
`execute-js`, which doubles as its "is the companion installed" probe.

## Sheet hooks

`renderActorSheetV2` / `closeActorSheetV2`. ApplicationV2 dispatches `render{Class}` and
`close{Class}` for every class in the inheritance chain (`application.mjs`, `#callHooks`), so
dnd5e's sheet subclasses fire these too. AppV1 actor sheets are not handled.

`render` fires on **every** re-render (each actor update), so a module-level `Set` deduplicates and
only real transitions are emitted. A render refused for lack of permission never reaches `_onRender`,
so it emits nothing.

## Selection and conditions

State is `actor.statuses.has(id)` — rebuilt on every `prepareData`, so it includes statuses implied
by another effect (unconscious/paralyzed/petrified/stunned carry `incapacitated`). Selected actors
are deduplicated by `actor.uuid` because several linked tokens can share one actor.

There is no single "statuses changed" hook. `controlToken`, `canvasReady`, `create/update/delete
ActiveEffect`, `updateActor` and `updateItem` (equip changes can suppress transfer effects) all
schedule a 50 ms-debounced recompute; `controlToken` fires once per token in bursts, and
`canvas.tokens.controlled` is already current when it fires. Only a changed result is emitted, and
`lastSelection` is only advanced when `emit` actually sent, so a disconnected browser re-sends once
it is back.

`api.conditions()` is the non-`pseudo` entries of `CONFIG.DND5E.conditionTypes` minus `exhaustion`
(levels, not a toggle — deliberately skipped). `img` comes from `CONFIG.statusEffects`, which dnd5e
rebuilds, falling back to the condition type's own.

`api.toggleCondition(id)` is tri-state: if every selected actor has it, `toggleStatusEffect(id,
{active:false})` on all; otherwise `{active:true}` on the ones missing it. Same call as the Token
HUD, so dnd5e's cover-exclusivity override and rider conditions (unconscious → prone) apply. It
returns without repainting anything; the `selection` event that the effect hooks produce is what
updates the deck.

**Known limitation:** an implied-only status (incapacitated from unconscious) reads as present, and
`toggleStatusEffect(false)` has no effect of its own to delete, so the press is a no-op and the
button stays lit. Honest, so not worked around.

`api.conditionArt(id, {accent, offline})` rasterises the condition SVG into five 144² webp data URLs
(`off`, `on`, `mixed`, `none`, `offline`) — same fetch → blob URL → decode → canvas route as the
plugin's token-art script, and for the same reasons (blob URLs never taint the canvas; the deck
never decodes SVG itself). Icon at 96², alpha 1 / 0.35 / 0.18; border solid for `on`, dashed for
`mixed`, grey for `offline`. The dnd5e status SVGs are white on transparent, hence the dark tile.

## Combat

**Which combat:** `game.combat` — `ui.combat.viewed` when the sidebar tracker is rendered, otherwise
the active combat for the viewed scene (`client/game.mjs`). So it is whatever the GM sees in the
tracker, which is also the answer to "the first combat" when there are several.

**Whose turn:** `combat.combatant ?? combat.turns[0]`. `combatant` is null until `startCombat()`
(turn is null at round 0), so a combat built by hand but not started shows the top of the tracker.
`turns` includes hidden and defeated combatants; fine for a GM-only deck. `combatant.actor` is the
synthetic actor for unlinked tokens, so `actorUuid` opens the right sheet.

**Change detection:** `create/update/delete` `Combat` and `Combatant` (document hooks fire on every
client), plus `canvasReady` (scope depends on the viewed scene) and `renderCombatTracker` (GM
switching tracker tabs). **Not** `combatStart`/`combatTurn`/`combatRound` — those fire only on the
client that made the change. Recompute is debounced 100 ms because Combat rebuilds `turns` on its own
50 ms `debounceSetup`; change-only emit like `selection`.

**`api.startCombat()`:** refuses if `game.combat` exists or nothing is selected, then
`Combat.create({active:true})` → `TokenDocument.createCombatants(tokens, {combat})` → `rollAll()` →
`startCombat()`. `combat` is passed explicitly because `createCombatants` otherwise targets whatever
the tracker is viewing. The combat is unlinked (no scene), same as the Token HUD toggle. dnd5e's
`rollAll` goes through `Actor5e.getInitiativeRoll`, which never prompts (only
`rollInitiativeDialog` does); hidden combatants' rolls are GM-only by core default.
