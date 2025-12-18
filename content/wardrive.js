// ==========================================
// DEBUG FLAG & LOGGING HELPER
// ==========================================
const DEBUG_LOG = true; // Set to false to disable debug logging

function debugLog(...args) {
  if (DEBUG_LOG) {
    console.log('[DEBUG]', ...args);
  }
}

// ==========================================
// Minimal Wardrive sender with wake locks:
// - Connect to MeshCore Companion via Web Bluetooth (BLE)
// - Send pings as "@[MapperBot]<LAT LON>[ <power> ]" (power only if specified)
// - Manual "Send Ping" and Auto mode (interval selectable: 15/30/60s)
// - Acquire wake lock during auto mode to keep screen awake
// ==========================================

import { WebBleConnection } from "/content/mc/index.js"; // your BLE client

// ---- Config ----
const CHANNEL_NAME     = "#wardriving";        // change to "#wardrive" if needed
const DEFAULT_INTERVAL_S = 30;                 // fallback if selector unavailable
const PING_PREFIX      = "@[MapperBot]";
const GPS_FRESHNESS_BUFFER_MS = 5000;          // Buffer time for GPS freshness checks
const GPS_ACCURACY_THRESHOLD_M = 100;          // Maximum acceptable GPS accuracy in meters
const MESHMAPPER_DELAY_MS = 7000;              // Delay MeshMapper API call by 7 seconds
const COOLDOWN_MS = 7000;                      // Cooldown period for manual ping and auto toggle
const STATUS_UPDATE_DELAY_MS = 100;            // Brief delay to ensure "Ping sent" status is visible
const MAP_REFRESH_DELAY_MS = 1000;             // Delay after API post to ensure backend updated
const WARDROVE_KEY     = new Uint8Array([
  0x40, 0x76, 0xC3, 0x15, 0xC1, 0xEF, 0x38, 0x5F,
  0xA9, 0x3F, 0x06, 0x60, 0x27, 0x32, 0x0F, 0xE5
]);

// MeshMapper API Configuration
const MESHMAPPER_API_URL = "https://yow.meshmapper.net/wardriving-api.php";
const MESHMAPPER_API_KEY = "59C7754DABDF5C11CA5F5D8368F89";
const MESHMAPPER_DEFAULT_WHO = "GOME-WarDriver"; // Default identifier

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
  gpsAgeUpdateTimer: null, // Timer for updating GPS age display
  meshMapperTimer: null, // Timer for delayed MeshMapper API call
  cooldownEndTime: null, // Timestamp when cooldown period ends
  cooldownUpdateTimer: null, // Timer to re-enable controls after cooldown
  autoCountdownTimer: null, // Timer for auto-ping countdown display
  nextAutoPingTime: null, // Timestamp when next auto-ping will occur
  apiCountdownTimer: null, // Timer for API post countdown display
  apiPostTime: null // Timestamp when API post will occur
};

