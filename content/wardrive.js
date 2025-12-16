
// Minimal Wardrive sender with wake locks:
// - Connect to MeshCore Companion via Web Bluetooth (BLE)
// - Send pings as "@[MapperBot]<LAT LON>" to the configured channel
// - Manual "Send Ping" and Auto mode (every 30s)
// - Acquire wake lock during auto mode to keep screen awake

import { WebBleConnection } from "/content/mc/index.js"; // your BLE client

// ---- Config ----
const CHANNEL_NAME     = "#wardriving";        // change to "#wardrive" if needed
const PING_INTERVAL_MS = 30 * 1000;
const PING_PREFIX      = "@[MapperBot]";
const WARDROVE_KEY     = new Uint8Array([
  0x40, 0x76, 0xC3, 0x15, 0xC1, 0xEF, 0x38, 0x5F,
  0xA9, 0x3F, 0x06, 0x60, 0x27, 0x32, 0x0F, 0xE5
]);

// ---- DOM refs (from your index.html; unchanged) ----
const $ = (id) => document.getElementById(id);
const statusEl      = $("status");
const deviceInfoEl  = $("deviceInfo");
const channelInfoEl = $("channelInfo");
const connectBtn    = $("connectBtn");
const sendPingBtn   = $("sendPingBtn");
const autoToggleBtn = $("autoToggleBtn");
const lastPingEl    = $("lastPing");
const sessionPingsEl= document.getElementById("sessionPings"); // optional

// ---- State ----
const state = {
  connection: null,
  channel: null,
  autoTimerId: null,
  running: false,
  wakeLock: null,          // holds the wake lock object (if supported)
  bluefyLockEnabled: false // tracks Bluefy screen-dim setting
};

// ---- UI helpers ----
function setStatus(text, color = "text-slate-300") {
  statusEl.textContent = text;
  statusEl.className = `font-semibold ${color}`;
}
function enableControls(connected) {
  connectBtn.disabled     = false;
  sendPingBtn.disabled    = !connected;
  autoToggleBtn.disabled  = !connected;
  channelInfoEl.textContent = CHANNEL_NAME;
}
function updateAutoButton() {
  if (state.running) {
    autoToggleBtn.textContent = "Stop Auto Ping";
    autoToggleBtn.classList.remove("bg-indigo-600","hover:bg-indigo-500");
    autoToggleBtn.classList.add("bg-amber-600","hover:bg-amber-500");
  } else {
    autoToggleBtn.textContent = "Start Auto Ping";
    autoToggleBtn.classList.add("bg-indigo-600","hover:bg-indigo-500");
    autoToggleBtn.classList.remove("bg-amber-600","hover:bg-amber-500");
  }
}

// ---- Wake Lock helpers ----
async function acquireWakeLock() {
  // Bluefy: prevents screen dim/lock when available
  if (navigator.bluetooth && typeof navigator.bluetooth.setScreenDimEnabled === "function") {
    try {
      navigator.bluetooth.setScreenDimEnabled(true);
      state.bluefyLockEnabled = true;
      console.log("Bluefy screen-dim prevention enabled");
      return;
    } catch (e) {
      console.warn("Bluefy setScreenDimEnabled failed:", e);
    }
  }

  // Standard Wake Lock API
  try {
    if ("wakeLock" in navigator && typeof navigator.wakeLock.request === "function") {
      state.wakeLock = await navigator.wakeLock.request("screen");
      console.log("Wake lock acquired");
      state.wakeLock.addEventListener?.("release", () => {
        console.log("Wake lock released");
      });
    } else {
      console.log("Wake Lock API not supported");
    }
  } catch (err) {
    console.error(`Could not obtain wake lock: ${err.name}, ${err.message}`);
  }
}

async function releaseWakeLock() {
  // Bluefy off
  if (state.bluefyLockEnabled && navigator.bluetooth && typeof navigator.bluetooth.setScreenDimEnabled === "function") {
    try {
      navigator.bluetooth.setScreenDimEnabled(false);
      state.bluefyLockEnabled = false;
      console.log("Bluefy screen-dim prevention disabled");
    } catch (e) {
      console.warn("Bluefy setScreenDimEnabled(false) failed:", e);
    }
  }

  // Standard Wake Lock release
  try {
    if (state.wakeLock) {
      await state.wakeLock.release?.();
      state.wakeLock = null;
    }
  } catch (e) {
    console.warn("Error releasing wake lock:", e);
    state.wakeLock = null;
  }
}

// ---- Geolocation ----
async function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => reject(err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 8000 }
    );
  });
}

