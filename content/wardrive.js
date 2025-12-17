
// Minimal Wardrive sender with wake locks:
// - Connect to MeshCore Companion via Web Bluetooth (BLE)
// - Send pings as "@[MapperBot]<LAT LON>[ <power> ]" (power only if specified)
// - Manual "Send Ping" and Auto mode (interval selectable: 15/30/60s)
// - Acquire wake lock during auto mode to keep screen awake

import { WebBleConnection } from "/content/mc/index.js"; // your BLE client

// ---- Config ----
const CHANNEL_NAME     = "#wardriving";        // change to "#wardrive" if needed
const DEFAULT_INTERVAL_S = 30;                 // fallback if selector unavailable
const PING_PREFIX      = "@[MapperBot]";
const GPS_FRESHNESS_BUFFER_MS = 5000;          // Buffer time for GPS freshness checks
const GPS_ACCURACY_THRESHOLD_M = 100;          // Maximum acceptable GPS accuracy in meters
const WARDROVE_KEY     = new Uint8Array([
  0x40, 0x76, 0xC3, 0x15, 0xC1, 0xEF, 0x38, 0x5F,
  0xA9, 0x3F, 0x06, 0x60, 0x27, 0x32, 0x0F, 0xE5
]);

// ---- DOM refs (from index.html; unchanged except the two new selectors) ----
const $ = (id) => document.getElementById(id);
const statusEl       = $("status");
const deviceInfoEl   = $("deviceInfo");
const channelInfoEl  = $("channelInfo");
const connectBtn     = $("connectBtn");
const sendPingBtn    = $("sendPingBtn");
const autoToggleBtn  = $("autoToggleBtn");
const lastPingEl     = $("lastPing");
const gpsInfoEl = document.getElementById("gpsInfo");
const gpsAccEl = document.getElementById("gpsAcc");
const sessionPingsEl = document.getElementById("sessionPings"); // optional
const coverageFrameEl = document.getElementById("coverageFrame");
setConnectButton(false);

// NEW: selectors
const intervalSelect = $("intervalSelect"); // 15 / 30 / 60 seconds
const powerSelect    = $("powerSelect");    // "", "0.3w", "0.6w", "1.0w"