// ---- UI helpers ----
function setStatus(text, color = "text-slate-300") {
  debugLog('setStatus:', text, 'color:', color);
  statusEl.textContent = text;
  statusEl.className = `font-semibold ${color}`;
}
function updateAutoCountdownStatus() {
  if (!state.running || !state.nextAutoPingTime) {
    debugLog('updateAutoCountdownStatus: skipping (not running or no next ping time)');
    return;
  }
  
  const remainingMs = state.nextAutoPingTime - Date.now();
  if (remainingMs <= 0) {
    debugLog('updateAutoCountdownStatus: sending auto ping now');
    setStatus("Sending auto ping...", "text-sky-300");
    return;
  }
  
  const remainingSec = Math.ceil(remainingMs / 1000);
  debugLog('updateAutoCountdownStatus: countdown', remainingSec, 'seconds');
  setStatus(`Waiting for next auto ping (${remainingSec}s)`, "text-slate-300");
}
function startAutoCountdown(intervalMs) {
  debugLog('startAutoCountdown: interval', intervalMs, 'ms');
  // Stop any existing countdown
  stopAutoCountdown();
  
  // Set the next ping time
  state.nextAutoPingTime = Date.now() + intervalMs;
  
  // Update immediately
  updateAutoCountdownStatus();
  
  // Update every second
  state.autoCountdownTimer = setInterval(() => {
    updateAutoCountdownStatus();
  }, 1000);
  debugLog('startAutoCountdown: countdown timer started');
}
function stopAutoCountdown() {
  debugLog('stopAutoCountdown: clearing countdown timer');
  if (state.autoCountdownTimer) {
    clearInterval(state.autoCountdownTimer);
    state.autoCountdownTimer = null;
  }
  state.nextAutoPingTime = null;
}
function updateApiCountdownStatus() {
  if (!state.apiPostTime) {
    debugLog('updateApiCountdownStatus: no API post time set');
    return;
  }
  
  const remainingMs = state.apiPostTime - Date.now();
  if (remainingMs <= 0) {
    debugLog('updateApiCountdownStatus: posting to API now');
    setStatus("Posting to API...", "text-sky-300");
    return;
  }
  
  const remainingSec = Math.ceil(remainingMs / 1000);
  debugLog('updateApiCountdownStatus: API post countdown', remainingSec, 'seconds');
  setStatus(`Wait to post API (${remainingSec}s)`, "text-sky-300");
}
function startApiCountdown(delayMs) {
  debugLog('startApiCountdown: delay', delayMs, 'ms');
  // Stop any existing countdown
  stopApiCountdown();
  
  // Set the API post time
  state.apiPostTime = Date.now() + delayMs;
  
  // Update immediately
  updateApiCountdownStatus();
  
  // Update every second
  state.apiCountdownTimer = setInterval(() => {
    updateApiCountdownStatus();
  }, 1000);
  debugLog('startApiCountdown: API countdown timer started');
}
function stopApiCountdown() {
  debugLog('stopApiCountdown: clearing API countdown timer');
  if (state.apiCountdownTimer) {
    clearInterval(state.apiCountdownTimer);
    state.apiCountdownTimer = null;
  }
  state.apiPostTime = null;
}
function isInCooldown() {
  const inCooldown = state.cooldownEndTime && Date.now() < state.cooldownEndTime;
  debugLog('isInCooldown:', inCooldown, 'cooldownEndTime:', state.cooldownEndTime);
  return inCooldown;
}
function startCooldown() {
  debugLog('startCooldown: starting', COOLDOWN_MS, 'ms cooldown period');
  state.cooldownEndTime = Date.now() + COOLDOWN_MS;
  updateControlsForCooldown();
  
  // Clear any existing cooldown update and schedule a new one
  if (state.cooldownUpdateTimer) {
    clearTimeout(state.cooldownUpdateTimer);
  }
  state.cooldownUpdateTimer = setTimeout(() => {
    debugLog('startCooldown: cooldown period ended');
    state.cooldownEndTime = null;
    updateControlsForCooldown();
  }, COOLDOWN_MS);
}
function updateControlsForCooldown() {
  const connected = !!state.connection;
  const inCooldown = isInCooldown();
  debugLog('updateControlsForCooldown: connected:', connected, 'inCooldown:', inCooldown);
  sendPingBtn.disabled = !connected || inCooldown;
  autoToggleBtn.disabled = !connected || inCooldown;
}
function enableControls(connected) {
  debugLog('enableControls: connected:', connected);
  connectBtn.disabled     = false;
  channelInfoEl.textContent = CHANNEL_NAME;
  updateControlsForCooldown();
}
function updateAutoButton() {
  debugLog('updateAutoButton: running:', state.running);
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
  debugLog('buildCoverageEmbedUrl: lat:', lat, 'lon:', lon);
  const base =
    "https://yow.meshmapper.net/embed.php?cov_grid=1&fail_grid=1&pings=0&repeaters=1&rep_coverage=0&grid_lines=0&dir=1&meters=1500";
  return `${base}&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
}
let coverageRefreshTimer = null;
function scheduleCoverageRefresh(lat, lon, delayMs = 0) {
  debugLog('scheduleCoverageRefresh: lat:', lat, 'lon:', lon, 'delay:', delayMs, 'ms');
  if (!coverageFrameEl) {
    debugLog('scheduleCoverageRefresh: no coverageFrameEl, skipping');
    return;
  }

  if (coverageRefreshTimer) clearTimeout(coverageRefreshTimer);

  coverageRefreshTimer = setTimeout(() => {
    const url = buildCoverageEmbedUrl(lat, lon);
    debugLog('scheduleCoverageRefresh: updating iframe to:', url);
    coverageFrameEl.src = url;
  }, delayMs);
}
function setConnectButton(connected) {
  debugLog('setConnectButton: connected:', connected);
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
  debugLog('acquireWakeLock: attempting to acquire wake lock');
  if (navigator.bluetooth && typeof navigator.bluetooth.setScreenDimEnabled === "function") {
    try {
      navigator.bluetooth.setScreenDimEnabled(true);
      state.bluefyLockEnabled = true;
      debugLog("acquireWakeLock: Bluefy screen-dim prevention enabled");
      return;
    } catch (e) {
      console.warn("Bluefy setScreenDimEnabled failed:", e);
    }
  }
  try {
    if ("wakeLock" in navigator && typeof navigator.wakeLock.request === "function") {
      state.wakeLock = await navigator.wakeLock.request("screen");
      debugLog("acquireWakeLock: Wake lock acquired");
      state.wakeLock.addEventListener?.("release", () => debugLog("acquireWakeLock: Wake lock released"));
    } else {
      debugLog("acquireWakeLock: Wake Lock API not supported");
    }
  } catch (err) {
    console.error(`Could not obtain wake lock: ${err.name}, ${err.message}`);
  }
}
async function releaseWakeLock() {
  debugLog('releaseWakeLock: attempting to release wake lock');
  if (state.bluefyLockEnabled && navigator.bluetooth && typeof navigator.bluetooth.setScreenDimEnabled === "function") {
    try {
      navigator.bluetooth.setScreenDimEnabled(false);
      state.bluefyLockEnabled = false;
      debugLog("releaseWakeLock: Bluefy screen-dim prevention disabled");
    } catch (e) {
      console.warn("Bluefy setScreenDimEnabled(false) failed:", e);
    }
  }
  try {
    if (state.wakeLock) {
      await state.wakeLock.release?.();
      state.wakeLock = null;
      debugLog('releaseWakeLock: wake lock released');
    }
  } catch (e) {
    console.warn("Error releasing wake lock:", e);
    state.wakeLock = null;
  }
}

// ---- Geolocation ----
async function getCurrentPosition() {
  debugLog('getCurrentPosition: requesting fresh GPS position');
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      debugLog('getCurrentPosition: geolocation not supported');
      reject(new Error("Geolocation not supported"));
      return;
    }
    const maxAge = getGpsMaximumAge(1000);
    debugLog('getCurrentPosition: maximumAge:', maxAge, 'ms');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        debugLog('getCurrentPosition: got position', pos.coords.latitude, pos.coords.longitude, 'accuracy:', pos.coords.accuracy);
        resolve(pos);
      },
      (err) => {
        debugLog('getCurrentPosition: error', err.message);
        reject(err);
      },
      { 
        enableHighAccuracy: true, 
        maximumAge: maxAge, // Fresh data for one-off requests
        timeout: 30000 
      }
    );
  });
}
function updateGpsUi() {
  if (!gpsInfoEl || !gpsAccEl) {
    debugLog('updateGpsUi: GPS UI elements not found');
    return;
  }

  if (!state.lastFix) {
    // Show different messages based on GPS state
    debugLog('updateGpsUi: no GPS fix, state:', state.gpsState);
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
  debugLog('updateGpsUi: GPS fix', lat.toFixed(5), lon.toFixed(5), 'age:', ageSec, 's, accuracy:', accM, 'm');
  gpsInfoEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} (${ageSec}s ago)`;
  gpsAccEl.textContent = accM ? `±${Math.round(accM)} m` : "-";
}

