const MODULE_ID = "foundryvtt-streamdeck";
const SETTINGS = { enabled: "enabled", url: "pluginUrl", token: "token" };
const DEFAULT_URL = "ws://localhost:28415";
const TILE = 144;
const ICON = 96;
const BACKGROUND = "#1b1d24";
const VIDEO = /\.(mp4|m4v|webm|ogv)(\?|$)/i;
const BACKOFF = [1, 2, 4, 8, 15, 30];
const CLOSE_BAD_TOKEN = 4002;
const CLOSE_REPLACED = 4003;

const openSheets = new Set();
let lastSelection = null;
let lastCombat = null;
let socket = null;
let authed = false;
let attempt = 0;
let retryTimer = null;
let stopped = false;

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

function send(frame) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  let text;
  try {
    text = JSON.stringify(frame);
  } catch (e) {
    text = JSON.stringify({ type: frame.type, requestId: frame.requestId, error: `reply not serialisable: ${e?.message ?? e}` });
  }
  socket.send(text);
  return true;
}

function emit(payload) {
  if (!authed) return false;
  return send({ type: "event", ...payload });
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
    .filter(([id, type]) => (!type.pseudo || id === "surprised") && id !== "exhaustion")
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
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`fetch blocked (CORS?): ${e?.message ?? e}`);
  }
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const obj = URL.createObjectURL(await res.blob());
  const img = new Image();
  img.src = obj;
  try {
    await img.decode();
  } catch (e) {
    throw new Error("decode failed");
  } finally {
    URL.revokeObjectURL(obj);
  }
  return img;
}