// ---- Channel helpers ----
async function ensureChannel() {
  if (!state.connection) throw new Error("Not connected");
  if (state.channel) return state.channel;

  let ch = await state.connection.findChannelByName(CHANNEL_NAME);
  if (!ch) {
    const channels = await state.connection.getChannels();
    const freeIdx = channels.findIndex(c => !c.name || c.name === "");
    if (freeIdx < 0) throw new Error("No free channel slots available");
    await state.connection.setChannel(freeIdx, CHANNEL_NAME, WARDROVE_KEY);
    ch = { channelIdx: freeIdx, name: CHANNEL_NAME };
  }
  state.channel = ch;
  channelInfoEl.textContent = `${CHANNEL_NAME} (CH:${ch.channelIdx})`;
  return ch;
}

// ---- Ping ----
async function sendPing(manual = false) {
  try {
    const pos = await getCurrentPosition();
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    // Exact format: "@[MapperBot]<GPS COORD>"
    // Using "LAT LON" with a space; change to comma if needed.
    const coordsStr = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    const payload = `${PING_PREFIX}<${coordsStr}>`;

    const ch = await ensureChannel();
    await state.connection.sendChannelTextMessage(ch.channelIdx, payload);

    const nowStr = new Date().toLocaleString();
    setStatus(manual ? "Ping sent" : "Auto ping sent", "text-emerald-300");
    if (lastPingEl) lastPingEl.textContent = `${nowStr} — ${payload}`;

    // Optional session log
    if (sessionPingsEl) {
      const line = `${nowStr}  ${coordsStr}`;
      sessionPingsEl.textContent = sessionPingsEl.textContent
        ? sessionPingsEl.textContent + "\n" + line
        : line;
      sessionPingsEl.scrollTop = sessionPingsEl.scrollHeight;
    }
  } catch (e) {
    console.error("Ping failed:", e);
    setStatus("Ping failed", "text-red-300");
  }
}

// ---- Auto mode ----
function stopAutoPing() {
  if (state.autoTimerId) {
    clearInterval(state.autoTimerId);
    state.autoTimerId = null;
  }
  state.running = false;
  updateAutoButton();
  releaseWakeLock();
}
function startAutoPing() {
  if (!state.connection) {
    alert("Connect to a MeshCore device first.");
    return;
  }
  stopAutoPing();
  state.running = true;
  updateAutoButton();

  // Acquire wake lock for auto mode
  acquireWakeLock().catch(console.error);

  // First ping immediately, then every 30s
  sendPing(false).catch(console.error);
  state.autoTimerId = setInterval(() => {
    sendPing(false).catch(console.error);
  }, PING_INTERVAL_MS);
}

// ---- BLE connect / disconnect ----
async function connect() {
  if (!("bluetooth" in navigator)) {
    alert("Web Bluetooth not supported in this browser.");
    return;
  }
  connectBtn.disabled = true;
  setStatus("Connecting…", "text-sky-300");

  try {
    const conn = await WebBleConnection.open();
    state.connection = conn;

    conn.on("connected", async () => {
      setStatus("Connected", "text-emerald-300");
      connectBtn.disabled = false;
      const selfInfo = await conn.getSelfInfo();
      deviceInfoEl.textContent = selfInfo?.name || "[No device]";
      enableControls(true);
      updateAutoButton();
      try { await conn.syncDeviceTime?.(); } catch { /* optional */ }
      await ensureChannel();
    });

    conn.on("disconnected", () => {
      setStatus("Disconnected", "text-red-300");
      deviceInfoEl.textContent = "—";
      state.connection = null;
      state.channel = null;
      stopAutoPing();           // ensures wake lock is released
      enableControls(false);
      updateAutoButton();
    });

  } catch (e) {
    console.error("BLE connect failed:", e);
    setStatus("Failed to connect", "text-red-300");
    connectBtn.disabled = false;
  }
}

// ---- Page visibility: release when hidden, reacquire on return ----
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    // On hidden, stop auto mode and release lock
    if (state.running) {
      stopAutoPing();
      setStatus("Lost focus, auto mode stopped", "text-amber-300");
    } else {
      releaseWakeLock();
    }
  } else {
    // On visible, if user left auto mode on previously, they can re-start it;
    // we do not auto restart to avoid surprise behavior.
    // You can auto-reacquire wake lock here if state.running is true.
  }
});

// ---- Bind UI & init ----
export async function onLoad() {
  setStatus("Disconnected", "text-red-300");
  enableControls(false);
  updateAutoButton();

  connectBtn.addEventListener("click", () => connect().catch(console.error));
  sendPingBtn.addEventListener("click", () => sendPing(true).catch(console.error));
  autoToggleBtn.addEventListener("click", () => {
    if (state.running) {
      stopAutoPing();
      setStatus("Auto mode stopped", "text-slate-300");
    } else {
      startAutoPing();
    }
  });

  // Prompt location permission early (optional)
  try { await getCurrentPosition(); } catch { /* will prompt at first send */ }
}