// Start continuous GPS age display updates
function startGpsAgeUpdater() {
  debugLog('startGpsAgeUpdater: starting GPS age updater');
  if (state.gpsAgeUpdateTimer) {
    debugLog('startGpsAgeUpdater: already running');
    return;
  }
  state.gpsAgeUpdateTimer = setInterval(() => {
    updateGpsUi();
  }, 1000); // Update every second
}

// Stop GPS age display updates
function stopGpsAgeUpdater() {
  debugLog('stopGpsAgeUpdater: stopping GPS age updater');
  if (state.gpsAgeUpdateTimer) {
    clearInterval(state.gpsAgeUpdateTimer);
    state.gpsAgeUpdateTimer = null;
  }
}
function startGeoWatch() {
  debugLog('startGeoWatch: starting continuous GPS watch');
  if (state.geoWatchId) {
    debugLog('startGeoWatch: already watching');
    return;
  }
  if (!("geolocation" in navigator)) {
    debugLog('startGeoWatch: geolocation not supported');
    return;
  }

  state.gpsState = "acquiring";
  updateGpsUi();
  startGpsAgeUpdater(); // Start the age counter

  const maxAge = getGpsMaximumAge(5000);
  debugLog('startGeoWatch: maximumAge:', maxAge, 'ms');
  
  state.geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      debugLog('startGeoWatch: received GPS update', pos.coords.latitude, pos.coords.longitude, 'accuracy:', pos.coords.accuracy);
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
      debugLog('startGeoWatch: GPS watch error', err.message);
      state.gpsState = "error";
      // Keep UI honest if it fails
      updateGpsUi();
    },
    { 
      enableHighAccuracy: true, 
      maximumAge: maxAge, // Continuous watch, minimum 5s
      timeout: 30000 
    }
  );
  debugLog('startGeoWatch: watch ID:', state.geoWatchId);
}
function stopGeoWatch() {
  debugLog('stopGeoWatch: stopping GPS watch, watchId:', state.geoWatchId);
  if (!state.geoWatchId) {
    debugLog('stopGeoWatch: not watching');
    return;
  }
  navigator.geolocation.clearWatch(state.geoWatchId);
  state.geoWatchId = null;
  stopGpsAgeUpdater(); // Stop the age counter
  debugLog('stopGeoWatch: GPS watch stopped');
}
async function primeGpsOnce() {
  debugLog('primeGpsOnce: priming GPS with fresh position request');
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
      debugLog('primeGpsOnce: GPS accuracy good (', state.lastFix.accM, 'm), refreshing coverage map');
      scheduleCoverageRefresh(
        state.lastFix.lat,
        state.lastFix.lon
      );
    } else {
      debugLog('primeGpsOnce: GPS accuracy poor (', state.lastFix.accM, 'm), skipping coverage map refresh');
    }

  } catch (e) {
    console.warn("primeGpsOnce failed:", e);
    debugLog('primeGpsOnce: failed', e.message);
    state.gpsState = "error";
    updateGpsUi();
  }
}