function drawTile(img, { size = ICON, alpha = 1, border, dashed }) {
  const c = document.createElement("canvas");
  c.width = TILE;
  c.height = TILE;
  const x = c.getContext("2d");
  x.fillStyle = BACKGROUND;
  x.fillRect(0, 0, TILE, TILE);
  const iw = img.naturalWidth || size;
  const ih = img.naturalHeight || size;
  const k = Math.min(size / iw, size / ih);
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

async function toggleSheet(uuid) {
  const actor = await fromUuid(uuid);
  if (!actor) return { error: "actor not found" };
  const sheet = actor.sheet;
  if (!sheet) return { error: "no sheet class for this actor" };
  if (sheet.rendered) await sheet.close({ animate: false });
  else await sheet.render({ force: true });
  return { open: !!sheet.rendered, name: actor.name };
}

async function actorArtSource(actor, source) {
  if (source === "portrait") return actor.img;
  let src = null;
  if (source === "preferred" && actor.getPreferredArtwork) {
    try {
      src = (await actor.getPreferredArtwork())?.src ?? null;
    } catch (e) {
      src = null;
    }
  }
  if (!src) {
    const token = actor.isToken ? actor.token : actor.prototypeToken;
    let s = token?.texture?.src ?? null;
    if (s?.includes("*")) {
      try {
        const images = await actor.getTokenImages();
        s = images?.length ? images.slice().sort()[0] : null;
      } catch (e) {
        s = null;
      }
    }
    if (s && VIDEO.test(s)) s = null;
    src = s;
  }
  return src || actor.img;
}

async function actorArt(uuid, { source, accent, offline }) {
  const actor = await fromUuid(uuid);
  if (!actor) return { error: "actor not found" };
  const src = await actorArtSource(actor, source);
  if (!src) return { error: "no artwork" };
  let img;
  try {
    img = await loadImage(src);
  } catch (e) {
    return { error: String(e?.message ?? e), src };
  }
  return {
    src,
    name: actor.name,
    closed: drawTile(img, { size: TILE }),
    open: drawTile(img, { size: TILE, border: accent }),
    offline: drawTile(img, { size: TILE, border: offline }),
    isOpen: !!actor._sheet?.rendered
  };
}

function folderPath(doc) {
  const folder = doc.folder;
  if (!folder) return null;
  return [...folder.ancestors.reverse(), folder].map((f) => f.name).join(" / ");
}

function listing(docs) {
  return docs
    .map((doc) => ({ uuid: doc.uuid, name: doc.name, folder: folderPath(doc) }))
    .sort((a, b) => (a.folder ?? "").localeCompare(b.folder ?? "") || a.name.localeCompare(b.name));
}

function actors() {
  return listing([...game.actors]);
}

function macros() {
  return listing(game.macros.filter((m) => m.canExecute));
}

async function findMacro(uuid) {
  const macro = await fromUuid(uuid);
  return macro?.documentName === "Macro" ? macro : null;
}

async function executeMacro(uuid) {
  const macro = await findMacro(uuid);
  if (!macro) return { error: "macro not found" };
  if (!macro.canExecute) return { error: "not permitted" };
  Promise.resolve()
    .then(() => macro.execute())
    .catch((e) =>
      Hooks.onError(`${MODULE_ID}.executeMacro`, e, { msg: `Macro "${macro.name}" failed`, log: "error", notify: "error" })
    );
  return { name: macro.name };
}

async function macroArt(uuid, { offline }) {
  const macro = await findMacro(uuid);
  if (!macro) return { error: "macro not found" };
  const src = macro.img;
  let img;
  try {
    img = await loadImage(src);
  } catch (e) {
    return { error: String(e?.message ?? e), src };
  }
  const size = /\.svg(\?|$)/i.test(src) ? ICON : TILE;
  return {
    src,
    name: macro.name,
    ready: drawTile(img, { size }),
    offline: drawTile(img, { size, alpha: 0.35, border: offline })
  };
}

const ACTIONS = {
  snapshot,
  conditions,
  toggleCondition,
  conditionArt,
  startCombat,
  toggleSheet,
  actorArt,
  actors,
  macros,
  executeMacro,
  macroArt
};

async function onRequest(data) {
  const reply = { type: "result", requestId: data?.requestId };
  const fn = ACTIONS[data?.action];
  if (!fn) {
    reply.error = `unknown action: ${data?.action}`;
  } else {
    try {
      reply.result = await fn(...(Array.isArray(data.args) ? data.args : []));
    } catch (e) {
      reply.error = String(e?.message ?? e);
    }
  }
  send(reply);
}

function version() {
  return game.modules.get(MODULE_ID).version;
}

function setting(key) {
  return game.settings.get(MODULE_ID, SETTINGS[key]);
}

function connect() {
  if (socket || stopped) return;
  const token = String(setting("token") ?? "").trim();
  if (!setting("enabled") || !token) return;
  const url = String(setting("url") ?? "").trim() || DEFAULT_URL;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.warn(`[${MODULE_ID}] cannot open ${url}: ${e?.message ?? e}`);
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token, version: version(), world: game.world.id }));
  ws.onmessage = (event) => {
    if (ws !== socket) return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (data?.type === "connected") {
      authed = true;
      attempt = 0;
      console.info(`[${MODULE_ID}] connected to plugin ${data.plugin ?? "?"} at ${url}`);
      emitSnapshot();
    } else if (data?.type === "request") {
      onRequest(data);
    }
  };
  ws.onclose = (event) => {
    if (ws !== socket) return;
    socket = null;
    authed = false;
    if (event.code === CLOSE_BAD_TOKEN) {
      stopped = true;
      ui.notifications.error("Stream Deck: the plugin rejected the token. Check the module settings.", { permanent: true });
      return;
    }
    if (event.code === CLOSE_REPLACED) {
      console.info(`[${MODULE_ID}] another browser took over the plugin connection`);
      return;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (retryTimer || stopped) return;
  const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)] * 1000;
  attempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function reconnect() {
  stopped = false;
  attempt = 0;
  clearTimeout(retryTimer);
  retryTimer = null;
  if (socket) {
    const ws = socket;
    socket = null;
    authed = false;
    ws.onclose = null;
    ws.close(1000, "reconfigured");
  }
  connect();
}

const scheduleReconfigure = foundry.utils.debounce(reconnect, 100);

function snapshot() {
  return {
    version: version(),
    open: [...currentOpen()],
    selection: computeSelection(),
    combat: computeCombat()
  };
}

function emitSnapshot() {
  openSheets.clear();
  for (const uuid of currentOpen()) openSheets.add(uuid);
  emit({ event: "snapshot", version: version(), open: [...openSheets] });
  sendSelection(true);
  sendCombat(true);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTINGS.enabled, {
    name: "Stream Deck: Enabled",
    hint: "Connect this browser to the Stream Deck plugin. Only the browser running beside OpenDeck needs this.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: scheduleReconfigure
  });
  game.settings.register(MODULE_ID, SETTINGS.url, {
    name: "Stream Deck: Plugin URL",
    hint: `Shown in the plugin's button settings in OpenDeck. ${DEFAULT_URL} unless the port was changed.`,
    scope: "client",
    config: true,
    type: String,
    default: DEFAULT_URL,
    onChange: scheduleReconfigure
  });
  game.settings.register(MODULE_ID, SETTINGS.token, {
    name: "Stream Deck: Token",
    hint: "Generated in the plugin's button settings in OpenDeck. Paste it here.",
    scope: "client",
    config: true,
    type: String,
    default: "",
    onChange: scheduleReconfigure
  });
  game.modules.get(MODULE_ID).api = { ...ACTIONS };
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

Hooks.once("ready", connect);
