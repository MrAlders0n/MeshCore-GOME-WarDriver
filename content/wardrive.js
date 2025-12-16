import { WebBleConnection, Constants } from "/content/mc/index.js";
import {
  ageInDays,
  centerPos,
  coverageKey,
  geo,
  isValidLocation,
  maxDistanceMiles,
  posFromHash,
  sampleKey
} from "/content/shared.js";

// --- DOM helpers ---
const $ = id => document.getElementById(id);
const statusEl = $("status");
const deviceInfoEl = $("deviceInfo");
const ignoredRepeaterId = $("ignoredRepeaterId");

const connectBtn = $("connectBtn");
const sendPingBtn = $("sendPingBtn");
const autoToggleBtn = $("autoToggleBtn");
const ignoredRepeaterBtn = $("ignoredRepeaterBtn");

const wardriveChannelName = "#wardrive";
const refreshTileAge = 1; // Tiles older than this (days) will get pinged again.

// --- Global Init ---
// Map setup
const map = L.map('map', {
  worldCopyJump: true,
  dragging: true,
  scrollWheelZoom: true,
  touchZoom: true,
  boxZoom: false,
  keyboard: false,
  tap: false,
  zoomControl: false,
  doubleClickZoom: false
}).setView(centerPos, 11);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 15,
  minZoom: 8,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Map layers
const pingLayer = L.layerGroup().addTo(map);
const coverageLayer = L.layerGroup().addTo(map);
const currentLocMarker = L.circleMarker([0, 0], {
  radius: 5,
  weight: 2,
  color: "white",
  fillColor: "#69DBFE",
  fillOpacity: .9,
  className: "marker-shadow",
  pane: "tooltipPane"
}).addTo(map);

// Max radius circle.
L.circle(centerPos, {
  radius: maxDistanceMiles * 1609.34, // meters in mile.
  color: '#a13139',
  weight: 3,
  fill: false
}).addTo(map);

// Map controls
const mapControl = L.control({ position: 'bottomleft' });
mapControl.onAdd = m => {
  const div = L.DomUtil.create('div', 'leaflet-control');
  div.innerHTML = `
    <div class="flex items-center gap-3">
      <button class="px-2 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-md font-medium shadow-sm" id="followBtn">🧭</button>
      <button class="px-2 py-1.5 rounded-lg bg-orange-100 hover:bg-orange-300 text-md font-medium shadow-sm" id="clearBtn">🗑️</button>
    </div>
  `;

  div.querySelector("#followBtn")
    .addEventListener("click", () => {
      state.following = !state.following;
      updateFollowButton();
    });

  div.querySelector("#clearBtn")
    .addEventListener("click", () => {
      if (confirm("Clear ping history?")) {
        pingLayer.clearLayers();
        state.pings = [];
        savePingHistory();
      }
    });

  // Don’t let clicks on the control bubble up and pan/zoom the map.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  return div;
};
mapControl.addTo(map);

// Stop following if the user interacts with the map.
map.on("mousedown touchstart wheel dragstart", () => {
  state.following = false;
  updateFollowButton();
});

// --- Logging ---
function setStatus(text, color = null) {
  statusEl.textContent = text;
  log(`status: ${text}`);
  statusEl.className = "font-semibold " + (color ?? "");
}

function log(msg) {
  console.log(msg);
}

// --- State ---
const PING_HISTORY_ID_KEY = "meshcoreWardrivePingHistoryV1"
const IGNORED_ID_KEY = "meshcoreWardriveIgnoredIdV1"

const state = {
  connection: null,
  selfInfo: null,
  wardriveChannel: null,
  running: false,
  autoTimerId: null,
  wakeLock: null,
  ignoredId: null, // Allows a repeater to be ignored.
  pings: [], // { hash: 8-char, heard: Bool }
  tiles: new Map(),
  following: true,
  locationTimer: null,
  lastPosUpdate: 0, // Timestamp of last location update.
  currentPos: [0, 0],
};

// --- Coverage Functions ---
function mergeCoverage(id, value) {
  const prev = state.tiles.get(id);

  if (!prev) {
    state.tiles.set(id, value);
    return;
  }

  // h is 0|1 for "heard" -- prefer heard.
  // a is "age in days" -- prefer newest.
  prev.h = Math.max(value.h, prev.h);
  prev.a = Math.min(value.a, prev.a);
}

