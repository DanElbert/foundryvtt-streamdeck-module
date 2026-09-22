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

Only the browser holding the relay connection sends events; other players' sheets are not tracked.
