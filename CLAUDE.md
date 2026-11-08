# CLAUDE.md

Code-level notes for `foundryvtt-streamdeck-module` (module id `foundryvtt-streamdeck`). The
Foundry-side companion to `../foundryvtt-streamdeck-plugin`. User-facing docs are in `README.md`.

## Transport: our own WebSocket to the plugin

The plugin hosts a WebSocket server on the machine running OpenDeck (`127.0.0.1:28415` by default);
this module dials it from the GM's browser. Nothing else is involved: the ThreeHats
`foundry-rest-api` module and the Go relay were retired in 1.0.

Three **client-scoped** settings (`scope: "client"`, so per browser; only the browser beside
OpenDeck gets a token and only it connects): `enabled` ("Stream Deck: Enabled"), `pluginUrl`
("Stream Deck: Plugin URL", default `ws://localhost:28415`) and `token` ("Stream Deck: Token"). Each
`onChange` runs a 100 ms-debounced `reconnect`, which is how a settings save takes effect without a
reload. `connect` runs once on `ready` and is a no-op without a token or with `enabled` off.

Why `ws://` from an https page works: browsers exempt loopback from mixed-content blocking (Chrome;
Firefox since bug 1376309). Recent Chrome may show a one-time Local Network Access prompt.

**Handshake.** On `open` the module sends `{type:"hello", token, version, world: game.world.id}` as
its first frame and waits for `{type:"connected", plugin}`; `authed` flips true only then, and
`emit` is gated on it, so nothing is pushed to a socket that might still be rejected. `world` lets
the plugin keep its art caches across a browser reload of the same world.

**Close codes** (`onclose`):