async function refreshCoverage(tileId = null) {
  try {
    let url = "/get-wardrive-coverage";
    if (tileId) url += `?p=${tileId}`;
    const resp = await fetch(url);
    const coverage = (await resp.json()) ?? [];
    log(`Got ${coverage.length} coverage tiles from service.`);
    coverage.forEach(([id, val]) => mergeCoverage(id, val));
  } catch (e) {
    console.error("Getting coverage failed", e);
    setStatus("Get coverage failed", "text-red-300");
  }
}

function getCoverageBoxMarker(tileId, info) {
  const [minLat, minLon, maxLat, maxLon] = geo.decode_bbox(tileId);
  const color = (info.h ? "#398821" : "#E04748");
  const fillColor = info.a > refreshTileAge
    ? (info.h ? "#9ED2A1" : "#E4B8A9")  // Old
    : (info.h ? "#398821" : "#E04748"); // Fresh

  const style = {
    color: color,
    opacity: 0.6,
    weight: 1,
    fillColor: fillColor,
    fillOpacity: 0.6,
    pane: "overlayPane"
  };
  return L.rectangle([[minLat, minLon], [maxLat, maxLon]], style);
}

function addCoverageBox(tileId) {
  const info = state.tiles.get(tileId);

  // Remove the existing marker, if any.
  if (info.marker) {
    coverageLayer.removeLayer(info.marker);
  }

  info.marker = getCoverageBoxMarker(tileId, info);
  coverageLayer.addLayer(info.marker);
}

function redrawCoverage() {
  coverageLayer.clearLayers();
  state.tiles.keys().forEach(addCoverageBox);
}

// --- Ping markers ---
async function getSample(sampleId) {
  try {
    let url = `/get-samples?p=${sampleId}`;
    const resp = await fetch(url);
    const samples = (await resp.json()) ?? [];
    log(`Got ${samples.length} samples from service.`);
    return samples[0]; // May return undefined.
  } catch (e) {
    console.error("Getting sample failed", e);
    setStatus("Get sample failed", "text-red-300");
  }
}

function loadPingHistory() {
  try {
    state.pings = [];
    const data = localStorage.getItem(PING_HISTORY_ID_KEY);
    state.pings = JSON.parse(data) ?? [];

    // Upgrade ping data if needed.
    if (state.pings.length > 0 && !state.pings[0].hasOwnProperty("hash")) {
      state.pings = state.pings.map(x => ({ hash: sampleKey(x[0], x[1]) }));
      savePingHistory();
    }
  } catch (e) {
    console.warn("Failed to load ping history", e);
  }
}

function savePingHistory() {
  try {
    localStorage.setItem(PING_HISTORY_ID_KEY, JSON.stringify(state.pings));
  } catch (e) {
    console.warn("Failed to save ping history", e);
  }
}

function addPingHistory(ping) {
  addPingMarker(ping);
  state.pings.push(ping);
  savePingHistory();
}

function addPingMarker(ping) {
  const color =
    ping.heard === true
      ? '#398821' // Hit - Green
      : ping.heard === false
        ? '#E04748' // Miss - Red
        : "#B92FAE"; // Unknown - Purple

  const pos = posFromHash(ping.hash);
  const pingMarker = L.circleMarker(pos, {
    radius: 4,
    weight: 1,
    color: "white",
    fillColor: color,
    fillOpacity: .75,
    pane: "markerPane",
    className: "marker-shadow"
  });
  pingLayer.addLayer(pingMarker);
}

function redrawPingHistory() {
  pingLayer.clearLayers();
  state.pings.forEach(addPingMarker);
}

// --- Ignored Id ---
function loadIgnoredId() {
  try {
    state.ignoredId = null;
    const id = localStorage.getItem(IGNORED_ID_KEY);
    state.ignoredId = id ? id : null;
  } catch (e) {
    console.warn("Failed to load ignored id", e);
  }

  updateIgnoreId();
}

