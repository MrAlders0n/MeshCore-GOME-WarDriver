
// Minimal Wardrive sender with wake locks:
// - Connect to MeshCore Companion via Web Bluetooth (BLE)
// - Send pings as "@[MapperBot]<LAT LON>[ <power> ]" (power only if specified)
// - Manual "Send Ping" and Auto mode (interval selectable: 15/30/60s)
// - Acquire wake lock during auto mode to keep screen awake

import { WebBleConnection } from "./mc/index.js"; // your BLE client

// ---- Debug Configuration ----
// Enable debug logging via URL parameter (?debug=true) or set default here
const urlParams = new URLSearchParams(window.location.search);
const DEBUG_ENABLED = urlParams.get('debug') === 'true' || false; // Set to true to enable debug logging by default

// Debug logging helper function
function debugLog(message, ...args) {
  if (DEBUG_ENABLED) {
    console.log(`[DEBUG] ${message}`, ...args);
  }
}

function debugWarn(message, ...args) {
  if (DEBUG_ENABLED) {
    console.warn(`[DEBUG] ${message}`, ...args);
  }
}

function debugError(message, ...args) {
  if (DEBUG_ENABLED) {
    console.error(`[DEBUG] ${message}`, ...args);
  }
}

// ---- Config ----
const CHANNEL_NAME     = "#wardriving";        // change to "#wardrive" if needed
const DEFAULT_INTERVAL_S = 30;                 // fallback if selector unavailable
const PING_PREFIX      = "@[MapperBot]";
const GPS_FRESHNESS_BUFFER_MS = 5000;          // Buffer time for GPS freshness checks
const GPS_ACCURACY_THRESHOLD_M = 100;          // Maximum acceptable GPS accuracy in meters
const GPS_WATCH_MAX_AGE_MS = 60000;            // Maximum age for GPS watch data in manual pings (60s)
const MESHMAPPER_DELAY_MS = 7000;              // Delay MeshMapper API call by 7 seconds
const COOLDOWN_MS = 7000;                      // Cooldown period for manual ping and auto toggle
const STATUS_UPDATE_DELAY_MS = 100;            // Brief delay to ensure "Ping sent" status is visible
const MAP_REFRESH_DELAY_MS = 1000;             // Delay after API post to ensure backend updated
const MIN_PAUSE_THRESHOLD_MS = 1000;           // Minimum timer value (1 second) to pause
const MAX_REASONABLE_TIMER_MS = 5 * 60 * 1000; // Maximum reasonable timer value (5 minutes) to handle clock skew
const WARDROVE_KEY     = new Uint8Array([
  0x40, 0x76, 0xC3, 0x15, 0xC1, 0xEF, 0x38, 0x5F,
  0xA9, 0x3F, 0x06, 0x60, 0x27, 0x32, 0x0F, 0xE5
]);

// Ottawa Geofence Configuration
const OTTAWA_CENTER_LAT = 45.4215;  // Parliament Hill latitude
const OTTAWA_CENTER_LON = -75.6972; // Parliament Hill longitude
const OTTAWA_GEOFENCE_RADIUS_M = 150000; // 150 km in meters

// Distance-Based Ping Filtering
const MIN_PING_DISTANCE_M = 25; // Minimum distance (25m) between pings

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
const distanceInfoEl = document.getElementById("distanceInfo"); // Distance from last ping
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
  apiPostTime: null, // Timestamp when API post will occur
  skipReason: null, // Reason for skipping a ping - internal value only (e.g., "gps too old")
  pausedAutoTimerRemainingMs: null, // Remaining time when auto ping timer was paused by manual ping
  lastSuccessfulPingLocation: null, // { lat, lon } of the last successful ping (Mesh + API)
  distanceUpdateTimer: null // Timer for updating distance display
};

// ---- UI helpers ----
// Status colors for different states
const STATUS_COLORS = {
  idle: "text-slate-300",
  success: "text-emerald-300",
  warning: "text-amber-300",
  error: "text-red-300",
  info: "text-sky-300"
};

function setStatus(text, color = STATUS_COLORS.idle) {
  statusEl.textContent = text;
  statusEl.className = `font-semibold ${color}`;
}

/**
 * Apply status message from countdown timer result
 * @param {string|{message: string, color: string}|null} result - Status message (string) or object with message and optional color
 * @param {string} defaultColor - Default color to use if result is a string or object without color
 */
function applyCountdownStatus(result, defaultColor) {
  if (!result) return;
  if (typeof result === 'string') {
    setStatus(result, defaultColor);
  } else {
    setStatus(result.message, result.color || defaultColor);
  }
}

// Countdown timer management - generalized for reuse
function createCountdownTimer(getEndTime, getStatusMessage) {
  return {
    timerId: null,
    endTime: null,
    
    start(durationMs) {
      this.stop();
      this.endTime = Date.now() + durationMs;
      this.update();
      this.timerId = setInterval(() => this.update(), 1000);
    },
    
    update() {
      if (!this.endTime) return;
      
      const remainingMs = this.endTime - Date.now();
      if (remainingMs <= 0) {
        applyCountdownStatus(getStatusMessage(0), STATUS_COLORS.info);
        return;
      }
      
      const remainingSec = Math.ceil(remainingMs / 1000);
      applyCountdownStatus(getStatusMessage(remainingSec), STATUS_COLORS.idle);
    },
    
    stop() {
      if (this.timerId) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
      this.endTime = null;
    }
  };
}

