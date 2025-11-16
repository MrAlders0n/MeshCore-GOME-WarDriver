import { WebBleConnection, Constants } from "/content/mc/index.js";
import { haversineMiles } from "/content/shared.js";

// --- DOM helpers ---
const $ = id => document.getElementById(id);
const statusEl = $("status");
const deviceNameEl = $("deviceName");
const channelInfoEl = $("channelInfo");
const lastSampleInfoEl = $("lastSampleInfo");
const controlsSection = $("controls");
const logBody = $("logBody");
const debugConsole = $("debugConsole");

const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const sendPingBtn = $("sendPingBtn");
const autoToggleBtn = $("autoToggleBtn");
const clearLogBtn = $("clearLogBtn");
const intervalSelect = $("intervalSelect");
const minDistanceSelect = $("minDistanceSelect");

const wardriveChannelName = "#wardrive";

function setStatus(text, color = null) {
  statusEl.textContent = text;
  log(`status: ${text}`);
  if (color) {
    statusEl.className = "font-semibold " + color;
  }
}

function log(msg) {
  // const entry = document.createElement('pre');
  // entry.textContent = msg;
  // debugConsole.appendChild(entry);

  console.log(msg);
}

// --- State ---
const LOG_KEY = "meshcoreWardriveLogV1";

const state = {
  connection: null,
  selfInfo: null,
  wardriveChannel: null,
  autoMode: false,
  autoTimerId: null,
  lastSample: null, // { lat, lon, timestamp }
  wakeLock: null,
  log: [],
};

// --- Utility functions ---
function getIntervalMinutes() {
  return parseFloat(intervalSelect.value || "0");
}

function getMinDistanceMiles() {
  return parseFloat(minDistanceSelect.value || "0");
}

function formatIsoLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// --- Local storage log ---
function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (raw) {
      state.log = JSON.parse(raw);
    }
  } catch (e) {
    console.warn("Failed to load wardrive log", e);
  }
  renderLog();
}

function saveLog() {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(state.log));
  } catch (e) {
    console.warn("Failed to save wardrive log", e);
  }
}

function addLogEntry(entry) {
  state.log.push(entry);
  // Keep it from growing forever
  const maxEntries = 50;
  if (state.log.length > maxEntries) {
    state.log.splice(0, state.log.length - maxEntries);
  }
  saveLog();
  renderLog();
}

function renderLog() {
  logBody.innerHTML = "";
  const rows = state.log.reverse(); // Newest first
  for (const entry of rows) {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-slate-900/60";
    const skipped = entry.skipped ?? false;

    const cells = [
      formatIsoLocal(entry.timestamp),
      entry.lat?.toFixed(4) ?? "",
      entry.lon?.toFixed(4) ?? "",
      entry.mode ?? "",
      entry.distanceMiles != null ? entry.distanceMiles.toFixed(1) : "",
      entry.sentToMesh ? "✅" : skipped ? "⊗" : "❌",
      entry.sentToService ? "✅" : "❌",
      entry.notes ?? "",
    ];

    for (const text of cells) {
      const td = document.createElement("td");
      td.className = "px-2 py-1 align-top";
      td.textContent = text;
      tr.appendChild(td);
    }

    logBody.appendChild(tr);
  }
}

function updateLastSampleInfo() {
  if (!state.lastSample) {
    lastSampleInfoEl.textContent = "None yet";
    return;
  }
  const { lat, lon, timestamp } = state.lastSample;
  lastSampleInfoEl.textContent =
    `${lat.toFixed(4)}, ${lon.toFixed(4)} @ ` + formatIsoLocal(timestamp);
}

// --- Geolocation ---
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
        maximumAge: 0,
        timeout: 20000,
      }
    );
  });
}

// --- WakeLock helpers ---
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