function promptIgnoredId() {
  const id = prompt("Enter repeater id to ignore.", state.ignoredId ?? '');

  // Was prompt cancelled?
  if (id === null)
    return;

  if (id && id.length !== 2) {
    alert(`Invalid id '${id}'. Must be 2 hex digits.`);
    return;
  }

  state.ignoredId = id ? id : null;
  localStorage.setItem(IGNORED_ID_KEY, id);
  updateIgnoreId();
}

function updateIgnoreId() {
  ignoredRepeaterId.innerText = state.ignoredId ?? "<none>";
}

// --- Geolocation ---
async function startLocationTracking() {
  stopLocationTracking();
  await updateCurrentPosition(); // Run immediately, then on timer.
  state.locationTimer = setInterval(updateCurrentPosition, 1000);
}

function stopLocationTracking() {
  if (state.locationTimer) {
    clearInterval(state.locationTimer);
    state.locationTimer = null;
  }
}

async function updateCurrentPosition() {
  const pos = await getCurrentPosition();
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  state.currentPos = [lat, lon];

  currentLocMarker.setLatLng(state.currentPos);

  if (state.following)
    map.panTo(state.currentPos);

  state.lastPosUpdate = Date.now();
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation is not available in this browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => reject(err),
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 5000,
      }
    );
  });
}

// Helper to ensure the location tracking timer stays running.
async function ensureCurrentPositionIsFresh() {
  const dt = Date.now() - state.lastPosUpdate;
  if (dt > 3000) {
    await startLocationTracking();
  }
}

// --- WakeLock ---
async function acquireWakeLock() {
  // Bluefy-specfic -- it's a bit better when available.
  if ('setScreenDimEnabled' in navigator.bluetooth) {
    // This name is bad. setScreenDimEnabled(true) prevents screen locking.
    navigator.bluetooth.setScreenDimEnabled(true);
    log('setScreenDimEnabled(true)');
  } else {
    try {
      if ('wakeLock' in navigator) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        log('navigator.wakeLock acquired');

        state.wakeLock.addEventListener('release',
          () => log('navigator.wakeLock released'));

      } else {
        log('navigator.wakeLock not supported');
      }
    } catch (err) {
      console.error(`Could not obtain wake lock: ${err.name}, ${err.message}`);
    }
  }
}

async function releaseWakeLock() {
  if ('setScreenDimEnabled' in navigator.bluetooth) {
    navigator.bluetooth.setScreenDimEnabled(false);
    log('setScreenDimEnabled(false)');
  } else {
    if (state.wakeLock !== null) {
      state.wakeLock.release();
      state.wakeLock = null;
    }
  }
}

// --- Wardrive channel ---
async function createWardriveChannel() {
  const create = window.confirm(
    `Channel "${wardriveChannelName}" not found on this device. Create it now?`
  );

  if (!create) {
    throw new Error("Wardrive channel not found");
  }

  // Find a free channel index.
  const channels = await state.connection.getChannels();
  let idx = 0;
  while (idx < channels.length) {
    if (channels[idx].name === '')
      break;
    ++idx;
  }

  if (idx >= channels.length) {
    throw new Error("No free channel slots available");
  }

  // Derived secret for #wardrive 4076c315c1ef385fa93f066027320fe5
  const wardriveKey = new Uint8Array([
    0x40, 0x76, 0xC3, 0x15, 0xC1, 0xEF, 0x38, 0x5F,
    0xA9, 0x3F, 0x06, 0x60, 0x27, 0x32, 0x0F, 0xE5
  ]);

  // Create and set the connection.
  const channel = { channelIdx: idx, name: wardriveChannelName, wardriveKey };
  await state.connection.setChannel(idx, wardriveChannelName, wardriveKey);
  return channel;
}

async function ensureWardriveChannel() {
  if (!state.connection) {
    throw new Error("Not connected");
  }

  if (state.wardriveChannel) {
    return state.wardriveChannel;
  }

  // Look for existing channel by name.
  let channel = await state.connection.findChannelByName(wardriveChannelName);

  if (!channel) {
    channel = await createWardriveChannel();
  }

  deviceInfoEl.textContent += ` CH:${channel.channelIdx}`;
  state.wardriveChannel = channel;
  return channel;
}

