const MODULE_ID = "foundryvtt-streamdeck";
const REST_API_ID = "foundry-rest-api";
const SHEET_HOOK = `${MODULE_ID}.sheet`;

const openSheets = new Set();

function isActorSheet(app) {
  return app instanceof foundry.applications.sheets.ActorSheetV2;
}

function currentOpen() {
  const open = new Set();
  for (const app of foundry.applications.instances.values()) {
    if (isActorSheet(app) && app.rendered && app.document?.uuid) open.add(app.document.uuid);
  }
  return open;
}

function emit(payload) {
  const api = game.modules.get(REST_API_ID)?.api;
  if (!api?.isRelayConnected?.()) return false;
  const socket = api.getWebSocketManager();
  if (!socket) return false;
  return socket.send({ type: "hook-event", data: { hook: SHEET_HOOK, args: [payload] } });
}

function snapshot() {
  return {
    version: game.modules.get(MODULE_ID).version,
    open: [...currentOpen()]
  };
}

function emitSnapshot() {
  openSheets.clear();
  for (const uuid of currentOpen()) openSheets.add(uuid);
  emit({ event: "snapshot", open: [...openSheets] });
}

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = { snapshot };
});

Hooks.on("renderActorSheetV2", (app) => {
  const uuid = app.document?.uuid;
  if (!uuid || openSheets.has(uuid)) return;
  openSheets.add(uuid);
  emit({ event: "sheet", uuid, open: true });
});

Hooks.on("closeActorSheetV2", (app) => {
  const uuid = app.document?.uuid;
  if (!uuid || !openSheets.delete(uuid)) return;
  emit({ event: "sheet", uuid, open: false });
});

Hooks.on(`${REST_API_ID}.relayConnected`, emitSnapshot);
Hooks.once("ready", emitSnapshot);