// --- Wardrive channel helpers ---
async function createWardriveChannel() {
  const create = window.confirm(
    `Channel "${wardriveChannelName}" not found on this device. Create it now?`
  );

  if (!create) {
    channelInfoEl.textContent = `No "${wardriveChannelName}" channel; ping disabled.`;
    throw new Error("Wardrive channel not created");
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

  channelInfoEl.textContent = `Using ${channel.name} on slot ${channel.channelIdx}`;
  state.wardriveChannel = channel;
  return channel;
}

// --- Ping logic ---
async function sendPing({ auto = false } = {}) {
  if (!state.connection) {
    setStatus("Not connected", "font-semibold text-red-300");
    return;
  }

  // Get the channel.
  let channel;
  try {
    channel = await ensureWardriveChannel();
  } catch (e) {
    console.warn(`Channel "${wardriveChannelName}" not available`, e);
    setStatus(`No "${wardriveChannelName}" channel`, "font-semibold text-amber-300");
    return;
  }

  setStatus(
    auto ? "Auto ping: getting location…" : "Getting location…",
    "font-semibold text-sky-300");

  // Get the position.
  let pos;
  try {
    pos = await getCurrentPosition();
  } catch (e) {
    console.error("Could not get location", e);
    setStatus("Could not get location", "font-semibold text-red-300");
    addLogEntry({
      timestamp: new Date().toISOString(),
      mode: auto ? "auto" : "manual",
      sentToMesh: false,
      sentToService: false,
      notes: "GPS Fail: " + e.message,
    });
    return;
  }

  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;

  // Ensure minimum distance met for auto ping.
  let distanceMilesValue = null;
  const minMiles = getMinDistanceMiles();
  if (auto && state.lastSample && minMiles > 0) {
    distanceMilesValue = haversineMiles(
      [state.lastSample.lat, state.lastSample.lon], [lat, lon]);
    if (distanceMilesValue < minMiles) {
      log(`Min distance not met ${distanceMilesValue}, skipping.`);
      setStatus("Skipped ping", "font-semibold text-amber-300");
      addLogEntry({
        timestamp: new Date().toISOString(),
        lat,
        lon,
        mode: "auto",
        distanceMiles: distanceMilesValue,
        skipped: true,
        sentToMesh: false,
        sentToService: false,
      });
      return;
    }
  }

  const text = `${lat.toFixed(4)} ${lon.toFixed(4)}`;
  let sentToMesh = false;
  let sentToService = false;
  let notes = "";

  try {
    // Send mesh message: "<lat> <lon>".
    await state.connection.sendChannelTextMessage(channel.channelIdx, text);
    sentToMesh = true;
    log("Sent MeshCore wardrive ping:", text);
  } catch (e) {
    console.error("Mesh send failed", e);
    setStatus("Mesh send failed", "font-semibold text-red-300");
    notes = "Mesh Fail: " + e.message;
  }

  if (sentToMesh) {
    // Send sample to service.
    try {
      await fetch("https://mesh-map.pages.dev/put-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lon }),
      });
      sentToService = true;
    } catch (e) {
      console.error("Service POST failed", e);
      setStatus("Web send failed", "font-semibold text-red-300");
      notes = "Web Fail: " + e.message;
    }

    // Even if sending the sample POST failed, consider this
    // the new 'last sample' to avoid spam.
    const nowIso = new Date().toISOString();
    state.lastSample = { lat, lon, timestamp: nowIso };
    updateLastSampleInfo();
  }

  // Log result.
  const entry = {
    timestamp: new Date().toISOString(),
    lat,
    lon,
    mode: auto ? "auto" : "manual",
    distanceMiles: distanceMilesValue,
    sentToMesh,
    sentToService,
    notes,
  };

  addLogEntry(entry);

  if (sentToMesh) {
    setStatus(auto ? "Auto ping sent" : "Ping sent", "font-semibold text-emerald-300");
  }
}

// --- Auto mode ---
function updateAutoButton() {
  if (state.autoMode) {
    autoToggleBtn.textContent = "Stop Auto Ping";
    autoToggleBtn.classList.remove("bg-indigo-600", "hover:bg-indigo-500");
    autoToggleBtn.classList.add("bg-amber-600", "hover:bg-amber-500");
  } else {
    autoToggleBtn.textContent = "Start Auto Ping";
    autoToggleBtn.classList.add("bg-indigo-600", "hover:bg-indigo-500");
    autoToggleBtn.classList.remove("bg-amber-600", "hover:bg-amber-500");
  }
}

function stopAutoMode() {
  if (state.autoTimerId != null) {
    clearInterval(state.autoTimerId);
    state.autoTimerId = null;
  }
  state.autoMode = false;
  updateAutoButton();
}