// --- Ping logic ---
async function sendPing({ auto = false } = {}) {
  if (!state.connection) {
    setStatus("Not connected", "text-red-300");
    return;
  }

  if (!state.channel) {
    try {
      state.channel = await ensureWardriveChannel();
    } catch (e) {
      console.warn(`Channel "${wardriveChannelName}" not available`, e);
      setStatus(`No "${wardriveChannelName}" channel`, "text-amber-300");
      return;
    }
  }

  try {
    await ensureCurrentPositionIsFresh();
  } catch (e) {
    console.error("Get location failed", e);
    setStatus("Get location failed", "text-amber-300");
    return;
  }

  let pos = state.currentPos;
  if (!isValidLocation(pos)) {
    setStatus("Outside coverage area", "text-red-300");
    return;
  }

  const [lat, lon] = pos;
  const sampleId = sampleKey(lat, lon);
  const tileId = coverageKey(lat, lon);

  // A Ping is needed in the current tile if the tile
  // is missing an entry or the entry is old.
  const info = state.tiles.get(tileId);
  const needsPing = !info || info.a > refreshTileAge;
  if (auto && !needsPing) {
    setStatus("No ping needed", "text-amber-300");
    return;
  }

  // TODO: just send the sample geohash.
  let text = `${lat.toFixed(4)} ${lon.toFixed(4)}`;
  if (state.ignoredId !== null) text += ` ${state.ignoredId}`;

  try {
    // Send mesh message: "<lat> <lon> [<id>]".
    await state.connection.sendChannelTextMessage(state.channel.channelIdx, text);
    log("Sent MeshCore wardrive ping:", text);
    setStatus(auto ? "Auto ping sent" : "Ping sent", "text-emerald-300");
  } catch (e) {
    console.error("Mesh send failed", e);
    setStatus("Mesh send failed", "text-red-300");
    return;
  }

  // Send sample to service.
  try {
    await fetch("/put-sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon }),
    });
  } catch (e) {
    console.error("Service POST failed", e);
    setStatus("Web send failed", "text-red-300");
  }

  // Update the tile state immediately.
  // Setting "age" to the cutoff so it stops getting pinged.
  mergeCoverage(tileId, { h: 0, a: refreshTileAge });

  // Queue fetching the sample from the service to update the UI.
  // The mesh+MQTT+service can be pretty slow so give it a few seconds to process.
  setTimeout(async () => {
    const sample = await getSample(sampleId);
    const ping = { hash: sampleId };

    if (sample) {
      ping.heard = sample.path?.length > 0;
      const age = ageInDays(sample.time);
      const h = ping.heard ? 1 : 0;
      mergeCoverage(tileId, { h: h, a: age });
    }

    addCoverageBox(tileId);
    addPingHistory(ping);
  }, 3500);
}

// --- UI ---
function updateControlsForConnection(connected) {
  connectBtn.disabled = false;

  if (connected) {
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.remove("bg-emerald-600", "hover:bg-emerald-500");
    connectBtn.classList.add("bg-red-600", "hover:bg-red-500");
    sendPingBtn.disabled = false;
    autoToggleBtn.disabled = false;
  } else {
    connectBtn.textContent = "Connect";
    connectBtn.classList.add("bg-emerald-600", "hover:bg-emerald-500");
    connectBtn.classList.remove("bg-red-600", "hover:bg-red-500");
    sendPingBtn.disabled = true;
    autoToggleBtn.disabled = true;
  }
}

function updateFollowButton() {
  const followBtn = $("followBtn");
  if (state.following) {
    followBtn.classList.remove("bg-zinc-600", "hover:bg-zinc-500");
    followBtn.classList.add("bg-sky-600", "hover:bg-sky-500");
  } else {
    followBtn.classList.add("bg-zinc-600", "hover:bg-zinc-500");
    followBtn.classList.remove("bg-sky-600", "hover:bg-sky-500");
  }
}

function updateAutoButton() {
  if (state.running) {
    autoToggleBtn.textContent = "Stop Auto Ping";
    autoToggleBtn.classList.remove("bg-indigo-600", "hover:bg-indigo-500");
    autoToggleBtn.classList.add("bg-amber-600", "hover:bg-amber-500");
  } else {
    autoToggleBtn.textContent = "Start Auto Ping";
    autoToggleBtn.classList.add("bg-indigo-600", "hover:bg-indigo-500");
    autoToggleBtn.classList.remove("bg-amber-600", "hover:bg-amber-500");
  }
}