// Auto ping countdown timer
const autoCountdownTimer = createCountdownTimer(
  () => state.nextAutoPingTime,
  (remainingSec) => {
    if (!state.running) return null;
    if (remainingSec === 0) {
      return { message: "Sending auto ping...", color: STATUS_COLORS.info };
    }
    // If there's a skip reason, show it with the countdown in warning color
    if (state.skipReason === "outside geofence") {
      return { 
        message: `Ping skipped, outside of geo fenced region, waiting for next ping (${remainingSec}s)`,
        color: STATUS_COLORS.warning
      };
    }
    if (state.skipReason === "too close") {
      return { 
        message: `Ping skipping, too close to last ping, waiting for next ping (${remainingSec}s)`,
        color: STATUS_COLORS.warning
      };
    }
    if (state.skipReason) {
      return { 
        message: `Skipped (${state.skipReason}), next ping (${remainingSec}s)`,
        color: STATUS_COLORS.warning
      };
    }
    return { 
      message: `Waiting for next auto ping (${remainingSec}s)`,
      color: STATUS_COLORS.idle
    };
  }
);

// API post countdown timer
const apiCountdownTimer = createCountdownTimer(
  () => state.apiPostTime,
  (remainingSec) => {
    if (remainingSec === 0) {
      return { message: "Posting to API...", color: STATUS_COLORS.info };
    }
    return { 
      message: `Wait to post API (${remainingSec}s)`,
      color: STATUS_COLORS.idle
    };
  }
);

// Legacy compatibility wrappers
function startAutoCountdown(intervalMs) {
  state.nextAutoPingTime = Date.now() + intervalMs;
  autoCountdownTimer.start(intervalMs);
}

function stopAutoCountdown() {
  state.nextAutoPingTime = null;
  autoCountdownTimer.stop();
}

function pauseAutoCountdown() {
  // Calculate remaining time before pausing
  if (state.nextAutoPingTime) {
    const remainingMs = state.nextAutoPingTime - Date.now();
    // Only pause if there's meaningful time remaining and not unreasonably large
    if (remainingMs > MIN_PAUSE_THRESHOLD_MS && remainingMs < MAX_REASONABLE_TIMER_MS) {
      state.pausedAutoTimerRemainingMs = remainingMs;
      debugLog(`Pausing auto countdown with ${state.pausedAutoTimerRemainingMs}ms remaining`);
    } else {
      debugLog(`Auto countdown time out of reasonable range (${remainingMs}ms), not pausing`);
      state.pausedAutoTimerRemainingMs = null;
    }
  }
  // Stop the auto ping timer (but keep autoTimerId so we know auto mode is active)
  autoCountdownTimer.stop();
  state.nextAutoPingTime = null;
}

function resumeAutoCountdown() {
  // Resume auto countdown from paused time
  if (state.pausedAutoTimerRemainingMs !== null) {
    // Validate paused time is still reasonable before resuming
    if (state.pausedAutoTimerRemainingMs > MIN_PAUSE_THRESHOLD_MS && state.pausedAutoTimerRemainingMs < MAX_REASONABLE_TIMER_MS) {
      debugLog(`Resuming auto countdown with ${state.pausedAutoTimerRemainingMs}ms remaining`);
      startAutoCountdown(state.pausedAutoTimerRemainingMs);
      state.pausedAutoTimerRemainingMs = null;
      return true;
    } else {
      debugLog(`Paused time out of reasonable range (${state.pausedAutoTimerRemainingMs}ms), not resuming`);
      state.pausedAutoTimerRemainingMs = null;
    }
  }
  return false;
}

function startApiCountdown(delayMs) {
  state.apiPostTime = Date.now() + delayMs;
  apiCountdownTimer.start(delayMs);
}

function stopApiCountdown() {
  state.apiPostTime = null;
  apiCountdownTimer.stop();
}

// Cooldown management
function isInCooldown() {
  return state.cooldownEndTime && Date.now() < state.cooldownEndTime;
}

function getRemainingCooldownSeconds() {
  if (!isInCooldown()) return 0;
  return Math.ceil((state.cooldownEndTime - Date.now()) / 1000);
}

function startCooldown() {
  state.cooldownEndTime = Date.now() + COOLDOWN_MS;
  updateControlsForCooldown();
  
  if (state.cooldownUpdateTimer) {
    clearTimeout(state.cooldownUpdateTimer);
  }
  
  state.cooldownUpdateTimer = setTimeout(() => {
    state.cooldownEndTime = null;
    updateControlsForCooldown();
  }, COOLDOWN_MS);
}

function updateControlsForCooldown() {
  const connected = !!state.connection;
  const inCooldown = isInCooldown();
  sendPingBtn.disabled = !connected || inCooldown;
  autoToggleBtn.disabled = !connected || inCooldown;
}