function startAutoMode() {
  if (!state.connection) {
    alert("Connect to a MeshCore device first.");
    return;
  }

  const minutes = getIntervalMinutes();
  if (!minutes || minutes <= 0) {
    alert("Please choose a valid ping interval.");
    return;
  }

  stopAutoMode();

  state.autoMode = true;
  updateAutoButton();

  const intervalMs = minutes * 60 * 1000;
  setStatus("Auto mode started", "font-semibold text-emerald-300");

  // Send first ping immediately, then on interval.
  sendPing({ auto: true }).catch(console.error);
  state.autoTimerId = setInterval(() => {
    sendPing({ auto: true }).catch(console.error);
  }, intervalMs);
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

  setStatus("Connecting…", "font-semibold text-sky-300");
  connectBtn.disabled = true;

  try {
    const connection = await WebBleConnection.open();
    state.connection = connection;

    connection.on("connected", onConnected);
    connection.on("disconnected", onDisconnected);
  } catch (e) {
    console.error("Failed to open BLE connection", e);
    setStatus("Failed to connect", "font-semibold text-red-300");
    connectBtn.disabled = false;
  }
}

async function handleDisconnect() {
  if (!state.connection) return;
  try {
    await state.connection.close();
  } catch (e) {
    console.warn("Error closing connection", e);
  }
  // onDisconnected will be called from the BLE event
}

async function onConnected() {
  setStatus("Connected (syncing…)", "font-semibold text-emerald-300");
  disconnectBtn.disabled = false;
  connectBtn.disabled = true;
  controlsSection.classList.remove("hidden");

  try {
    try {
      await state.connection.syncDeviceTime();
    } catch {
      // Might not be supported.
    }

    const selfInfo = await state.connection.getSelfInfo();
    state.selfInfo = selfInfo;
    deviceNameEl.textContent = selfInfo?.name
      ? `Device: ${selfInfo.name}`
      : "Device connected";
    setStatus(
      `Connected to ${selfInfo?.name ?? "MeshCore"}`,
      "font-semibold text-emerald-300"
    );

    // Try to ensure channel exists.
    try {
      await ensureWardriveChannel();
    } catch {
      // Will attempt again on ping.
    }
  } catch (e) {
    console.error("Error during initial sync", e);
    setStatus("Connected, but failed to init", "font-semibold text-amber-300");
    await handleDisconnect();
  }
}

function onDisconnected() {
  stopAutoMode();

  deviceNameEl.textContent = "";
  channelInfoEl.textContent = "";
  disconnectBtn.disabled = true;
  connectBtn.disabled = false;
  controlsSection.classList.add("hidden");

  state.connection = null;
  state.wardriveChannel = null;

  log("Disconnected");
  setStatus("Disconnected", "font-semibold text-red-300");
}

// --- Event bindings ---
connectBtn.addEventListener("click", () => {
  handleConnect().catch(console.error);
});

disconnectBtn.addEventListener("click", () => {
  handleDisconnect().catch(console.error);
});

sendPingBtn.addEventListener("click", () => {
  sendPing({ auto: false }).catch(console.error);
});

autoToggleBtn.addEventListener("click", async () => {
  if (state.autoMode) {
    stopAutoMode();
    releaseWakeLock();
    setStatus("Auto mode stopped", "font-semibold text-slate-300");
  } else {
    startAutoMode();
    await acquireWakeLock();
  }
});

clearLogBtn.addEventListener("click", () => {
  if (!confirm("Clear local wardrive log?")) return;
  state.log = [];
  state.lastSample = null;
  updateLastSampleInfo();
  saveLog();
  renderLog();
});

// Automatically release wake lock when the page is hidden.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    releaseWakeLock();
  } else if (!document.hidden && state.autoMode) {
    await acquireWakeLock();
  }
});

// Bluefy-specific.
if ('bluetooth' in navigator) {
  navigator.bluetooth.addEventListener('backgroundstatechanged',
    (e) => {
      log(JSON.stringify(e, 2));
      const isBackground = e.target.value;
      if (isBackground == true && state.autoMode) {
        stopAutoMode();
        setStatus('Lost focus, Stopped');
      }
    });
}

export async function onLoad() {
  loadLog();
  updateLastSampleInfo();
  updateAutoButton();
}