const MODULE_ID = "foundryvtt-streamdeck";
const REST_API_ID = "foundry-rest-api";
const EVENT_HOOK = `${MODULE_ID}.event`;
const TILE = 144;
const ICON = 96;
const BACKGROUND = "#1b1d24";

const openSheets = new Set();
let lastSelection = null;
let lastCombat = null;

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
  return socket.send({ type: "hook-event", data: { hook: EVENT_HOOK, args: [payload] } });
}

function selectedActors() {
  const actors = new Map();
  for (const token of canvas?.tokens?.controlled ?? []) {
    const actor = token.actor;
    if (actor && !actors.has(actor.uuid)) actors.set(actor.uuid, actor);
  }
  return [...actors.values()];
}

function computeSelection() {
  const actors = selectedActors();
  const statuses = {};
  for (const actor of actors) {
    for (const id of actor.statuses) statuses[id] = (statuses[id] ?? 0) + 1;
  }
  return { count: actors.length, statuses };
}

function sendSelection(force = false) {
  const selection = computeSelection();
  const key = JSON.stringify(selection);
  if (!force && key === lastSelection) return;
  if (emit({ event: "selection", ...selection })) lastSelection = key;
}

const scheduleSelection = foundry.utils.debounce(() => sendSelection(), 50);

function computeCombat() {
  const combat = game.combat;
  if (!combat) return null;
  const combatant = combat.combatant ?? combat.turns[0] ?? null;
  return {
    id: combat.id,
    round: combat.round,
    started: combat.started,
    combatant: combatant
      ? { id: combatant.id, name: combatant.name, actorUuid: combatant.actor?.uuid ?? null }
      : null
  };
}

function sendCombat(force = false) {
  const combat = computeCombat();
  const key = JSON.stringify(combat);
  if (!force && key === lastCombat) return;
  if (emit({ event: "combat", combat })) lastCombat = key;
}

const scheduleCombat = foundry.utils.debounce(() => sendCombat(), 100);

async function startCombat() {
  if (game.combat) return { error: "combat already exists" };
  const tokens = (canvas?.tokens?.controlled ?? []).map((t) => t.document);
  if (!tokens.length) return { error: "no selection" };
  const combat = await Combat.implementation.create({ active: true });
  await TokenDocument.implementation.createCombatants(tokens, { combat });
  await combat.rollAll();
  await combat.startCombat();
  return { id: combat.id, count: tokens.length };
}

function conditions() {
  const types = CONFIG.DND5E?.conditionTypes ?? {};
  return Object.entries(types)
    .filter(([id, type]) => !type.pseudo && id !== "exhaustion")
    .map(([id, type]) => ({
      id,
      name: game.i18n.localize(type.name),
      img: CONFIG.statusEffects.find((e) => e.id === id)?.img ?? type.img
    }));
}

async function toggleCondition(id) {
  const actors = selectedActors();
  if (!actors.length) return { error: "no selection" };
  if (!conditions().some((c) => c.id === id)) return { error: `unknown condition: ${id}` };
  const allHave = actors.every((a) => a.statuses.has(id));
  await Promise.all(
    actors
      .filter((a) => a.statuses.has(id) === allHave)
      .map((a) => a.toggleStatusEffect(id, { active: !allHave }))
  );
  return { active: !allHave, count: actors.length };
}

async function loadImage(src) {
  const url = /^(https?:)?\/\//.test(src) ? src : foundry.utils.getRoute(src);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const obj = URL.createObjectURL(await res.blob());
  const img = new Image();
  img.src = obj;
  try {
    await img.decode();
  } finally {
    URL.revokeObjectURL(obj);
  }
  return img;
}

function drawTile(img, { alpha, border, dashed }) {
  const c = document.createElement("canvas");
  c.width = TILE;
  c.height = TILE;
  const x = c.getContext("2d");
  x.fillStyle = BACKGROUND;
  x.fillRect(0, 0, TILE, TILE);
  const iw = img.naturalWidth || ICON;
  const ih = img.naturalHeight || ICON;
  const k = Math.min(ICON / iw, ICON / ih);
  const w = iw * k;
  const h = ih * k;
  x.globalAlpha = alpha;
  x.drawImage(img, (TILE - w) / 2, (TILE - h) / 2, w, h);
  x.globalAlpha = 1;
  if (border) {
    x.lineWidth = 10;
    x.strokeStyle = border;
    if (dashed) x.setLineDash([14, 10]);
    x.beginPath();
    if (x.roundRect) x.roundRect(5, 5, 134, 134, 12);
    else x.rect(5, 5, 134, 134);
    x.stroke();
  }
  return c.toDataURL("image/webp", 0.9);
}

async function conditionArt(id, { accent, offline }) {
  const condition = conditions().find((c) => c.id === id);
  if (!condition) return { error: `unknown condition: ${id}` };
  let img;
  try {
    img = await loadImage(condition.img);
  } catch (e) {
    return { error: String(e?.message ?? e), src: condition.img };
  }
  return {
    name: condition.name,
    off: drawTile(img, { alpha: 0.35 }),
    on: drawTile(img, { alpha: 1, border: accent }),
    mixed: drawTile(img, { alpha: 1, border: accent, dashed: true }),
    none: drawTile(img, { alpha: 0.18 }),
    offline: drawTile(img, { alpha: 0.35, border: offline })
  };
}

function snapshot() {
  return {
    version: game.modules.get(MODULE_ID).version,
    open: [...currentOpen()],
    selection: computeSelection(),
    combat: computeCombat()
  };
}

function emitSnapshot() {
  openSheets.clear();
  for (const uuid of currentOpen()) openSheets.add(uuid);
  emit({ event: "snapshot", open: [...openSheets] });
  sendSelection(true);
  sendCombat(true);
}

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = { snapshot, conditions, toggleCondition, conditionArt, startCombat };
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

for (const hook of [
  "controlToken",
  "canvasReady",
  "createActiveEffect",
  "updateActiveEffect",
  "deleteActiveEffect",
  "updateActor",
  "updateItem"
]) {
  Hooks.on(hook, scheduleSelection);
}

for (const hook of [
  "createCombat",
  "updateCombat",
  "deleteCombat",
  "createCombatant",
  "updateCombatant",
  "deleteCombatant",
  "canvasReady",
  "renderCombatTracker"
]) {
  Hooks.on(hook, scheduleCombat);
}

Hooks.on(`${REST_API_ID}.relayConnected`, emitSnapshot);
Hooks.once("ready", emitSnapshot);