// --- Auto mode ---
function stopAutoPing() {
  if (state.autoTimerId != null) {
    clearInterval(state.autoTimerId);
    state.autoTimerId = null;
  }
  state.running = false;
  updateAutoButton();
  releaseWakeLock();
}

async function startAutoPing() {
  if (!state.connection) {
    alert("Connect to a MeshCore device first.");
    return;
  }

  stopAutoPing();

  state.running = true;
  updateAutoButton();

  await refreshCoverage();
  redrawCoverage();

  // Send first ping immediately, then on interval.
  let intervalMs = 10 * 1000;
  sendPing({ auto: true }).catch(console.error);
  state.autoTimerId = setInterval(() => {
    sendPing({ auto: true }).catch(console.error);
  }, intervalMs);

  await acquireWakeLock();
}

// --- Connection handling ---
async function handleConnect() {
  if (state.connection) {
    return;
  }

  if (!("bluetooth" in navigator)) {
    alert("Web Bluetooth not supported in this browser.");
    return;
  }

  setStatus("Connecting…", "text-sky-300");
  connectBtn.disabled = true;

  try {
    const connection = await WebBleConnection.open();
    state.connection = connection;

    connection.on("connected", onConnected);
    connection.on("disconnected", onDisconnected);
  } catch (e) {
    console.error("Failed to open BLE connection", e);
    setStatus("Failed to connect", "text-red-300");
    updateControlsForConnection(false);
  }
}

async function handleDisconnect() {
  if (!state.connection) return;

  try {
    await state.connection.close();
  } catch (e) {
    console.warn("Error closing connection", e);
  }

  // NB: onDisconnected will be called from the BLE event.
}

async function onConnected() {
  setStatus("Connected (syncing…)", "text-emerald-300");

  try {
    try {
      await state.connection.syncDeviceTime();
    } catch {
      // Might not be supported.
    }

    const selfInfo = await state.connection.getSelfInfo();
    state.selfInfo = selfInfo;
    deviceInfoEl.textContent = selfInfo?.name
      ? `${selfInfo.name}`
      : "[No device]";

    setStatus("Connected", "text-emerald-300");

    // Try to ensure channel exists.
    try {
      await ensureWardriveChannel();
    } catch {
      // Will attempt again on ping.
    }

    // Don't enable ping buttons until after ensure channel.
    updateControlsForConnection(true);
  } catch (e) {
    console.error("Error during initial sync", e);
    setStatus("Connected, Failed init", "text-amber-300");
    await handleDisconnect();
  }
}

function onDisconnected() {
  stopAutoPing();

  deviceInfoEl.textContent = "";
  state.connection = null;
  state.wardriveChannel = null;

  updateControlsForConnection(false);
  setStatus("Disconnected", "text-red-300");
}

// --- Event bindings ---
connectBtn.addEventListener("click", () => {
  if (!state.connection)
    handleConnect().catch(console.error);
  else
    handleDisconnect().catch(console.error);
});

sendPingBtn.addEventListener("click", () => {
  sendPing({ auto: false }).catch(console.error);
});

autoToggleBtn.addEventListener("click", async () => {
  if (state.running) {
    stopAutoPing();
    setStatus("Auto mode stopped", "text-slate-300");
  } else {
    await startAutoPing();
  }
});

ignoredRepeaterBtn.addEventListener("click", promptIgnoredId);

// Automatically release wake lock when the page is hidden.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    releaseWakeLock();
    stopLocationTracking();
  } else {
    await startLocationTracking();

    if (state.running)
      await acquireWakeLock();
  }
});

// Bluefy-specific.
if ('bluetooth' in navigator) {
  navigator.bluetooth.addEventListener('backgroundstatechanged',
    (e) => {
      const isBackground = e.target.value;
      if (isBackground == true && state.running) {
        stopAutoPing();
        setStatus('Lost focus, Stopped', 'text-amber-300');
      }
    });
}

export async function onLoad() {
  try {
    loadPingHistory();
    loadIgnoredId();
    updateControlsForConnection(false);
    updateAutoButton();
    redrawPingHistory();

    await refreshCoverage();
    redrawCoverage();

    await startLocationTracking();
  } catch (e) {
    alert(e);
  }
}