// ---- Channel helpers ----
async function ensureChannel() {
  debugLog('ensureChannel: ensuring channel exists');
  if (!state.connection) {
    debugLog('ensureChannel: not connected');
    throw new Error("Not connected");
  }
  if (state.channel) {
    debugLog('ensureChannel: channel already cached', state.channel.channelIdx);
    return state.channel;
  }

  debugLog('ensureChannel: finding channel', CHANNEL_NAME);
  const ch = await state.connection.findChannelByName(CHANNEL_NAME);
  if (!ch) {
    debugLog('ensureChannel: channel not found', CHANNEL_NAME);
    enableControls(false);
    throw new Error(
      `Channel ${CHANNEL_NAME} not found. Join it on your companion first.`
    );
  }

  state.channel = ch;
  debugLog('ensureChannel: channel found', CHANNEL_NAME, 'channelIdx:', ch.channelIdx);
  enableControls(true);
  channelInfoEl.textContent = `${CHANNEL_NAME} (CH:${ch.channelIdx})`;
  return ch;
}


// ---- Helpers: interval & payload ----
function getSelectedIntervalMs() {
  const checked = document.querySelector('input[name="interval"]:checked');
  const s = checked ? Number(checked.value) : 30;
  const clamped = [15, 30, 60].includes(s) ? s : 30;
  const intervalMs = clamped * 1000;
  debugLog('getSelectedIntervalMs:', intervalMs, 'ms (', clamped, 's)');
  return intervalMs;
}

// Calculate GPS maximumAge based on selected interval
// Returns how old cached GPS data can be before requesting a fresh position.
// Subtracts GPS_FRESHNESS_BUFFER_MS to ensure new data before the interval expires.
// Math.max ensures we never return negative or too-small values.
function getGpsMaximumAge(minAge = 1000) {
  const intervalMs = getSelectedIntervalMs();
  const maxAge = Math.max(minAge, intervalMs - GPS_FRESHNESS_BUFFER_MS);
  debugLog('getGpsMaximumAge: calculated maxAge:', maxAge, 'ms (interval:', intervalMs, 'ms, buffer:', GPS_FRESHNESS_BUFFER_MS, 'ms)');
  return maxAge;
}

function getCurrentPowerSetting() {
  const checkedPower = document.querySelector('input[name="power"]:checked');
  const power = checkedPower ? checkedPower.value : "";
  debugLog('getCurrentPowerSetting:', power || '(none)');
  return power;
}