| Code | Meaning | Reaction |
|---|---|---|
| `4001` | no/bad hello (plugin timed out waiting) | reconnect with backoff |
| `4002` | token rejected | one permanent `ui.notifications.error`, `stopped = true`, no retry until a setting changes |
| `4003` | another browser took the plugin over | log, no retry (don't fight) |
| `1001` | plugin reconfigured / shutting down | reconnect with backoff |
| anything else (`1006` …) | network / plugin gone | reconnect with backoff `[1,2,4,8,15,30]` s |

`reconnect()` resets `stopped` and the backoff, closes any live socket with `1000` after nulling its
`onclose` (so that close doesn't schedule a retry), then connects. Stale sockets are ignored by
checking `ws !== socket` in every handler.

**Keep-alive is the plugin's job.** It sends protocol pings every 20 s and drops a peer that hasn't
answered; the browser pongs automatically, so there is nothing to do here.

## Requests: `request` / `result` frames

```
plugin → module   {"type":"request","requestId":…,"action":"toggleSheet","args":["Actor.x"]}
module → plugin   {"type":"result","requestId":…,"result":{…}}   (or top-level "error")
```

- **`onRequest`** looks `action` up in `ACTIONS` (the same object exposed as `module.api`) and awaits
  it with `args`. An unknown action, or one that throws, becomes a top-level `error` (the plugin sees
  `ServerError::Remote`). A *domain* failure like `{error:"no selection"}` is a normal return value
  and stays inside `result`.
- **Return plain JSON only.** `send()` wraps `JSON.stringify`; a cyclic or otherwise unserialisable
  reply is turned into a top-level `error` ("reply not serialisable") rather than silently dropped,
  so the plugin alerts at once instead of timing out after 25 s.
- The action set is fixed; nothing from the wire is evaluated, and there is no execute-JS path.

## Events: `{type:"event", event:…}` frames

Every push is `emit(payload)` → `{type:"event", ...payload}`, so `event` sits at the top level and
the plugin's `event_loop` keys on it directly. Module and plugin must be upgraded together (1.0
changed the transport on both sides).

| Payload | Meaning |
|---|---|
| `{event:"sheet", uuid, open}` | one actor sheet opened or closed |
| `{event:"snapshot", open:[uuid...]}` | the complete set of open actor sheets; anything absent is closed |
| `{event:"selection", count, statuses:{id: n}}` | `count` distinct selected actors; `n` of them have status `id`. Covers every status on any selected actor, not just the offered conditions. `count: 0` = nothing selected |
| `{event:"combat", combat: null \| {id, round, started, combatant: null \| {id, name, actorUuid}}}` | the combat the GM is looking at and whose turn it is; `null` = no combat |

A snapshot, followed by a forced `selection` and `combat`, is sent as soon as `connected` arrives
(`emitSnapshot`). `lastSelection`/`lastCombat` only advance when `emit` actually sent, so state that
changed while disconnected is re-sent on the next connection.

`api.snapshot()` returns `{version, open, selection, combat}`. The plugin also requests it once per
session right after `connected`; the two agree by construction.

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
(levels, not a toggle — deliberately skipped) plus `surprised`. dnd5e flags surprised `pseudo` only
because it is absent from the rules appendix; it is still registered in `CONFIG.statusEffects` with
its own icon and drives initiative disadvantage, so it toggles like any other condition.
`img` comes from `CONFIG.statusEffects`, which dnd5e rebuilds, falling back to the condition type's own.

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

## Sheet toggle (`toggleSheet`)

Ported from the plugin's former inline `execute-js` script; the details are load-bearing:

- `actor.sheet`, not `_sheet`: here it *wants* the construction. `actor.sheet` builds the
  Application on first access (`client-document.mjs`).
- `render({force: true})` — `force` is mandatory. A bare `render()` silently no-ops on a closed
  ApplicationV2 and still resolves (`application.mjs`).
- `close({animate: false})` skips a ~1 s transition.
- **`.rendered` is re-read after the await.** `DocumentSheetV2#_canRender` throws on missing view
  permission, `#render` catches it, warns, and resolves normally — so resolving proves nothing. The
  re-read is what makes `{open}` authoritative.
- `minimized` is ignored: a minimized sheet is `rendered === true`, which is the right answer to
  "is this on screen".

## Token art (`actorArt`)

Returns `{src, name, closed, open, offline, isOpen}`: three 144² `image/webp` data URLs, letterboxed
over the dark tile, with no border / `accent` border / `offline` border.

- **Source:** `token` (default) uses `A.isToken ? A.token : A.prototypeToken` → `texture.src`;
  `portrait` is `A.img`; `preferred` tries `getPreferredArtwork()` first. **Preferred is opt-in, not
  the default**, because dnd5e returns `showTokenPortrait ? texture : img` — the *portrait* unless
  that flag is set.
- Wildcard `randomImg` srcs resolve via `getTokenImages()` then `.sort()[0]` — deterministic on
  purpose; a random pick would change the button on every refetch and look like a bug.
- Video srcs are legal on `texture.src` (not on `img`) and fall back to the portrait.
- `isOpen` reads `_sheet?.rendered`, **not** `sheet`: reading state must not construct a sheet.
  `_sheet` is only nulled in `_onSheetChange`, never by `close()`.
- **Drawn from a `blob:` URL** (`loadImage`), which is same-origin whatever the source, so the canvas
  can't be tainted; a cross-origin asset fails at `fetch` with a catchable error instead of a
  `SecurityError` at `toDataURL`.
- Downscaling here caps each variant at ~15 KB instead of a multi-MB base64, and fixes the aspect
  ratio at the source.

**Known limitation:** cross-origin S3-hosted art is unreachable: the `fetch` runs in the GM's
browser, and there is no other route. Fix it with CORS headers on the bucket.

## Actor and macro lists (`actors`, `macros`)

`[{uuid, name, folder}]`, world documents only. `folder` is the full path root-first, `"A / B"`
(`folder.ancestors` is nearest-first, hence the reverse), or `null` when unfiled. Sorted by path
then name, so unfiled entries come first; the PI turns each path into one `<optgroup>` because
optgroups can't nest; that folder path is why `actors` exists instead of a generic search.
`macros` lists only `canExecute` macros.

## Macros (`executeMacro`, `macroArt`)

`executeMacro` checks `documentName === "Macro"` and `canExecute` (Macro#execute would otherwise
just warn and return nothing), then **does not await** the run. A script macro awaiting a dialog or
a long animation would otherwise hold the request past the plugin's 25 s timeout and alert on a
macro that worked. The reply therefore means "started", and a rejected script promise goes to
`Hooks.onError`, which notifies in Foundry. No scope is passed, so Foundry derives
`speaker`/`token`/`actor` from the controlled token, same as the hotbar.

`macroArt(uuid, {offline})` returns `{name, ready, offline}` via the same `drawTile` path. SVG icons
(core `icons/svg/*`, white on transparent) are drawn at 96² like conditions; raster icons fill the
tile like token art.