// ---- State ----
const state = {
  connection: null,
  channel: null,
  autoTimerId: null,
  running: false,
  wakeLock: null,
  geoWatchId: null,
  lastFix: null, // { lat, lon, accM, tsMs }
  bluefyLockEnabled: false,
  gpsState: "idle", // "idle", "acquiring", "acquired", "error"
  gpsAgeUpdateTimer: null // Timer for updating GPS age display
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
function buildCoverageEmbedUrl(lat, lon) {
  const base =
    "https://yow.meshmapper.net/embed.php?cov_grid=1&fail_grid=1&pings=0&repeaters=1&rep_coverage=0&grid_lines=0&meters=1500";
  return `${base}&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
}
let coverageRefreshTimer = null;
function scheduleCoverageRefresh(lat, lon) {
  if (!coverageFrameEl) return;

  if (coverageRefreshTimer) clearTimeout(coverageRefreshTimer);

  coverageRefreshTimer = setTimeout(() => {
    const url = buildCoverageEmbedUrl(lat, lon);
    console.log("Coverage iframe URL:", url);
    coverageFrameEl.src = url;
  }, 5000);
}
function setConnectButton(connected) {
  if (!connectBtn) return;
  if (connected) {
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.remove(
      "bg-emerald-600",
      "hover:bg-emerald-500"
    );
    connectBtn.classList.add(
      "bg-red-600",
      "hover:bg-red-500"
    );
  } else {
    connectBtn.textContent = "Connect";
    connectBtn.classList.remove(
      "bg-red-600",
      "hover:bg-red-500"
    );
    connectBtn.classList.add(
      "bg-emerald-600",
      "hover:bg-emerald-500"
    );
  }
}



// ---- Wake Lock helpers ----
async function acquireWakeLock() {
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
  try {
    if ("wakeLock" in navigator && typeof navigator.wakeLock.request === "function") {
      state.wakeLock = await navigator.wakeLock.request("screen");
      console.log("Wake lock acquired");
      state.wakeLock.addEventListener?.("release", () => console.log("Wake lock released"));
    } else {
      console.log("Wake Lock API not supported");
    }
  } catch (err) {
    console.error(`Could not obtain wake lock: ${err.name}, ${err.message}`);
  }
}
async function releaseWakeLock() {
  if (state.bluefyLockEnabled && navigator.bluetooth && typeof navigator.bluetooth.setScreenDimEnabled === "function") {
    try {
      navigator.bluetooth.setScreenDimEnabled(false);
      state.bluefyLockEnabled = false;
      console.log("Bluefy screen-dim prevention disabled");
    } catch (e) {
      console.warn("Bluefy setScreenDimEnabled(false) failed:", e);
    }
  }
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
      { 
        enableHighAccuracy: true, 
        maximumAge: getGpsMaximumAge(1000), // Fresh data for one-off requests
        timeout: 30000 
      }
    );
  });
}
function updateGpsUi() {
  if (!gpsInfoEl || !gpsAccEl) return;

  if (!state.lastFix) {
    // Show different messages based on GPS state
    if (state.gpsState === "acquiring") {
      gpsInfoEl.textContent = "Acquiring GPS fix...";
      gpsAccEl.textContent = "Please wait";
    } else if (state.gpsState === "error") {
      gpsInfoEl.textContent = "GPS error - check permissions";
      gpsAccEl.textContent = "-";
    } else {
      gpsInfoEl.textContent = "-";
      gpsAccEl.textContent = "-";
    }
    return;
  }

  const { lat, lon, accM, tsMs } = state.lastFix;
  const ageSec = Math.max(0, Math.round((Date.now() - tsMs) / 1000));

  state.gpsState = "acquired";
  gpsInfoEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} (${ageSec}s ago)`;
  gpsAccEl.textContent = accM ? `±${Math.round(accM)} m` : "-";
}

// Start continuous GPS age display updates
function startGpsAgeUpdater() {
  if (state.gpsAgeUpdateTimer) return;
  state.gpsAgeUpdateTimer = setInterval(() => {
    updateGpsUi();
  }, 1000); // Update every second
}

// Stop GPS age display updates
function stopGpsAgeUpdater() {
  if (state.gpsAgeUpdateTimer) {
    clearInterval(state.gpsAgeUpdateTimer);
    state.gpsAgeUpdateTimer = null;
  }
}
function startGeoWatch() {
  if (state.geoWatchId) return;
  if (!("geolocation" in navigator)) return;

  state.gpsState = "acquiring";
  updateGpsUi();
  startGpsAgeUpdater(); // Start the age counter

  state.geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.lastFix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accM: pos.coords.accuracy,
        tsMs: Date.now(),
      };
      state.gpsState = "acquired";
      updateGpsUi();
    },
    (err) => {
      console.warn("watchPosition error:", err);
      state.gpsState = "error";
      // Keep UI honest if it fails
      updateGpsUi();
    },
    { 
      enableHighAccuracy: true, 
      maximumAge: getGpsMaximumAge(5000), // Continuous watch, minimum 5s
      timeout: 30000 
    }
  );
}
function stopGeoWatch() {
  if (!state.geoWatchId) return;
  navigator.geolocation.clearWatch(state.geoWatchId);
  state.geoWatchId = null;
  stopGpsAgeUpdater(); // Stop the age counter
}
async function primeGpsOnce() {
  // Start continuous watch so the UI keeps updating
  startGeoWatch();

  state.gpsState = "acquiring";
  updateGpsUi();

  try {
    const pos = await getCurrentPosition();

    state.lastFix = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accM: pos.coords.accuracy,
      tsMs: Date.now(),
    };

    state.gpsState = "acquired";
    updateGpsUi();

    // Only refresh the coverage map if we have an accurate fix
    if (state.lastFix.accM && state.lastFix.accM < GPS_ACCURACY_THRESHOLD_M) {
      scheduleCoverageRefresh(
        state.lastFix.lat,
        state.lastFix.lon
      );
    }

  } catch (e) {
    console.warn("primeGpsOnce failed:", e);
    state.gpsState = "error";
    updateGpsUi();
  }
}



// ---- Channel helpers ----
async function ensureChannel() {
  if (!state.connection) throw new Error("Not connected");
  if (state.channel) return state.channel;

  const ch = await state.connection.findChannelByName(CHANNEL_NAME);
  if (!ch) {
    enableControls(false);
    throw new Error(
      `Channel ${CHANNEL_NAME} not found. Join it on your companion first.`
    );
  }

  state.channel = ch;
  enableControls(true);
  channelInfoEl.textContent = `${CHANNEL_NAME} (CH:${ch.channelIdx})`;
  return ch;
}


// ---- Helpers: interval & payload ----
function getSelectedIntervalMs() {
  const checked = document.querySelector('input[name="interval"]:checked');
  const s = checked ? Number(checked.value) : 30;
  const clamped = [15, 30, 60].includes(s) ? s : 30;
  return clamped * 1000;
}

// Calculate GPS maximumAge based on selected interval
// Returns how old cached GPS data can be before requesting a fresh position.
// Subtracts GPS_FRESHNESS_BUFFER_MS to ensure new data before the interval expires.
// Math.max ensures we never return negative or too-small values.
function getGpsMaximumAge(minAge = 1000) {
  const intervalMs = getSelectedIntervalMs();
  return Math.max(minAge, intervalMs - GPS_FRESHNESS_BUFFER_MS);
}

function buildPayload(lat, lon) {
  const coordsStr = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const checkedPower = document.querySelector('input[name="power"]:checked');
  const power = checkedPower ? checkedPower.value : "";
   const suffix = power ? ` [${power}]` : "";
  return `${PING_PREFIX} ${coordsStr} ${suffix}`;
}