function buildPayload(lat, lon) {
  const coordsStr = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const power = getCurrentPowerSetting();
  const suffix = power ? ` [${power}]` : "";
  const payload = `${PING_PREFIX} ${coordsStr} ${suffix}`;
  debugLog('buildPayload:', payload);
  return payload;
}

// ---- MeshMapper API ----
async function postToMeshMapperAPI(lat, lon) {
  debugLog('postToMeshMapperAPI: starting API post', 'lat:', lat, 'lon:', lon);
  try {

    // Get current power setting
    const power = getCurrentPowerSetting();
    const powerValue = power || "N/A";

    // Use device name if available, otherwise use default
    const deviceText = deviceInfoEl?.textContent;
    const whoIdentifier = (deviceText && deviceText !== "—") ? deviceText : MESHMAPPER_DEFAULT_WHO;

    // Build API payload
    const payload = {
      key: MESHMAPPER_API_KEY,
      lat: lat,
      lon: lon,
      who: whoIdentifier,
      power: powerValue,
      test: 0
    };

    debugLog("postToMeshMapperAPI: payload", { lat, lon, who: whoIdentifier, power: powerValue });

    // POST to MeshMapper API
    const response = await fetch(MESHMAPPER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.warn(`MeshMapper API returned status ${response.status}`);
      debugLog('postToMeshMapperAPI: API returned error status', response.status);
    } else {
      debugLog("postToMeshMapperAPI: successfully posted to MeshMapper API");
    }
  } catch (error) {
    // Log error but don't fail the ping
    console.error("Failed to post to MeshMapper API:", error);
    debugLog('postToMeshMapperAPI: exception', error.message);
  }
}

