# Stream Deck Companion

A Foundry VTT module that works alongside the
[foundryvtt-streamdeck-plugin](https://github.com/DanElbert/foundryvtt-streamdeck-plugin) OpenAction
plugin. It connects the GM's browser to the plugin running beside OpenDeck and pushes events to the
Stream Deck so buttons update immediately instead of polling.

## Requirements

- Foundry VTT v14
- The plugin, version 1.0 or later, running in OpenDeck on the same machine as the GM's browser (or
  on one it can reach). Nothing else: no relay, no REST API module.

Every request from the deck goes to a fixed set of actions in this module, never to arbitrary code.

## Install

Manifest URL:

```
https://raw.githubusercontent.com/DanElbert/foundryvtt-streamdeck-module/main/module.json
```

Enable it in the world. Then, in the browser that runs beside OpenDeck (normally the GM's), open
**Configure Settings → Module Settings** and set:

- **Stream Deck: Plugin URL** — `ws://localhost:28415` unless the port was changed in the plugin.
- **Stream Deck: Token** — generated in any Foundry button's settings in OpenDeck (**Plugin
  connection → Generate**, then **Copy**).
- **Stream Deck: Enabled** — on by default; turn it off to stop this browser connecting.

These settings are per browser. Other players' browsers never connect. Saving the settings connects
right away; a wrong token shows a permanent error notification until it is corrected.

## What it does

- **Actor sheet state.** When an actor sheet opens or closes in the connected browser, the matching
  Stream Deck buttons update right away. Whenever the browser connects, including after a reload, it
  sends the full list of open sheets so the deck catches up.

- **Condition buttons.** Whatever tokens are selected in that browser, the deck's condition
  buttons show whether each condition is on all of them, some of them, or none, and pressing a
  button toggles it: if every selected token has the condition it is removed from all of them,
  otherwise it is added to the ones missing it. Offers the core D&D 5e conditions plus surprised
  (not exhaustion).

- **Initiative button.** With no combat and tokens selected, one press creates a combat, adds the
  selected tokens, rolls initiative for all of them and starts round 1. While a combat exists (the
  one the combat tracker is showing), the deck shows whose turn it is and follows turn changes.

- **Macro buttons.** Pressing runs the chosen macro in that browser, with its selected tokens as
  the speaker. The deck's dropdowns list actors and macros grouped by their folders.

Only the browser that holds the plugin connection sends events or acts on presses; other players'
sheets and selections are not tracked. If a second browser connects with the same token it takes
over, and the first one stops trying.

**Known quirk:** a condition implied by another one — *incapacitated* while a token is unconscious,
paralyzed, petrified or stunned — shows as on, but pressing it can't remove it. Remove the
condition that implies it instead.