// ---- Ping ----
async function sendPing(manual = false) {
  try {
    let lat, lon, accuracy;

    // Use the selected interval to determine if GPS fix is fresh enough
    const intervalMs = getSelectedIntervalMs();
    const maxAge = intervalMs + GPS_FRESHNESS_BUFFER_MS; // Allow buffer beyond interval

    if (state.lastFix && (Date.now() - state.lastFix.tsMs) < maxAge) {
      lat = state.lastFix.lat;
      lon = state.lastFix.lon;
      accuracy = state.lastFix.accM;
    } else {
      // Get fresh GPS coordinates
      const pos = await getCurrentPosition();
      lat = pos.coords.latitude;
      lon = pos.coords.longitude;
      accuracy = pos.coords.accuracy;
      state.lastFix = {
        lat,
        lon,
        accM: accuracy,
        tsMs: Date.now(),
      };
      updateGpsUi();
    }

    const payload = buildPayload(lat, lon);

    const ch = await ensureChannel();
    await state.connection.sendChannelTextMessage(ch.channelIdx, payload);

    // Only refresh coverage iframe if GPS accuracy is good
    if (accuracy && accuracy < GPS_ACCURACY_THRESHOLD_M) {
      scheduleCoverageRefresh(lat, lon);
    }

    const nowStr = new Date().toLocaleString();
    setStatus(manual ? "Ping sent" : "Auto ping sent", "text-emerald-300");
    if (lastPingEl) lastPingEl.textContent = `${nowStr} — ${payload}`;

    // Session log
    if (sessionPingsEl) {
      const line = `${nowStr}  ${lat.toFixed(5)} ${lon.toFixed(5)}`;
      const li = document.createElement('li');
      li.textContent = line;
      sessionPingsEl.appendChild(li);
       // Auto-scroll to bottom when a new entry arrives
      sessionPingsEl.scrollTop = sessionPingsEl.scrollHeight;
    }
  } catch (e) {
    console.error("Ping failed:", e);
    setStatus(e.message || "Ping failed", "text-red-300");
  }
}

// ---- Auto mode ----
function stopAutoPing() {
  if (state.autoTimerId) {
    clearInterval(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopGeoWatch();
  state.running = false;
  updateAutoButton();
  releaseWakeLock();
}
function startAutoPing() {
  if (!state.connection) {
    alert("Connect to a MeshCore device first.");
    return;
  }
  startGeoWatch();
  stopAutoPing();
  state.running = true;
  updateAutoButton();

  // Acquire wake lock for auto mode
  acquireWakeLock().catch(console.error);

  // First ping immediately, then at selected interval
  sendPing(false).catch(console.error);
  const intervalMs = getSelectedIntervalMs();
  state.autoTimerId = setInterval(() => {
    sendPing(false).catch(console.error);
  }, intervalMs);
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
      setConnectButton(true);
      connectBtn.disabled = false;
      const selfInfo = await conn.getSelfInfo();
      deviceInfoEl.textContent = selfInfo?.name || "[No device]";
      updateAutoButton();
      try { await conn.syncDeviceTime?.(); } catch { /* optional */ }
      try {
        await ensureChannel();
        await primeGpsOnce();
      } catch (e) {
        console.error("Channel setup failed:", e);
        setStatus(e.message || "Channel setup failed", "text-red-300");
      }
    });

    conn.on("disconnected", () => {
      setStatus("Disconnected", "text-red-300");
      setConnectButton(false);
      deviceInfoEl.textContent = "—";
      state.connection = null;
      state.channel = null;
      stopAutoPing();
      enableControls(false);
      updateAutoButton();
      stopGeoWatch();
      stopGpsAgeUpdater(); // Ensure age updater stops
      state.lastFix = null;
      state.gpsState = "idle";
      updateGpsUi();
    });

  } catch (e) {
    console.error("BLE connect failed:", e);
    setStatus("Failed to connect", "text-red-300");
    connectBtn.disabled = false;
  }
}
async function disconnect() {
  if (!state.connection) return;

  connectBtn.disabled = true;
  setStatus("Disconnecting...", "text-sky-300");

  try {
    // WebBleConnection typically exposes one of these.
    if (typeof state.connection.close === "function") {
      await state.connection.close();
    } else if (typeof state.connection.disconnect === "function") {
      await state.connection.disconnect();
    } else if (typeof state.connection.device?.gatt?.disconnect === "function") {
      state.connection.device.gatt.disconnect();
    } else {
      console.warn("No known disconnect method on connection object");
    }
  } catch (e) {
    console.error("BLE disconnect failed:", e);
    setStatus(e.message || "Disconnect failed", "text-red-300");
  } finally {
    connectBtn.disabled = false;
  }
}


// ---- Page visibility ----
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    if (state.running) {
      stopAutoPing();
      setStatus("Lost focus, auto mode stopped", "text-amber-300");
    } else {
      releaseWakeLock();
    }
  } else {
    // On visible again, user can manually re-start Auto.
  }
});

// ---- Bind UI & init ----
export async function onLoad() {
  setStatus("Disconnected", "text-red-300");
  enableControls(false);
  updateAutoButton();

  connectBtn.addEventListener("click", async () => {
    try {
      if (state.connection) {
        await disconnect();
      } else {
        await connect();
      }
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Connection error", "text-red-300");
    }
  });
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