// ---- Ping ----
async function sendPing(manual = false) {
  debugLog('sendPing: entering, manual:', manual, 'running:', state.running);
  try {
    // Check cooldown only for manual pings
    if (manual && isInCooldown()) {
      const remainingMs = state.cooldownEndTime - Date.now();
      const remainingSec = Math.ceil(remainingMs / 1000);
      debugLog('sendPing: in cooldown, remaining:', remainingSec, 's');
      setStatus(`Please wait ${remainingSec}s before sending another ping`, "text-amber-300");
      return;
    }

    // Stop the countdown timer when sending an auto ping to avoid status conflicts
    if (!manual && state.running) {
      debugLog('sendPing: auto ping mode, stopping countdown');
      stopAutoCountdown();
      setStatus("Sending auto ping...", "text-sky-300");
    }

    let lat, lon, accuracy;

    // In auto mode, always use the most recent GPS coordinates from the watch
    // In manual mode, get fresh GPS if needed
    if (!manual && state.running) {
      // Auto mode: use GPS watch data
      debugLog('sendPing: auto mode, using GPS watch data');
      if (!state.lastFix) {
        // If no GPS fix yet in auto mode, skip this ping and wait for watch to acquire location
        console.warn("Auto ping skipped: waiting for GPS fix");
        debugLog('sendPing: no GPS fix yet in auto mode, skipping ping');
        setStatus("Waiting for GPS fix...", "text-amber-300");
        return;
      }
      lat = state.lastFix.lat;
      lon = state.lastFix.lon;
      accuracy = state.lastFix.accM;
      debugLog('sendPing: using cached GPS from watch', lat, lon, 'accuracy:', accuracy);
    } else {
      // Manual mode: check if we have recent enough GPS data
      debugLog('sendPing: manual mode, checking GPS freshness');
      const intervalMs = getSelectedIntervalMs();
      const maxAge = intervalMs + GPS_FRESHNESS_BUFFER_MS; // Allow buffer beyond interval

      if (state.lastFix && (Date.now() - state.lastFix.tsMs) < maxAge) {
        debugLog('sendPing: using cached GPS (age:', Date.now() - state.lastFix.tsMs, 'ms < maxAge:', maxAge, 'ms)');
        lat = state.lastFix.lat;
        lon = state.lastFix.lon;
        accuracy = state.lastFix.accM;
      } else {
        // Get fresh GPS coordinates for manual ping
        debugLog('sendPing: getting fresh GPS position for manual ping');
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
        debugLog('sendPing: fresh GPS acquired', lat, lon, 'accuracy:', accuracy);
      }
    }

    const payload = buildPayload(lat, lon);

    debugLog('sendPing: ensuring channel and sending message');
    const ch = await ensureChannel();
    await state.connection.sendChannelTextMessage(ch.channelIdx, payload);
    debugLog('sendPing: message sent to channel', ch.channelIdx);

    // Start cooldown period after successful ping
    startCooldown();

    // Update status after ping is sent
    // Brief delay to show "Ping sent" status before moving to countdown
    setStatus(manual ? "Ping sent" : "Auto ping sent", "text-emerald-300");
    
    setTimeout(() => {
      if (state.connection) {
        // Start countdown for API post
        debugLog('sendPing: scheduling API countdown');
        startApiCountdown(MESHMAPPER_DELAY_MS);
      }
    }, STATUS_UPDATE_DELAY_MS);

    // Schedule MeshMapper API call with 7-second delay (non-blocking)
    // Clear any existing timer first
    if (state.meshMapperTimer) {
      debugLog('sendPing: clearing existing MeshMapper timer');
      clearTimeout(state.meshMapperTimer);
    }

    debugLog('sendPing: scheduling MeshMapper API call with', MESHMAPPER_DELAY_MS, 'ms delay');
    state.meshMapperTimer = setTimeout(async () => {
      // Capture accuracy in closure to ensure it's available in nested callback
      const capturedAccuracy = accuracy;
      
      debugLog('sendPing: MeshMapper timer fired, posting to API');
      // Stop the API countdown since we're posting now
      stopApiCountdown();
      setStatus("Posting to API...", "text-sky-300");
      
      try {
        await postToMeshMapperAPI(lat, lon);
      } catch (error) {
        console.error("MeshMapper API post failed:", error);
        debugLog('sendPing: MeshMapper API call failed');
        // Continue with map refresh and status update even if API fails
      }
      
      // Update map after API post to ensure backend updated
      setTimeout(() => {
        debugLog('sendPing: post-API delay complete, updating coverage map');
        if (capturedAccuracy && capturedAccuracy < GPS_ACCURACY_THRESHOLD_M) {
          debugLog('sendPing: accuracy good, scheduling coverage refresh');
          scheduleCoverageRefresh(lat, lon);
        } else {
          debugLog('sendPing: accuracy poor (', capturedAccuracy, 'm), skipping coverage refresh');
        }
        
        // Set status to idle after map update
        if (state.connection) {
          // If in auto mode, schedule next ping. Otherwise, set to idle
          if (state.running) {
            // Schedule the next auto ping with countdown
            debugLog('sendPing: auto mode active, scheduling next ping');
            scheduleNextAutoPing();
          } else {
            debugLog('sendPing: not in auto mode, setting idle');
            setStatus("Idle", "text-slate-300");
          }
        }
      }, MAP_REFRESH_DELAY_MS);
      
      state.meshMapperTimer = null;
    }, MESHMAPPER_DELAY_MS);
    
    const nowStr = new Date().toLocaleString();
    if (lastPingEl) {
      lastPingEl.textContent = `${nowStr} — ${payload}`;
      debugLog('sendPing: updated lastPing display');
    }

    // Session log
    if (sessionPingsEl) {
      const line = `${nowStr}  ${lat.toFixed(5)} ${lon.toFixed(5)}`;
      const li = document.createElement('li');
      li.textContent = line;
      sessionPingsEl.appendChild(li);
       // Auto-scroll to bottom when a new entry arrives
      sessionPingsEl.scrollTop = sessionPingsEl.scrollHeight;
      debugLog('sendPing: added ping to session log');
    }
    
    debugLog('sendPing: completed successfully');
  } catch (e) {
    console.error("Ping failed:", e);
    debugLog('sendPing: failed with error', e.message);
    setStatus(e.message || "Ping failed", "text-red-300");
  }
}