// Timer cleanup
function cleanupAllTimers() {
  debugLog("Cleaning up all timers");
  
  if (state.meshMapperTimer) {
    clearTimeout(state.meshMapperTimer);
    state.meshMapperTimer = null;
  }
  
  if (state.cooldownUpdateTimer) {
    clearTimeout(state.cooldownUpdateTimer);
    state.cooldownUpdateTimer = null;
  }
  
  // Clean up state timer references
  state.autoCountdownTimer = null;
  state.apiCountdownTimer = null;
  
  stopAutoCountdown();
  stopApiCountdown();
  state.cooldownEndTime = null;
  state.pausedAutoTimerRemainingMs = null;
}

function enableControls(connected) {
  connectBtn.disabled     = false;
  channelInfoEl.textContent = CHANNEL_NAME;
  updateControlsForCooldown();
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
    "https://yow.meshmapper.net/embed.php?cov_grid=1&fail_grid=1&pings=0&repeaters=1&rep_coverage=0&grid_lines=0&dir=1&meters=1500";
  return `${base}&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
}
let coverageRefreshTimer = null;
function scheduleCoverageRefresh(lat, lon, delayMs = 0) {
  if (!coverageFrameEl) return;

  if (coverageRefreshTimer) clearTimeout(coverageRefreshTimer);

  coverageRefreshTimer = setTimeout(() => {
    const url = buildCoverageEmbedUrl(lat, lon);
    debugLog("Coverage iframe URL:", url);
    coverageFrameEl.src = url;
  }, delayMs);
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
  debugLog("Attempting to acquire wake lock");
  if (navigator.bluetooth && typeof navigator.bluetooth.setScreenDimEnabled === "function") {
    try {
      navigator.bluetooth.setScreenDimEnabled(true);
      state.bluefyLockEnabled = true;
      debugLog("Bluefy screen-dim prevention enabled");
      return;
    } catch (e) {
      debugWarn("Bluefy setScreenDimEnabled failed:", e);
    }
  }
  try {
    if ("wakeLock" in navigator && typeof navigator.wakeLock.request === "function") {
      state.wakeLock = await navigator.wakeLock.request("screen");
      debugLog("Wake lock acquired successfully");
      state.wakeLock.addEventListener?.("release", () => debugLog("Wake lock released"));
    } else {
      debugLog("Wake Lock API not supported on this device");
    }
  } catch (err) {
    debugError(`Could not obtain wake lock: ${err.name}, ${err.message}`);
  }
}
async function releaseWakeLock() {
  debugLog("Attempting to release wake lock");
  if (state.bluefyLockEnabled && navigator.bluetooth && typeof navigator.bluetooth.setScreenDimEnabled === "function") {
    try {
      navigator.bluetooth.setScreenDimEnabled(false);
      state.bluefyLockEnabled = false;
      debugLog("Bluefy screen-dim prevention disabled");
    } catch (e) {
      debugWarn("Bluefy setScreenDimEnabled(false) failed:", e);
    }
  }
  try {
    if (state.wakeLock) {
      await state.wakeLock.release?.();
      state.wakeLock = null;
      debugLog("Wake lock released successfully");
    }
  } catch (e) {
    debugWarn("Error releasing wake lock:", e);
    state.wakeLock = null;
  }
}

// ---- Geofence & Distance Validation ----

/**
 * Calculate Haversine distance between two GPS coordinates
 * @param {number} lat1 - First latitude
 * @param {number} lon1 - First longitude
 * @param {number} lat2 - Second latitude
 * @param {number} lon2 - Second longitude
 * @returns {number} Distance in meters
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  debugLog(`Calculating Haversine distance: (${lat1.toFixed(5)}, ${lon1.toFixed(5)}) to (${lat2.toFixed(5)}, ${lon2.toFixed(5)})`);
  
  const R = 6371000; // Earth's radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  
  debugLog(`Haversine distance calculated: ${distance.toFixed(2)}m`);
  return distance;
}

/**
 * Validate that GPS coordinates are within the Ottawa geofence
 * @param {number} lat - Latitude to check
 * @param {number} lon - Longitude to check
 * @returns {boolean} True if within geofence, false otherwise
 */
function validateGeofence(lat, lon) {
  debugLog(`Validating geofence for coordinates: (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
  debugLog(`Geofence center: (${OTTAWA_CENTER_LAT}, ${OTTAWA_CENTER_LON}), radius: ${OTTAWA_GEOFENCE_RADIUS_M}m`);
  
  const distance = calculateHaversineDistance(lat, lon, OTTAWA_CENTER_LAT, OTTAWA_CENTER_LON);
  const isWithinGeofence = distance <= OTTAWA_GEOFENCE_RADIUS_M;
  
  debugLog(`Geofence validation: distance=${distance.toFixed(2)}m, within_geofence=${isWithinGeofence}`);
  return isWithinGeofence;
}

/**
 * Validate that current GPS coordinates are at least 25m from last successful ping
 * @param {number} lat - Current latitude
 * @param {number} lon - Current longitude
 * @returns {boolean} True if distance >= 25m or no previous ping, false otherwise
 */
function validateMinimumDistance(lat, lon) {
  debugLog(`Validating minimum distance for coordinates: (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
  
  if (!state.lastSuccessfulPingLocation) {
    debugLog("No previous successful ping location, minimum distance check skipped");
    return true;
  }
  
  const { lat: lastLat, lon: lastLon } = state.lastSuccessfulPingLocation;
  debugLog(`Last successful ping location: (${lastLat.toFixed(5)}, ${lastLon.toFixed(5)})`);
  
  const distance = calculateHaversineDistance(lat, lon, lastLat, lastLon);
  const isMinimumDistanceMet = distance >= MIN_PING_DISTANCE_M;
  
  debugLog(`Distance validation: distance=${distance.toFixed(2)}m, minimum_distance_met=${isMinimumDistanceMet} (threshold=${MIN_PING_DISTANCE_M}m)`);
  return isMinimumDistanceMet;
}

/**
 * Calculate distance from last successful ping location (for UI display)
 * @returns {number|null} Distance in meters, or null if no previous ping
 */
function getDistanceFromLastPing() {
  if (!state.lastFix || !state.lastSuccessfulPingLocation) {
    return null;
  }
  
  const { lat, lon } = state.lastFix;
  const { lat: lastLat, lon: lastLon } = state.lastSuccessfulPingLocation;
  
  return calculateHaversineDistance(lat, lon, lastLat, lastLon);
}

/**
 * Update the distance display in the UI
 */
function updateDistanceUi() {
  if (!distanceInfoEl) return;
  
  const distance = getDistanceFromLastPing();
  
  if (distance === null) {
    distanceInfoEl.textContent = "-";
  } else {
    distanceInfoEl.textContent = `${Math.round(distance)} m`;
  }
}

/**
 * Start continuous distance display updates
 */
function startDistanceUpdater() {
  if (state.distanceUpdateTimer) return;
  state.distanceUpdateTimer = setInterval(() => {
    updateDistanceUi();
  }, 3000); // Update every 3 seconds as fallback (main updates happen on GPS position changes)
}

/**
 * Stop distance display updates
 */
function stopDistanceUpdater() {
  if (state.distanceUpdateTimer) {
    clearInterval(state.distanceUpdateTimer);
    state.distanceUpdateTimer = null;
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
  if (state.geoWatchId) {
    debugLog("GPS watch already running, skipping start");
    return;
  }
  if (!("geolocation" in navigator)) {
    debugError("Geolocation not available in navigator");
    return;
  }

  debugLog("Starting GPS watch");
  state.gpsState = "acquiring";
  updateGpsUi();
  startGpsAgeUpdater(); // Start the age counter
  startDistanceUpdater(); // Start the distance updater

  state.geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      debugLog(`GPS fix acquired: lat=${pos.coords.latitude.toFixed(5)}, lon=${pos.coords.longitude.toFixed(5)}, accuracy=${pos.coords.accuracy}m`);
      state.lastFix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accM: pos.coords.accuracy,
        tsMs: Date.now(),
      };
      state.gpsState = "acquired";
      updateGpsUi();
      updateDistanceUi(); // Update distance when GPS position changes
    },
    (err) => {
      debugError(`GPS watch error: ${err.code} - ${err.message}`);
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
  if (!state.geoWatchId) {
    debugLog("No GPS watch to stop");
    return;
  }
  debugLog("Stopping GPS watch");
  navigator.geolocation.clearWatch(state.geoWatchId);
  state.geoWatchId = null;
  stopGpsAgeUpdater(); // Stop the age counter
  stopDistanceUpdater(); // Stop the distance updater
}
async function primeGpsOnce() {
  debugLog("Priming GPS with initial position request");
  // Start continuous watch so the UI keeps updating
  startGeoWatch();

  state.gpsState = "acquiring";
  updateGpsUi();

  try {
    const pos = await getCurrentPosition();

    debugLog(`Initial GPS position acquired: lat=${pos.coords.latitude.toFixed(5)}, lon=${pos.coords.longitude.toFixed(5)}, accuracy=${pos.coords.accuracy}m`);
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
      debugLog(`GPS accuracy ${state.lastFix.accM}m is within threshold, refreshing coverage map`);
      scheduleCoverageRefresh(
        state.lastFix.lat,
        state.lastFix.lon
      );
    } else {
      debugLog(`GPS accuracy ${state.lastFix.accM}m exceeds threshold (${GPS_ACCURACY_THRESHOLD_M}m), skipping map refresh`);
    }

  } catch (e) {
    debugError(`primeGpsOnce failed: ${e.message}`);
    state.gpsState = "error";
    updateGpsUi();
  }
}



// ---- Channel helpers ----
async function ensureChannel() {
  if (!state.connection) throw new Error("Not connected");
  if (state.channel) {
    debugLog(`Using existing channel: ${CHANNEL_NAME}`);
    return state.channel;
  }

  debugLog(`Looking up channel: ${CHANNEL_NAME}`);
  const ch = await state.connection.findChannelByName(CHANNEL_NAME);
  if (!ch) {
    debugError(`Channel ${CHANNEL_NAME} not found on device`);
    enableControls(false);
    throw new Error(
      `Channel ${CHANNEL_NAME} not found. Join it on your companion first.`
    );
  }

  debugLog(`Channel found: ${CHANNEL_NAME} (index: ${ch.channelIdx})`);
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

function getCurrentPowerSetting() {
  const checkedPower = document.querySelector('input[name="power"]:checked');
  return checkedPower ? checkedPower.value : "";
}

function buildPayload(lat, lon) {
  const coordsStr = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const power = getCurrentPowerSetting();
  const suffix = power ? ` [${power}]` : "";
  return `${PING_PREFIX} ${coordsStr} ${suffix}`;
}

// ---- MeshMapper API ----
/**
 * Get the current device identifier for API calls
 * @returns {string} Device name or default identifier
 */
function getDeviceIdentifier() {
  const deviceText = deviceInfoEl?.textContent;
  return (deviceText && deviceText !== "—") ? deviceText : MESHMAPPER_DEFAULT_WHO;
}

/**
 * Post wardrive ping data to MeshMapper API
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 */
async function postToMeshMapperAPI(lat, lon) {
  try {
    const payload = {
      key: MESHMAPPER_API_KEY,
      lat,
      lon,
      who: getDeviceIdentifier(),
      power: getCurrentPowerSetting() || "N/A",
      test: 0
    };

    debugLog(`Posting to MeshMapper API: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, who=${payload.who}, power=${payload.power}`);

    const response = await fetch(MESHMAPPER_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      debugWarn(`MeshMapper API returned error status ${response.status}`);
    } else {
      debugLog(`MeshMapper API post successful (status ${response.status})`);
    }
  } catch (error) {
    // Log error but don't fail the ping
    debugError(`MeshMapper API post failed: ${error.message}`);
  }
}

/**
 * Schedule MeshMapper API post and coverage map refresh after a ping
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} accuracy - GPS accuracy in meters
 */
function scheduleApiPostAndMapRefresh(lat, lon, accuracy) {
  // Clear any existing timer
  if (state.meshMapperTimer) {
    debugLog("Clearing existing MeshMapper timer");
    clearTimeout(state.meshMapperTimer);
  }

  debugLog(`Scheduling MeshMapper API post in ${MESHMAPPER_DELAY_MS}ms`);
  
  state.meshMapperTimer = setTimeout(async () => {
    stopApiCountdown();
    setStatus("Posting to API...", STATUS_COLORS.info);
    
    try {
      await postToMeshMapperAPI(lat, lon);
    } catch (error) {
      debugError("MeshMapper API post failed:", error);
    }
    
    // Update map after API post
    setTimeout(() => {
      const shouldRefreshMap = accuracy && accuracy < GPS_ACCURACY_THRESHOLD_M;
      
      if (shouldRefreshMap) {
        debugLog(`Refreshing coverage map (accuracy ${accuracy}m within threshold)`);
        scheduleCoverageRefresh(lat, lon);
      } else {
        debugLog(`Skipping map refresh (accuracy ${accuracy}m exceeds threshold)`);
      }
      
      // Update status based on current mode
      if (state.connection) {
        if (state.running) {
          // Check if we should resume a paused auto countdown (manual ping during auto mode)
          const resumed = resumeAutoCountdown();
          if (!resumed) {
            // No paused timer to resume, schedule new auto ping (this was an auto ping)
            debugLog("Scheduling next auto ping");
            scheduleNextAutoPing();
          } else {
            debugLog("Resumed auto countdown after manual ping");
          }
        } else {
          debugLog("Setting status to idle");
          setStatus("Idle", STATUS_COLORS.idle);
        }
      }
    }, MAP_REFRESH_DELAY_MS);
    
    state.meshMapperTimer = null;
  }, MESHMAPPER_DELAY_MS);
}

// ---- Ping ----
/**
 * Acquire fresh GPS coordinates and update state
 * @returns {Promise<{lat: number, lon: number, accuracy: number}>} GPS coordinates
 * @throws {Error} If GPS position cannot be acquired
 */
async function acquireFreshGpsPosition() {
  const pos = await getCurrentPosition();
  const coords = {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracy: pos.coords.accuracy
  };
  debugLog(`Fresh GPS acquired: lat=${coords.lat.toFixed(5)}, lon=${coords.lon.toFixed(5)}, accuracy=${coords.accuracy}m`);
  
  state.lastFix = {
    lat: coords.lat,
    lon: coords.lon,
    accM: coords.accuracy,
    tsMs: Date.now()
  };
  updateGpsUi();
  
  return coords;
}

/**
 * Get GPS coordinates for ping operation
 * @param {boolean} isAutoMode - Whether this is an auto ping
 * @returns {Promise<{lat: number, lon: number, accuracy: number}|null>} GPS coordinates or null if unavailable
 */
async function getGpsCoordinatesForPing(isAutoMode) {
  if (isAutoMode) {
    // Auto mode: validate GPS freshness before sending
    if (!state.lastFix) {
      debugWarn("Auto ping skipped: no GPS fix available yet");
      setStatus("Waiting for GPS fix...", STATUS_COLORS.warning);
      return null;
    }
    
    // Check if GPS data is too old for auto ping
    const ageMs = Date.now() - state.lastFix.tsMs;
    const intervalMs = getSelectedIntervalMs();
    const maxAge = intervalMs + GPS_FRESHNESS_BUFFER_MS;
    
    if (ageMs >= maxAge) {
      debugLog(`GPS data too old for auto ping (${ageMs}ms), attempting to refresh`);
      setStatus("GPS data old, trying to refresh position", STATUS_COLORS.warning);
      
      try {
        return await acquireFreshGpsPosition();
      } catch (e) {
        debugError(`Could not refresh GPS position for auto ping: ${e.message}`, e);
        // Set skip reason so the countdown will show the appropriate message
        state.skipReason = "gps too old";
        return null;
      }
    }
    
    debugLog(`Using GPS watch data: lat=${state.lastFix.lat.toFixed(5)}, lon=${state.lastFix.lon.toFixed(5)} (age: ${ageMs}ms)`);
    return {
      lat: state.lastFix.lat,
      lon: state.lastFix.lon,
      accuracy: state.lastFix.accM
    };
  }
  
  // Manual mode: prefer GPS watch data if available and recent
  // This prevents timeout issues when GPS watch is already running
  const isGpsWatchActive = state.geoWatchId !== null;
  
  if (state.lastFix) {
    const ageMs = Date.now() - state.lastFix.tsMs;
    
    // If GPS watch is running, use its data if recent (to avoid concurrent requests)
    if (isGpsWatchActive && ageMs < GPS_WATCH_MAX_AGE_MS) {
      debugLog(`Using GPS watch data for manual ping (age: ${ageMs}ms, watch active)`);
      return {
        lat: state.lastFix.lat,
        lon: state.lastFix.lon,
        accuracy: state.lastFix.accM
      };
    }
    
    // If watch is not active, use cached data if fresh enough
    if (!isGpsWatchActive) {
      const intervalMs = getSelectedIntervalMs();
      const maxAge = intervalMs + GPS_FRESHNESS_BUFFER_MS;
      if (ageMs < maxAge) {
        debugLog(`Using cached GPS data (age: ${ageMs}ms, watch inactive)`);
        return {
          lat: state.lastFix.lat,
          lon: state.lastFix.lon,
          accuracy: state.lastFix.accM
        };
      }
    }
    
    // Data exists but is too old
    debugLog(`GPS data too old (${ageMs}ms), requesting fresh position`);
    setStatus("GPS data too old, requesting fresh position", STATUS_COLORS.warning);
  }
  
  // Get fresh GPS coordinates for manual ping
  debugLog("Requesting fresh GPS position for manual ping");
  try {
    return await acquireFreshGpsPosition();
  } catch (e) {
    debugError(`Could not get fresh GPS location: ${e.message}`, e);
    // Note: "Error:" prefix is intentional per UX requirements for manual ping timeout
    throw new Error("Error: could not get fresh GPS location");
  }
}

/**
 * Log ping information to the UI
 * @param {string} payload - The ping message
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 */
function logPingToUI(payload, lat, lon) {
  const nowStr = new Date().toLocaleString();
  
  if (lastPingEl) {
    lastPingEl.textContent = `${nowStr} — ${payload}`;
  }

  if (sessionPingsEl) {
    const line = `${nowStr}  ${lat.toFixed(5)} ${lon.toFixed(5)}`;
    const li = document.createElement('li');
    li.textContent = line;
    sessionPingsEl.appendChild(li);
    // Auto-scroll to bottom
    sessionPingsEl.scrollTop = sessionPingsEl.scrollHeight;
  }
}

/**
 * Send a wardrive ping with current GPS coordinates
 * @param {boolean} manual - Whether this is a manual ping (true) or auto ping (false)
 */
async function sendPing(manual = false) {
  debugLog(`sendPing called (manual=${manual})`);
  try {
    // Check cooldown only for manual pings
    if (manual && isInCooldown()) {
      const remainingSec = getRemainingCooldownSeconds();
      debugLog(`Manual ping blocked by cooldown (${remainingSec}s remaining)`);
      setStatus(`Please wait ${remainingSec}s before sending another ping`, STATUS_COLORS.warning);
      return;
    }

    // Handle countdown timers based on ping type
    if (manual && state.running) {
      // Manual ping during auto mode: pause the auto countdown
      debugLog("Manual ping during auto mode - pausing auto countdown");
      pauseAutoCountdown();
      setStatus("Sending manual ping...", STATUS_COLORS.info);
    } else if (!manual && state.running) {
      // Auto ping: stop the countdown timer to avoid status conflicts
      stopAutoCountdown();
      setStatus("Sending auto ping...", STATUS_COLORS.info);
    } else if (manual) {
      // Manual ping when auto is not running
      setStatus("Sending manual ping...", STATUS_COLORS.info);
    }

    // Get GPS coordinates
    const coords = await getGpsCoordinatesForPing(!manual && state.running);
    if (!coords) {
      // GPS not available, message already shown
      // For auto mode, schedule next attempt
      if (!manual && state.running) {
        scheduleNextAutoPing();
      }
      return;
    }
    
    const { lat, lon, accuracy } = coords;

    // VALIDATION 1: Geofence check (FIRST - must be within Ottawa 150km)
    debugLog("Starting geofence validation");
    if (!validateGeofence(lat, lon)) {
      debugLog("Ping blocked: outside geofence");
      
      // Set skip reason for auto mode countdown display
      state.skipReason = "outside geofence";
      
      if (manual) {
        // Manual ping: show skip message that persists
        setStatus("Ping skipped, outside of geo fenced region", STATUS_COLORS.warning);
      } else if (state.running) {
        // Auto ping: schedule next ping and show countdown with skip message
        scheduleNextAutoPing();
      }
      
      return;
    }
    debugLog("Geofence validation passed");

    // VALIDATION 2: Distance check (SECOND - must be ≥ 25m from last successful ping)
    debugLog("Starting distance validation");
    if (!validateMinimumDistance(lat, lon)) {
      debugLog("Ping blocked: too close to last ping");
      
      // Set skip reason for auto mode countdown display
      state.skipReason = "too close";
      
      if (manual) {
        // Manual ping: show skip message that persists
        setStatus("Ping skipped, too close to last ping", STATUS_COLORS.warning);
      } else if (state.running) {
        // Auto ping: schedule next ping and show countdown with skip message
        scheduleNextAutoPing();
      }
      
      return;
    }
    debugLog("Distance validation passed");

    // Both validations passed - execute ping operation (Mesh + API)
    debugLog("All validations passed, executing ping operation");
    
    const payload = buildPayload(lat, lon);
    debugLog(`Sending ping to channel: "${payload}"`);

    const ch = await ensureChannel();
    await state.connection.sendChannelTextMessage(ch.channelIdx, payload);
    debugLog(`Ping sent successfully to channel ${ch.channelIdx}`);

    // Ping operation succeeded - update last successful ping location
    state.lastSuccessfulPingLocation = { lat, lon };
    debugLog(`Updated last successful ping location: (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
    
    // Clear skip reason on successful ping
    state.skipReason = null;

    // Start cooldown period after successful ping
    debugLog(`Starting ${COOLDOWN_MS}ms cooldown`);
    startCooldown();

    // Update status after ping is sent
    setStatus(manual ? "Ping sent" : "Auto ping sent", STATUS_COLORS.success);
    
    // Start API countdown after brief delay to show "Ping sent" message
    setTimeout(() => {
      if (state.connection) {
        startApiCountdown(MESHMAPPER_DELAY_MS);
      }
    }, STATUS_UPDATE_DELAY_MS);

    // Schedule MeshMapper API post and map refresh
    scheduleApiPostAndMapRefresh(lat, lon, accuracy);
    
    // Update UI with ping info
    logPingToUI(payload, lat, lon);
    
    // Update distance display immediately after successful ping
    updateDistanceUi();
  } catch (e) {
    debugError(`Ping operation failed: ${e.message}`, e);
    setStatus(e.message || "Ping failed", STATUS_COLORS.error);
  }
}

// ---- Auto mode ----
function stopAutoPing(stopGps = false) {
  debugLog(`stopAutoPing called (stopGps=${stopGps})`);
  // Check if we're in cooldown before stopping (unless stopGps is true for disconnect)
  if (!stopGps && isInCooldown()) {
    const remainingSec = getRemainingCooldownSeconds();
    debugLog(`Auto ping stop blocked by cooldown (${remainingSec}s remaining)`);
    setStatus(`Please wait ${remainingSec}s before toggling auto mode`, STATUS_COLORS.warning);
    return;
  }
  
  if (state.autoTimerId) {
    debugLog("Clearing auto ping timer");
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Clear skip reason and paused timer state
  state.skipReason = null;
  state.pausedAutoTimerRemainingMs = null;
  
  // Only stop GPS watch when disconnecting or page hidden, not during normal stop
  if (stopGps) {
    stopGeoWatch();
  }
  
  state.running = false;
  updateAutoButton();
  releaseWakeLock();
  debugLog("Auto ping stopped");
}
function scheduleNextAutoPing() {
  if (!state.running) {
    debugLog("Not scheduling next auto ping - auto mode not running");
    return;
  }
  
  const intervalMs = getSelectedIntervalMs();
  debugLog(`Scheduling next auto ping in ${intervalMs}ms`);
  
  // Start countdown immediately (skipReason may be set if ping was skipped)
  startAutoCountdown(intervalMs);
  
  // Schedule the next ping
  state.autoTimerId = setTimeout(() => {
    if (state.running) {
      // Clear skip reason before next attempt
      state.skipReason = null;
      debugLog("Auto ping timer fired, sending ping");
      sendPing(false).catch(console.error);
    }
  }, intervalMs);
}

function startAutoPing() {
  debugLog("startAutoPing called");
  if (!state.connection) {
    debugError("Cannot start auto ping - not connected");
    alert("Connect to a MeshCore device first.");
    return;
  }
  
  // Check if we're in cooldown
  if (isInCooldown()) {
    const remainingSec = getRemainingCooldownSeconds();
    debugLog(`Auto ping start blocked by cooldown (${remainingSec}s remaining)`);
    setStatus(`Please wait ${remainingSec}s before toggling auto mode`, STATUS_COLORS.warning);
    return;
  }
  
  // Clean up any existing auto-ping timer (but keep GPS watch running)
  if (state.autoTimerId) {
    debugLog("Clearing existing auto ping timer");
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Clear any previous skip reason
  state.skipReason = null;
  
  // Start GPS watch for continuous updates
  debugLog("Starting GPS watch for auto mode");
  startGeoWatch();
  
  state.running = true;
  updateAutoButton();

  // Acquire wake lock for auto mode
  debugLog("Acquiring wake lock for auto mode");
  acquireWakeLock().catch(console.error);

  // Send first ping immediately
  debugLog("Sending initial auto ping");
  sendPing(false).catch(console.error);
}

// ---- BLE connect / disconnect ----
async function connect() {
  debugLog("connect() called");
  if (!("bluetooth" in navigator)) {
    debugError("Web Bluetooth not supported");
    alert("Web Bluetooth not supported in this browser.");
    return;
  }
  connectBtn.disabled = true;
  setStatus("Connecting…", STATUS_COLORS.info);

  try {
    debugLog("Opening BLE connection...");
    const conn = await WebBleConnection.open();
    state.connection = conn;
    debugLog("BLE connection object created");

    conn.on("connected", async () => {
      debugLog("BLE connected event fired");
      setStatus("Connected", STATUS_COLORS.success);
      setConnectButton(true);
      connectBtn.disabled = false;
      const selfInfo = await conn.getSelfInfo();
      debugLog(`Device info: ${selfInfo?.name || "[No device]"}`);
      deviceInfoEl.textContent = selfInfo?.name || "[No device]";
      updateAutoButton();
      try { 
        await conn.syncDeviceTime?.(); 
        debugLog("Device time synced");
      } catch { 
        debugLog("Device time sync not available or failed");
      }
      try {
        await ensureChannel();
        await primeGpsOnce();
      } catch (e) {
        debugError(`Channel setup failed: ${e.message}`, e);
        setStatus(e.message || "Channel setup failed", STATUS_COLORS.error);
      }
    });

    conn.on("disconnected", () => {
      debugLog("BLE disconnected event fired");
      setStatus("Disconnected", STATUS_COLORS.error);
      setConnectButton(false);
      deviceInfoEl.textContent = "—";
      state.connection = null;
      state.channel = null;
      stopAutoPing(true); // Ignore cooldown check on disconnect
      enableControls(false);
      updateAutoButton();
      stopGeoWatch();
      stopGpsAgeUpdater(); // Ensure age updater stops
      stopDistanceUpdater(); // Ensure distance updater stops
      
      // Clean up all timers
      cleanupAllTimers();
      
      state.lastFix = null;
      state.lastSuccessfulPingLocation = null;
      state.gpsState = "idle";
      updateGpsUi();
      updateDistanceUi();
      debugLog("Disconnect cleanup complete");
    });

  } catch (e) {
    debugError(`BLE connection failed: ${e.message}`, e);
    setStatus("Failed to connect", STATUS_COLORS.error);
    connectBtn.disabled = false;
  }
}
async function disconnect() {
  debugLog("disconnect() called");
  if (!state.connection) {
    debugLog("No connection to disconnect");
    return;
  }

  connectBtn.disabled = true;
  setStatus("Disconnecting...", STATUS_COLORS.info);

  try {
    // WebBleConnection typically exposes one of these.
    if (typeof state.connection.close === "function") {
      debugLog("Calling connection.close()");
      await state.connection.close();
    } else if (typeof state.connection.disconnect === "function") {
      debugLog("Calling connection.disconnect()");
      await state.connection.disconnect();
    } else if (typeof state.connection.device?.gatt?.disconnect === "function") {
      debugLog("Calling device.gatt.disconnect()");
      state.connection.device.gatt.disconnect();
    } else {
      debugWarn("No known disconnect method on connection object");
    }
  } catch (e) {
    debugError(`BLE disconnect failed: ${e.message}`, e);
    setStatus(e.message || "Disconnect failed", STATUS_COLORS.error);
  } finally {
    connectBtn.disabled = false;
  }
}


// ---- Page visibility ----
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    debugLog("Page visibility changed to hidden");
    if (state.running) {
      debugLog("Stopping auto ping due to page hidden");
      stopAutoPing(true); // Ignore cooldown check when page is hidden
      setStatus("Lost focus, auto mode stopped", STATUS_COLORS.warning);
    } else {
      debugLog("Releasing wake lock due to page hidden");
      releaseWakeLock();
    }
  } else {
    debugLog("Page visibility changed to visible");
    // On visible again, user can manually re-start Auto.
  }
});

// ---- Bind UI & init ----
export async function onLoad() {
  debugLog("wardrive.js onLoad() called - initializing");
  setStatus("Disconnected", STATUS_COLORS.error);
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
      debugError(`Connection button error: ${e.message}`, e);
      setStatus(e.message || "Connection error", STATUS_COLORS.error);
    }
  });
  sendPingBtn.addEventListener("click", () => {
    debugLog("Manual ping button clicked");
    sendPing(true).catch(console.error);
  });
  autoToggleBtn.addEventListener("click", () => {
    debugLog("Auto toggle button clicked");
    if (state.running) {
      stopAutoPing();
      setStatus("Auto mode stopped", STATUS_COLORS.idle);
    } else {
      startAutoPing();
    }
  });

  // Prompt location permission early (optional)
  debugLog("Requesting initial location permission");
  try { 
    await getCurrentPosition(); 
    debugLog("Initial location permission granted");
  } catch (e) { 
    debugLog(`Initial location permission not granted: ${e.message}`);
  }
  debugLog("wardrive.js initialization complete");
}
