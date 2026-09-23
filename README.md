# Stream Deck Companion

A Foundry VTT module that works alongside the
[foundryvtt-streamdeck-plugin](https://github.com/DanElbert/foundryvtt-streamdeck-plugin) OpenAction
plugin. It pushes events from Foundry to the Stream Deck so buttons update immediately instead of
polling.

## Requirements

- Foundry VTT v14
- The [REST API module](https://github.com/ThreeHats/foundryvtt-rest-api) (`foundry-rest-api`),
  paired with a relay. Events travel over its existing relay connection.

## Install

Manifest URL:

```
https://raw.githubusercontent.com/DanElbert/foundryvtt-streamdeck-module/main/module.json
```

Enable it in the world alongside the REST API module. There are no settings.

## What it does

- **Actor sheet state.** When an actor sheet opens or closes in the browser that holds the REST API
  relay connection (normally the GM's), the matching Stream Deck buttons update right away. After
  that browser reloads or reconnects, it sends the full list of open sheets so the deck catches up.

- **Condition buttons.** Whatever tokens are selected in that browser, the deck's condition
  buttons show whether each condition is on all of them, some of them, or none, and pressing a
  button toggles it: if every selected token has the condition it is removed from all of them,
  otherwise it is added to the ones missing it. Offers the core D&D 5e conditions (not exhaustion).

Only the browser holding the relay connection sends events or acts on presses; other players'
sheets and selections are not tracked.

**Known quirk:** a condition implied by another one — *incapacitated* while a token is unconscious,
paralyzed, petrified or stunned — shows as on, but pressing it can't remove it. Remove the
condition that implies it instead.