// ---- Auto mode ----
function stopAutoPing(stopGps = false) {
  debugLog('stopAutoPing: stopping auto ping, stopGps:', stopGps);
  // Check if we're in cooldown before stopping (unless stopGps is true for disconnect)
  if (!stopGps && isInCooldown()) {
    const remainingMs = state.cooldownEndTime - Date.now();
    const remainingSec = Math.ceil(remainingMs / 1000);
    debugLog('stopAutoPing: in cooldown, remaining:', remainingSec, 's');
    setStatus(`Please wait ${remainingSec}s before toggling auto mode`, "text-amber-300");
    return;
  }
  
  if (state.autoTimerId) {
    debugLog('stopAutoPing: clearing auto timer');
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Only stop GPS watch when disconnecting or page hidden, not during normal stop
  if (stopGps) {
    debugLog('stopAutoPing: stopping GPS watch');
    stopGeoWatch();
  }
  
  state.running = false;
  updateAutoButton();
  releaseWakeLock();
  debugLog('stopAutoPing: auto ping stopped');
}
function scheduleNextAutoPing() {
  debugLog('scheduleNextAutoPing: scheduling next auto ping');
  if (!state.running) {
    debugLog('scheduleNextAutoPing: not running, skipping');
    return;
  }
  
  const intervalMs = getSelectedIntervalMs();
  
  // Start countdown immediately
  startAutoCountdown(intervalMs);
  
  // Schedule the next ping
  state.autoTimerId = setTimeout(() => {
    debugLog('scheduleNextAutoPing: timer fired, sending ping');
    if (state.running) {
      sendPing(false).catch(console.error);
    } else {
      debugLog('scheduleNextAutoPing: no longer running, skipping ping');
    }
  }, intervalMs);
  debugLog('scheduleNextAutoPing: scheduled with interval', intervalMs, 'ms');
}

function startAutoPing() {
  debugLog('startAutoPing: starting auto ping mode');
  if (!state.connection) {
    debugLog('startAutoPing: not connected');
    alert("Connect to a MeshCore device first.");
    return;
  }
  
  // Check if we're in cooldown
  if (isInCooldown()) {
    const remainingMs = state.cooldownEndTime - Date.now();
    const remainingSec = Math.ceil(remainingMs / 1000);
    debugLog('startAutoPing: in cooldown, remaining:', remainingSec, 's');
    setStatus(`Please wait ${remainingSec}s before toggling auto mode`, "text-amber-300");
    return;
  }
  
  // Clean up any existing auto-ping timer (but keep GPS watch running)
  if (state.autoTimerId) {
    debugLog('startAutoPing: clearing existing auto timer');
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Start GPS watch for continuous updates
  debugLog('startAutoPing: starting GPS watch');
  startGeoWatch();
  
  state.running = true;
  updateAutoButton();

  // Acquire wake lock for auto mode
  debugLog('startAutoPing: acquiring wake lock');
  acquireWakeLock().catch(console.error);

  // Send first ping immediately
  debugLog('startAutoPing: sending first ping immediately');
  sendPing(false).catch(console.error);
}

// ---- BLE connect / disconnect ----
async function connect() {
  debugLog('connect: initiating BLE connection');
  if (!("bluetooth" in navigator)) {
    debugLog('connect: Web Bluetooth not supported');
    alert("Web Bluetooth not supported in this browser.");
    return;
  }
  connectBtn.disabled = true;
  setStatus("Connecting…", "text-sky-300");

  try {
    debugLog('connect: opening WebBleConnection');
    const conn = await WebBleConnection.open();
    state.connection = conn;
    debugLog('connect: WebBleConnection opened successfully');

    conn.on("connected", async () => {
      debugLog('connect: BLE connected event fired');
      setStatus("Connected", "text-emerald-300");
      setConnectButton(true);
      connectBtn.disabled = false;
      const selfInfo = await conn.getSelfInfo();
      debugLog('connect: device info', selfInfo?.name || "[No device]");
      deviceInfoEl.textContent = selfInfo?.name || "[No device]";
      updateAutoButton();
      try { 
        debugLog('connect: syncing device time');
        await conn.syncDeviceTime?.(); 
      } catch { 
        debugLog('connect: device time sync not available or failed');
        /* optional */ 
      }
      try {
        debugLog('connect: setting up channel and GPS');
        await ensureChannel();
        await primeGpsOnce();
        debugLog('connect: channel and GPS setup complete');
      } catch (e) {
        console.error("Channel setup failed:", e);
        debugLog('connect: channel setup failed', e.message);
        setStatus(e.message || "Channel setup failed", "text-red-300");
      }
    });

    conn.on("disconnected", () => {
      debugLog('connect: BLE disconnected event fired');
      setStatus("Disconnected", "text-red-300");
      setConnectButton(false);
      deviceInfoEl.textContent = "—";
      state.connection = null;
      state.channel = null;
      debugLog('connect: stopping auto ping on disconnect');
      stopAutoPing(true); // Ignore cooldown check on disconnect
      enableControls(false);
      updateAutoButton();
      stopGeoWatch();
      stopGpsAgeUpdater(); // Ensure age updater stops
      
      // Clean up timers
      debugLog('connect: cleaning up timers on disconnect');
      if (state.meshMapperTimer) {
        clearTimeout(state.meshMapperTimer);
        state.meshMapperTimer = null;
      }
      if (state.cooldownUpdateTimer) {
        clearTimeout(state.cooldownUpdateTimer);
        state.cooldownUpdateTimer = null;
      }
      stopAutoCountdown();
      stopApiCountdown();
      state.cooldownEndTime = null;
      
      state.lastFix = null;
      state.gpsState = "idle";
      updateGpsUi();
      debugLog('connect: disconnect cleanup complete');
    });

  } catch (e) {
    console.error("BLE connect failed:", e);
    debugLog('connect: BLE connection failed', e.message);
    setStatus("Failed to connect", "text-red-300");
    connectBtn.disabled = false;
  }
}
async function disconnect() {
  debugLog('disconnect: initiating BLE disconnect');
  if (!state.connection) {
    debugLog('disconnect: no connection to disconnect');
    return;
  }

  connectBtn.disabled = true;
  setStatus("Disconnecting...", "text-sky-300");

  try {
    // WebBleConnection typically exposes one of these.
    if (typeof state.connection.close === "function") {
      debugLog('disconnect: using close() method');
      await state.connection.close();
    } else if (typeof state.connection.disconnect === "function") {
      debugLog('disconnect: using disconnect() method');
      await state.connection.disconnect();
    } else if (typeof state.connection.device?.gatt?.disconnect === "function") {
      debugLog('disconnect: using device.gatt.disconnect() method');
      state.connection.device.gatt.disconnect();
    } else {
      console.warn("No known disconnect method on connection object");
      debugLog('disconnect: no known disconnect method found');
    }
    debugLog('disconnect: disconnect completed');
  } catch (e) {
    console.error("BLE disconnect failed:", e);
    debugLog('disconnect: disconnect failed', e.message);
    setStatus(e.message || "Disconnect failed", "text-red-300");
  } finally {
    connectBtn.disabled = false;
  }
}


// ---- Page visibility ----
document.addEventListener("visibilitychange", async () => {
  debugLog('visibilitychange: document.hidden:', document.hidden);
  if (document.hidden) {
    debugLog('visibilitychange: page hidden');
    if (state.running) {
      debugLog('visibilitychange: stopping auto ping due to page hidden');
      stopAutoPing(true); // Ignore cooldown check when page is hidden
      setStatus("Lost focus, auto mode stopped", "text-amber-300");
    } else {
      debugLog('visibilitychange: releasing wake lock due to page hidden');
      releaseWakeLock();
    }
  } else {
    debugLog('visibilitychange: page visible again');
    // On visible again, user can manually re-start Auto.
  }
});

// ---- Bind UI & init ----
export async function onLoad() {
  debugLog('onLoad: initializing wardrive app');
  setStatus("Disconnected", "text-red-300");
  enableControls(false);
  updateAutoButton();

  debugLog('onLoad: binding UI event listeners');
  connectBtn.addEventListener("click", async () => {
    debugLog('onLoad: connect button clicked');
    try {
      if (state.connection) {
        await disconnect();
      } else {
        await connect();
      }
    } catch (e) {
      console.error(e);
      debugLog('onLoad: connection error', e.message);
      setStatus(e.message || "Connection error", "text-red-300");
    }
  });
  sendPingBtn.addEventListener("click", () => {
    debugLog('onLoad: send ping button clicked');
    sendPing(true).catch(console.error);
  });
  autoToggleBtn.addEventListener("click", () => {
    debugLog('onLoad: auto toggle button clicked, current state.running:', state.running);
    if (state.running) {
      stopAutoPing();
      setStatus("Auto mode stopped", "text-slate-300");
    } else {
      startAutoPing();
    }
  });

  // Prompt location permission early (optional)
  debugLog('onLoad: requesting initial GPS position for permissions');
  try { 
    await getCurrentPosition(); 
    debugLog('onLoad: initial GPS position obtained');
  } catch { 
    debugLog('onLoad: initial GPS position request failed (will prompt at first send)');
    /* will prompt at first send */ 
  }
  
  debugLog('onLoad: initialization complete');
}
