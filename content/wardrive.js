
// Minimal Wardrive sender with wake locks:
// - Connect to MeshCore Companion via Web Bluetooth (BLE)
// - Send pings as "@[MapperBot]<LAT LON>[ <power> ]" (power only if specified)
// - Manual "Send Ping" and Auto mode (interval selectable: 15/30/60s)
// - Acquire wake lock during auto mode to keep screen awake

import { WebBleConnection, Constants, Packet, BufferUtils } from "./mc/index.js"; // your BLE client

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
const RX_LOG_LISTEN_WINDOW_MS = 7000;          // Listen window for repeater echoes (7 seconds)

// Pre-computed channel hash and key for the wardriving channel
// These will be computed once at startup and used for message correlation and decryption
let WARDRIVING_CHANNEL_HASH = null;
let WARDRIVING_CHANNEL_KEY = null;

// Initialize the wardriving channel hash and key at startup
(async function initializeChannelHash() {
  try {
    WARDRIVING_CHANNEL_KEY = await deriveChannelKey(CHANNEL_NAME);
    WARDRIVING_CHANNEL_HASH = await computeChannelHash(WARDRIVING_CHANNEL_KEY);
    debugLog(`Wardriving channel hash pre-computed at startup: 0x${WARDRIVING_CHANNEL_HASH.toString(16).padStart(2, '0')}`);
    debugLog(`Wardriving channel key cached for message decryption (${WARDRIVING_CHANNEL_KEY.length} bytes)`);
  } catch (error) {
    debugError(`CRITICAL: Failed to pre-compute channel hash/key: ${error.message}`);
    debugError(`Repeater echo tracking will be disabled. Please reload the page.`);
    // Channel hash and key remain null, which will be checked before starting tracking
  }
})();

// Ottawa Geofence Configuration
const OTTAWA_CENTER_LAT = 45.4215;  // Parliament Hill latitude
const OTTAWA_CENTER_LON = -75.6972; // Parliament Hill longitude
const OTTAWA_GEOFENCE_RADIUS_M = 150000; // 150 km in meters

// Distance-Based Ping Filtering
const MIN_PING_DISTANCE_M = 25; // Minimum distance (25m) between pings

// MeshMapper API Configuration
const MESHMAPPER_API_URL = "https://yow.meshmapper.net/wardriving-api.php";
const MESHMAPPER_CAPACITY_CHECK_URL = "https://yow.meshmapper.net/capacitycheck.php";
const MESHMAPPER_API_KEY = "59C7754DABDF5C11CA5F5D8368F89";
const MESHMAPPER_DEFAULT_WHO = "GOME-WarDriver"; // Default identifier

// ---- App Version Configuration ----
// This constant is injected by GitHub Actions during build/deploy
// For release builds: Contains the release version (e.g., "v1.3.0")
// For DEV builds: Contains "DEV-<EPOCH>" format (e.g., "DEV-1734652800")
const APP_VERSION = "UNKNOWN"; // Placeholder - replaced during build

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
  rxListeningEndTime: null, // Timestamp when RX listening window ends
  skipReason: null, // Reason for skipping a ping - internal value only (e.g., "gps too old")
  pausedAutoTimerRemainingMs: null, // Remaining time when auto ping timer was paused by manual ping
  lastSuccessfulPingLocation: null, // { lat, lon } of the last successful ping (Mesh + API)
  distanceUpdateTimer: null, // Timer for updating distance display
  capturedPingCoords: null, // { lat, lon, accuracy } captured at ping time, used for API post after 7s delay
  devicePublicKey: null, // Hex string of device's public key (used for capacity check)
  disconnectReason: null, // Tracks the reason for disconnection (e.g., "app_down", "capacity_full", "error", "normal")
  repeaterTracking: {
    isListening: false,           // Whether we're currently listening for echoes
    sentTimestamp: null,          // Timestamp when the ping was sent
    sentPayload: null,            // The payload text that was sent
    channelIdx: null,             // Channel index for reference
    repeaters: new Map(),         // Map<repeaterId, {snr, seenCount}>
    listenTimeout: null,          // Timeout handle for 7-second window
    rxLogHandler: null,           // Handler function for rx_log events
  }
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

// Status message management with minimum visibility duration
const MIN_STATUS_VISIBILITY_MS = 500; // Minimum time a status message must remain visible
const statusMessageState = {
  lastSetTime: 0,           // Timestamp when status was last set
  pendingMessage: null,     // Pending message to display after minimum visibility
  pendingTimer: null,       // Timer for pending message
  currentText: '',          // Current status text
  currentColor: ''          // Current status color
};

/**
 * Set status message with minimum visibility enforcement
 * Non-timed status messages will remain visible for at least 500ms before being replaced
 * @param {string} text - Status message text
 * @param {string} color - Status color class
 * @param {boolean} immediate - If true, bypass minimum visibility (for countdown timers)
 */
function setStatus(text, color = STATUS_COLORS.idle, immediate = false) {
  const now = Date.now();
  const timeSinceLastSet = now - statusMessageState.lastSetTime;
  
  // Special case: if this is the same message, update timestamp without changing UI
  // This prevents countdown timer updates from being delayed unnecessarily
  // Example: If status is already "Waiting (10s)", the next "Waiting (9s)" won't be delayed
  if (text === statusMessageState.currentText && color === statusMessageState.currentColor) {
    debugLog(`Status update (same message): "${text}"`);
    statusMessageState.lastSetTime = now;
    return;
  }
  
  // If immediate flag is set (for countdown timers), apply immediately
  if (immediate) {
    applyStatusImmediately(text, color);
    return;
  }
  
  // If minimum visibility time has passed, apply immediately
  if (timeSinceLastSet >= MIN_STATUS_VISIBILITY_MS) {
    applyStatusImmediately(text, color);
    return;
  }
  
  // Minimum visibility time has not passed, queue the message
  const delayNeeded = MIN_STATUS_VISIBILITY_MS - timeSinceLastSet;
  debugLog(`Status queued (${delayNeeded}ms delay): "${text}" (current: "${statusMessageState.currentText}")`);
  
  // Store pending message
  statusMessageState.pendingMessage = { text, color };
  
  // Clear any existing pending timer
  if (statusMessageState.pendingTimer) {
    clearTimeout(statusMessageState.pendingTimer);
  }
  
  // Schedule the pending message
  statusMessageState.pendingTimer = setTimeout(() => {
    if (statusMessageState.pendingMessage) {
      const pending = statusMessageState.pendingMessage;
      statusMessageState.pendingMessage = null;
      statusMessageState.pendingTimer = null;
      applyStatusImmediately(pending.text, pending.color);
    }
  }, delayNeeded);
}

/**
 * Apply status message immediately to the UI
 * @param {string} text - Status message text
 * @param {string} color - Status color class
 */
function applyStatusImmediately(text, color) {
  statusEl.textContent = text;
  statusEl.className = `font-semibold ${color}`;
  statusMessageState.lastSetTime = Date.now();
  statusMessageState.currentText = text;
  statusMessageState.currentColor = color;
  debugLog(`Status applied: "${text}"`);
}

/**
 * Apply status message from countdown timer result
 * @param {string|{message: string, color: string}|null} result - Status message (string) or object with message and optional color
 * @param {string} defaultColor - Default color to use if result is a string or object without color
 * @param {boolean} immediate - If true, bypass minimum visibility (for countdown updates)
 */
function applyCountdownStatus(result, defaultColor, immediate = true) {
  if (!result) return;
  if (typeof result === 'string') {
    setStatus(result, defaultColor, immediate);
  } else {
    setStatus(result.message, result.color || defaultColor, immediate);
  }
}

// Countdown timer management - generalized for reuse
function createCountdownTimer(getEndTime, getStatusMessage) {
  return {
    timerId: null,
    endTime: null,
    // Track if this is the first update after starting the countdown
    // First update respects minimum visibility of the previous status message
    // Subsequent updates apply immediately for smooth countdown display (every 1 second)
    isFirstUpdate: true,
    
    start(durationMs) {
      this.stop();
      this.endTime = Date.now() + durationMs;
      this.isFirstUpdate = true; // Reset flag when starting
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
      // First update respects minimum visibility of previous message
      // Subsequent updates are immediate for smooth 1-second countdown intervals
      const immediate = !this.isFirstUpdate;
      applyCountdownStatus(getStatusMessage(remainingSec), STATUS_COLORS.idle, immediate);
      // Mark first update as complete after calling applyCountdownStatus
      this.isFirstUpdate = false;
    },
    
    stop() {
      if (this.timerId) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
      this.endTime = null;
      this.isFirstUpdate = true; // Reset flag when stopping
    }
  };
}

// Auto ping countdown timer
const autoCountdownTimer = createCountdownTimer(
  () => state.nextAutoPingTime,
  (remainingSec) => {
    if (!state.running) return null;
    if (remainingSec === 0) {
      return { message: "Sending auto ping", color: STATUS_COLORS.info };
    }
    // If there's a skip reason, show it with the countdown in warning color
    if (state.skipReason === "outside geofence") {
      return { 
        message: `Ping skipped, outside of geofenced region, waiting for next ping (${remainingSec}s)`,
        color: STATUS_COLORS.warning
      };
    }
    if (state.skipReason === "too close") {
      return { 
        message: `Ping skipped, too close to last ping, waiting for next ping (${remainingSec}s)`,
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

// RX listening countdown timer (for heard repeats)
const rxListeningCountdownTimer = createCountdownTimer(
  () => state.rxListeningEndTime,
  (remainingSec) => {
    if (remainingSec === 0) {
      return { message: "Finalizing heard repeats", color: STATUS_COLORS.info };
    }
    return { 
      message: `Listening for heard repeats (${remainingSec}s)`,
      color: STATUS_COLORS.info
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

function startRxListeningCountdown(delayMs) {
  debugLog(`Starting RX listening countdown: ${delayMs}ms`);
  state.rxListeningEndTime = Date.now() + delayMs;
  rxListeningCountdownTimer.start(delayMs);
}

function stopRxListeningCountdown() {
  debugLog(`Stopping RX listening countdown`);
  state.rxListeningEndTime = null;
  rxListeningCountdownTimer.stop();
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
  
  // Clean up status message timer
  if (statusMessageState.pendingTimer) {
    clearTimeout(statusMessageState.pendingTimer);
    statusMessageState.pendingTimer = null;
    statusMessageState.pendingMessage = null;
  }
  
  // Clean up state timer references
  state.autoCountdownTimer = null;
  
  stopAutoCountdown();
  stopRxListeningCountdown();
  state.cooldownEndTime = null;
  state.pausedAutoTimerRemainingMs = null;
  
  // Clear captured ping coordinates
  state.capturedPingCoords = null;
  
  // Clear device public key
  state.devicePublicKey = null;
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


// ---- Key Derivation ----
/**
 * Derives a 16-byte channel key from a hashtag channel name using SHA-256.
 * This allows any hashtag channel to be used (e.g., #wardriving, #wardrive, #test).
 * Channel names must start with # and contain only a-z, 0-9, and dashes.
 * 
 * Algorithm: sha256(channelName).subarray(0, 16)
 * 
 * @param {string} channelName - The hashtag channel name (e.g., "#wardriving")
 * @returns {Promise<Uint8Array>} A 16-byte key derived from the channel name
 * @throws {Error} If channel name format is invalid
 */
async function deriveChannelKey(channelName) {
  // Check if Web Crypto API is available
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(
      'Web Crypto API is not available. This app requires HTTPS or a modern browser with crypto.subtle support.'
    );
  }
  
  // Validate channel name format: must start with # and contain only letters, numbers, and dashes
  if (!channelName.startsWith('#')) {
    throw new Error(`Channel name must start with # (got: "${channelName}")`);
  }
  
  // Normalize channel name to lowercase (MeshCore convention)
  const normalizedName = channelName.toLowerCase();
  
  // Check that the part after # contains only letters, numbers, and dashes
  const nameWithoutHash = normalizedName.slice(1);
  if (!/^[a-z0-9-]+$/.test(nameWithoutHash)) {
    throw new Error(
      `Channel name "${channelName}" contains invalid characters. Only letters, numbers, and dashes are allowed.`
    );
  }
  
  // Encode the normalized channel name as UTF-8
  const encoder = new TextEncoder();
  const data = encoder.encode(normalizedName);
  
  // Hash using SHA-256
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  
  // Take the first 16 bytes of the hash as the channel key
  // This matches the pseudocode: sha256(#name).subarray(0, 16)
  const hashArray = new Uint8Array(hashBuffer);
  const channelKey = hashArray.slice(0, 16);
  
  debugLog(`Channel key derived successfully (${channelKey.length} bytes)`);
  
  return channelKey;
}

// ---- Channel helpers ----
async function createWardriveChannel() {
  if (!state.connection) throw new Error("Not connected");
  
  debugLog(`Attempting to create channel: ${CHANNEL_NAME}`);
  
  // Get all channels
  const channels = await state.connection.getChannels();
  debugLog(`Retrieved ${channels.length} channels`);
  
  // Find first empty channel slot
  let emptyIdx = -1;
  for (let i = 0; i < channels.length; i++) {
    if (channels[i].name === '') {
      emptyIdx = i;
      debugLog(`Found empty channel slot at index: ${emptyIdx}`);
      break;
    }
  }
  
  // Throw error if no free slots
  if (emptyIdx === -1) {
    debugError(`No empty channel slots available`);
    throw new Error(
      `No empty channel slots available. Please free a channel slot on your companion first.`
    );
  }
  
  // Derive the channel key from the channel name
  const channelKey = await deriveChannelKey(CHANNEL_NAME);
  
  // Create the channel
  debugLog(`Creating channel ${CHANNEL_NAME} at index ${emptyIdx}`);
  await state.connection.setChannel(emptyIdx, CHANNEL_NAME, channelKey);
  debugLog(`Channel ${CHANNEL_NAME} created successfully at index ${emptyIdx}`);
  
  // Return channel object
  return {
    channelIdx: emptyIdx,
    name: CHANNEL_NAME
  };
}

async function ensureChannel() {
  if (!state.connection) throw new Error("Not connected");
  if (state.channel) {
    debugLog(`Using existing channel: ${CHANNEL_NAME}`);
    return state.channel;
  }

  debugLog(`Looking up channel: ${CHANNEL_NAME}`);
  let ch = await state.connection.findChannelByName(CHANNEL_NAME);
  
  if (!ch) {
    debugLog(`Channel ${CHANNEL_NAME} not found, attempting to create it`);
    try {
      ch = await createWardriveChannel();
      debugLog(`Channel ${CHANNEL_NAME} created successfully`);
    } catch (e) {
      debugError(`Failed to create channel ${CHANNEL_NAME}: ${e.message}`);
      enableControls(false);
      throw new Error(
        `Channel ${CHANNEL_NAME} not found and could not be created: ${e.message}`
      );
    }
  } else {
    debugLog(`Channel found: ${CHANNEL_NAME} (index: ${ch.channelIdx})`);
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

function getCurrentPowerSetting() {
  const checkedPower = document.querySelector('input[name="power"]:checked');
  return checkedPower ? checkedPower.value : "";
}

function buildPayload(lat, lon) {
  const coordsStr = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const power = getCurrentPowerSetting();
  const suffix = power ? ` [${power}]` : "";
  return `${PING_PREFIX} ${coordsStr}${suffix}`.trim();
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
 * Check capacity / slot availability with MeshMapper API
 * @param {string} reason - Either "connect" (acquire slot) or "disconnect" (release slot)
 * @returns {Promise<boolean>} True if allowed to continue, false otherwise
 */
async function checkCapacity(reason) {
  // Validate public key exists
  if (!state.devicePublicKey) {
    debugError("checkCapacity called but no public key stored");
    return reason === "connect" ? false : true; // Fail closed on connect, allow disconnect
  }

  // Set status for connect requests
  if (reason === "connect") {
    setStatus("Acquiring wardriving slot", STATUS_COLORS.info);
  }

  try {
    const payload = {
      key: MESHMAPPER_API_KEY,
      public_key: state.devicePublicKey,
      who: getDeviceIdentifier(),
      reason: reason
    };

    debugLog(`Checking capacity: reason=${reason}, public_key=${state.devicePublicKey.substring(0, 16)}..., who=${payload.who}`);

    const response = await fetch(MESHMAPPER_CAPACITY_CHECK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      debugWarn(`Capacity check API returned error status ${response.status}`);
      // Fail closed on network errors for connect
      if (reason === "connect") {
        debugError("Failing closed (denying connection) due to API error");
        setStatus("Disconnected: WarDriving app is down", STATUS_COLORS.error);
        state.disconnectReason = "app_down"; // Track disconnect reason
        return false;
      }
      return true; // Always allow disconnect to proceed
    }

    const data = await response.json();
    debugLog(`Capacity check response: allowed=${data.allowed}`);

    // Handle capacity full vs. allowed cases separately
    if (data.allowed === false && reason === "connect") {
      setStatus("Disconnected: WarDriving app has reached capacity", STATUS_COLORS.error);
      state.disconnectReason = "capacity_full"; // Track disconnect reason
    }
    
    return data.allowed === true;

  } catch (error) {
    debugError(`Capacity check failed: ${error.message}`);
    
    // Fail closed on network errors for connect
    if (reason === "connect") {
      debugError("Failing closed (denying connection) due to network error");
      setStatus("Disconnected: WarDriving app is down", STATUS_COLORS.error);
      state.disconnectReason = "app_down"; // Track disconnect reason
      return false;
    }
    
    return true; // Always allow disconnect to proceed
  }
}

/**
 * Post wardrive ping data to MeshMapper API
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {string} heardRepeats - Heard repeats string (e.g., "4e(1.75),b7(-0.75)" or "None")
 */
async function postToMeshMapperAPI(lat, lon, heardRepeats) {
  try {
    const payload = {
      key: MESHMAPPER_API_KEY,
      lat,
      lon,
      who: getDeviceIdentifier(),
      power: getCurrentPowerSetting() || "N/A",
      heard_repeats: heardRepeats,
      ver: APP_VERSION,
      test: 0
    };

    debugLog(`Posting to MeshMapper API: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, who=${payload.who}, power=${payload.power}, heard_repeats=${heardRepeats}, ver=${payload.ver}`);

    const response = await fetch(MESHMAPPER_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    debugLog(`MeshMapper API response status: ${response.status}`);

    // Always try to parse the response body to check for slot revocation
    // regardless of HTTP status code
    try {
      const data = await response.json();
      debugLog(`MeshMapper API response data: ${JSON.stringify(data)}`);
      
      // Check if slot has been revoked
      if (data.allowed === false) {
        debugWarn("MeshMapper API returned allowed=false, WarDriving slot has been revoked, disconnecting");
        setStatus("Disconnected: WarDriving slot has been revoked", STATUS_COLORS.error);
        state.disconnectReason = "slot_revoked"; // Track disconnect reason
        // Disconnect after a brief delay to ensure user sees the message
        setTimeout(() => {
          disconnect().catch(err => debugError(`Disconnect after slot revocation failed: ${err.message}`));
        }, 1500);
        return; // Exit early after slot revocation
      } else if (data.allowed === true) {
        debugLog("MeshMapper API allowed check passed: device still has an active WarDriving slot");
      } else {
        debugWarn(`MeshMapper API response missing 'allowed' field: ${JSON.stringify(data)}`);
      }
    } catch (parseError) {
      debugWarn(`Failed to parse MeshMapper API response: ${parseError.message}`);
      // Continue operation if we can't parse the response
    }

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
 * Post to MeshMapper API and refresh coverage map after heard repeats are finalized
 * This executes immediately (no delay) because it's called after the RX listening window
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} accuracy - GPS accuracy in meters
 * @param {string} heardRepeats - Heard repeats string (e.g., "4e(1.75),b7(-0.75)" or "None")
 */
async function postApiAndRefreshMap(lat, lon, accuracy, heardRepeats) {
  debugLog(`postApiAndRefreshMap called with heard_repeats="${heardRepeats}"`);
  
  setStatus("Posting to API", STATUS_COLORS.info);
  
  // Hidden 3-second delay before API POST (user sees "Posting to API" status during this time)
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  try {
    await postToMeshMapperAPI(lat, lon, heardRepeats);
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
}

// ---- Repeater Echo Tracking ----

/**
 * Compute channel hash from channel secret (first byte of SHA-256)
 * @param {Uint8Array} channelSecret - The 16-byte channel secret
 * @returns {Promise<number>} The channel hash (first byte of SHA-256)
 */
async function computeChannelHash(channelSecret) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', channelSecret);
  const hashArray = new Uint8Array(hashBuffer);
  return hashArray[0];
}

/**
 * Decrypt GroupText payload and extract message text
 * Payload structure: [1 byte channel_hash][2 bytes MAC][encrypted data]
 * Encrypted data: [4 bytes timestamp][1 byte flags][message text]
 * @param {Uint8Array} payload - The packet payload
 * @param {Uint8Array} channelKey - The 16-byte channel secret for decryption
 * @returns {Promise<string|null>} The decrypted message text, or null if decryption fails
 */
async function decryptGroupTextPayload(payload, channelKey) {
  try {
    debugLog(`[DECRYPT] Starting GroupText payload decryption`);
    debugLog(`[DECRYPT] Payload length: ${payload.length} bytes`);
    debugLog(`[DECRYPT] Channel key length: ${channelKey.length} bytes`);
    
    // Validate payload length
    if (payload.length < 3) {
      debugLog(`[DECRYPT] ABORT: Payload too short for decryption (${payload.length} bytes, need at least 3)`);
      return null;
    }
    
    // Extract components
    const channelHash = payload[0];
    const cipherMAC = payload.slice(1, 3);
    const encryptedData = payload.slice(3);
    
    debugLog(`[DECRYPT] Channel hash: 0x${channelHash.toString(16).padStart(2, '0')}`);
    debugLog(`[DECRYPT] Cipher MAC: ${Array.from(cipherMAC).map(b => b.toString(16).padStart(2, '0')).join('')}`);
    debugLog(`[DECRYPT] Encrypted data length: ${encryptedData.length} bytes`);
    
    if (encryptedData.length === 0) {
      debugLog(`[DECRYPT] ABORT: No encrypted data to decrypt`);
      return null;
    }
    
    // Log first 32 bytes of encrypted data for debugging
    const encPreview = Array.from(encryptedData.slice(0, Math.min(32, encryptedData.length)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    debugLog(`[DECRYPT] Encrypted data preview (first 32 bytes): ${encPreview}...`);
    
    // Use aes-js library for proper AES-ECB decryption
    debugLog(`[DECRYPT] Using aes-js library for AES-ECB decryption`);
    
    // Check if aes-js is available
    if (typeof aesjs === 'undefined') {
      debugError(`[DECRYPT] ABORT: aes-js library not loaded`);
      return null;
    }
    
    // Convert Uint8Array to regular array for aes-js
    const keyArray = Array.from(channelKey);
    const encryptedArray = Array.from(encryptedData);
    
    debugLog(`[DECRYPT] Decrypting ${encryptedData.length} bytes with AES-ECB...`);
    
    // Create AES-ECB decryption instance
    const aesCbc = new aesjs.ModeOfOperation.ecb(keyArray);
    
    // Decrypt block by block (ECB processes each 16-byte block independently)
    const blockSize = 16;
    const decryptedBytes = new Uint8Array(encryptedArray.length);
    
    for (let i = 0; i < encryptedArray.length; i += blockSize) {
      const block = encryptedArray.slice(i, i + blockSize);
      
      // Pad last block if necessary
      while (block.length < blockSize) {
        block.push(0);
      }
      
      const decryptedBlock = aesCbc.decrypt(block);
      decryptedBytes.set(decryptedBlock, i);
    }
    
    debugLog(`[DECRYPT] Decryption completed successfully`);
    debugLog(`[DECRYPT] Decrypted data length: ${decryptedBytes.length} bytes`);
    
    // Log decrypted bytes for debugging
    const decPreview = Array.from(decryptedBytes.slice(0, Math.min(32, decryptedBytes.length)))
      .map(b => b.toString(16).padStart(2, '0')).join(' ');
    debugLog(`[DECRYPT] Decrypted data preview (first 32 bytes): ${decPreview}...`);
    
    // Decrypted structure: [4 bytes timestamp][1 byte flags][message text]
    if (decryptedBytes.length < 5) {
      debugLog(`[DECRYPT] ABORT: Decrypted data too short (${decryptedBytes.length} bytes, need at least 5)`);
      return null;
    }
    
    // Extract timestamp (4 bytes, little-endian)
    const timestamp = decryptedBytes[0] | (decryptedBytes[1] << 8) | (decryptedBytes[2] << 16) | (decryptedBytes[3] << 24);
    debugLog(`[DECRYPT] Timestamp: ${timestamp} (${new Date(timestamp * 1000).toISOString()})`);
    
    // Extract flags (1 byte)
    const flags = decryptedBytes[4];
    debugLog(`[DECRYPT] Flags: 0x${flags.toString(16).padStart(2, '0')}`);
    
    // Extract message (remaining bytes)
    const messageBytes = decryptedBytes.slice(5);
    debugLog(`[DECRYPT] Message bytes length: ${messageBytes.length}`);
    
    // Decode as UTF-8 and strip null terminators
    const decoder = new TextDecoder('utf-8');
    const messageText = decoder.decode(messageBytes).replace(/\0+$/, '').trim();
    
    debugLog(`[DECRYPT] ✅ Message decrypted successfully: "${messageText}"`);
    debugLog(`[DECRYPT] Message length: ${messageText.length} characters`);
    
    return messageText;
    
  } catch (error) {
    debugError(`[DECRYPT] ❌ Failed to decrypt GroupText payload: ${error.message}`);
    debugError(`[DECRYPT] Error stack: ${error.stack}`);
    return null;
  }
}

/**
 * Start listening for repeater echoes via rx_log
 * Uses the pre-computed WARDRIVING_CHANNEL_HASH for message correlation
 * @param {string} payload - The ping payload that was sent
 * @param {number} channelIdx - The channel index where the ping was sent
 */
function startRepeaterTracking(payload, channelIdx) {
  debugLog(`Starting repeater echo tracking for ping: "${payload}" on channel ${channelIdx}`);
  debugLog(`7-second rx_log listening window opened at ${new Date().toISOString()}`);
  
  // Verify we have the channel hash
  if (WARDRIVING_CHANNEL_HASH === null) {
    debugError(`Cannot start repeater tracking: channel hash not initialized`);
    return;
  }
  
  // Clear any existing tracking state
  stopRepeaterTracking();
  
  debugLog(`Using pre-computed channel hash for correlation: 0x${WARDRIVING_CHANNEL_HASH.toString(16).padStart(2, '0')}`);
  
  // Initialize tracking state
  state.repeaterTracking.isListening = true;
  state.repeaterTracking.sentTimestamp = Date.now();
  state.repeaterTracking.sentPayload = payload;
  state.repeaterTracking.channelIdx = channelIdx;
  state.repeaterTracking.repeaters.clear();
  
  // Create the rx_log handler
  const rxLogHandler = (data) => {
    handleRxLogEvent(data, payload, channelIdx, WARDRIVING_CHANNEL_HASH);
  };
  
  // Store the handler so we can remove it later
  state.repeaterTracking.rxLogHandler = rxLogHandler;
  
  // Listen for rx_log events
  if (state.connection) {
    state.connection.on(Constants.PushCodes.LogRxData, rxLogHandler);
    debugLog(`Registered LogRxData event handler`);
  }
  
  // Note: The 7-second timeout to stop listening is managed by the caller (sendPing function)
  // This allows the caller to both stop tracking AND retrieve results at the same time
}

/**
 * Handle an rx_log event and check if it's a repeater echo of our ping
 * @param {Object} data - The LogRxData event data (contains lastSnr, lastRssi, raw)
 * @param {string} originalPayload - The payload we sent
 * @param {number} channelIdx - The channel index where we sent the ping
 * @param {number} expectedChannelHash - The channel hash we expect (for message correlation)
 */
async function handleRxLogEvent(data, originalPayload, channelIdx, expectedChannelHash) {
  try {
    debugLog(`Received rx_log entry: SNR=${data.lastSnr}, RSSI=${data.lastRssi}`);
    
    // Parse the packet from raw data
    const packet = Packet.fromBytes(data.raw);
    
    // VALIDATION STEP 1: Header validation (MUST occur before all other checks)
    // Expected header for channel GroupText packets: 0x15
    // Binary: 00 0101 01
    // - Bits 0-1: Route Type = 01 (Flood)
    // - Bits 2-5: Payload Type = 0101 (GroupText = 5)
    // - Bits 6-7: Protocol Version = 00
    const EXPECTED_HEADER = 0x15;
    if (packet.header !== EXPECTED_HEADER) {
      debugLog(`Ignoring rx_log entry: header validation failed (header=0x${packet.header.toString(16).padStart(2, '0')}, expected=0x${EXPECTED_HEADER.toString(16).padStart(2, '0')})`);
      return;
    }
    
    debugLog(`Parsed packet: header=0x${packet.header.toString(16).padStart(2, '0')}, route_type=${packet.route_type_string}, payload_type=${packet.payload_type_string}, path_len=${packet.path.length}`);
    debugLog(`Header validation passed: 0x${packet.header.toString(16).padStart(2, '0')}`);
    
    // VALIDATION STEP 2: Verify payload type is GRP_TXT (redundant with header check but kept for clarity)
    if (packet.payload_type !== Packet.PAYLOAD_TYPE_GRP_TXT) {
      debugLog(`Ignoring rx_log entry: not a channel message (payload_type=${packet.payload_type})`);
      return;
    }
    
    // VALIDATION STEP 3: Validate this message is for our channel by comparing channel hash
    // Channel message payload structure: [1 byte channel_hash][2 bytes MAC][encrypted message]
    if (packet.payload.length < 3) {
      debugLog(`Ignoring rx_log entry: payload too short to contain channel hash`);
      return;
    }
    
    const packetChannelHash = packet.payload[0];
    debugLog(`Message correlation check: packet_channel_hash=0x${packetChannelHash.toString(16).padStart(2, '0')}, expected=0x${expectedChannelHash.toString(16).padStart(2, '0')}`);
    
    if (packetChannelHash !== expectedChannelHash) {
      debugLog(`Ignoring rx_log entry: channel hash mismatch (packet=0x${packetChannelHash.toString(16).padStart(2, '0')}, expected=0x${expectedChannelHash.toString(16).padStart(2, '0')})`);
      return;
    }
    
    debugLog(`Channel hash match confirmed - this is a message on our channel`);
    
    // VALIDATION STEP 4: Decrypt and verify message content matches what we sent
    // This ensures we're tracking echoes of OUR specific ping, not other messages on the channel
    debugLog(`[MESSAGE_CORRELATION] Starting message content verification...`);
    
    if (WARDRIVING_CHANNEL_KEY) {
      debugLog(`[MESSAGE_CORRELATION] Channel key available, attempting decryption...`);
      const decryptedMessage = await decryptGroupTextPayload(packet.payload, WARDRIVING_CHANNEL_KEY);
      
      if (decryptedMessage === null) {
        debugLog(`[MESSAGE_CORRELATION] ❌ REJECT: Failed to decrypt message`);
        return;
      }
      
      debugLog(`[MESSAGE_CORRELATION] Decryption successful, comparing content...`);
      debugLog(`[MESSAGE_CORRELATION] Decrypted: "${decryptedMessage}" (${decryptedMessage.length} chars)`);
      debugLog(`[MESSAGE_CORRELATION] Expected:  "${originalPayload}" (${originalPayload.length} chars)`);
      
      // Channel messages include sender name prefix: "SenderName: Message"
      // Check if our expected message is contained in the decrypted text
      // This handles both exact matches and messages with sender prefixes
      const messageMatches = decryptedMessage === originalPayload || decryptedMessage.includes(originalPayload);
      
      if (!messageMatches) {
        debugLog(`[MESSAGE_CORRELATION] ❌ REJECT: Message content mismatch (not an echo of our ping)`);
        debugLog(`[MESSAGE_CORRELATION] This is a different message on the same channel`);
        return;
      }
      
      if (decryptedMessage === originalPayload) {
        debugLog(`[MESSAGE_CORRELATION] ✅ Exact message match confirmed - this is an echo of our ping!`);
      } else {
        debugLog(`[MESSAGE_CORRELATION] ✅ Message contained in decrypted text (with sender prefix) - this is an echo of our ping!`);
      }
    } else {
      debugWarn(`[MESSAGE_CORRELATION] ⚠️ WARNING: Cannot verify message content - channel key not available`);
      debugWarn(`[MESSAGE_CORRELATION] Proceeding without message content verification (less reliable)`);
    }
    
    // VALIDATION STEP 5: Check path length (repeater echo vs direct transmission)
    // For channel messages, the path contains repeater hops
    // Each hop in the path is 1 byte (repeater ID)
    if (packet.path.length === 0) {
      debugLog(`Ignoring rx_log entry: no path (direct transmission, not a repeater echo)`);
      return;
    }
    
    // Extract only the first hop (first repeater ID) from the path
    // The path may contain multiple hops (e.g., [0x22, 0xd0, 0x5d, 0x46, 0x8b])
    // but we only care about the first repeater that echoed our message
    // Example: path [0x22, 0xd0, 0x5d] becomes "22" (only first hop)
    const firstHopId = packet.path[0];
    const pathHex = firstHopId.toString(16).padStart(2, '0');
    
    debugLog(`Repeater echo accepted: first_hop=${pathHex}, SNR=${data.lastSnr}, full_path_length=${packet.path.length}`);
    
    // Check if we already have this path
    if (state.repeaterTracking.repeaters.has(pathHex)) {
      const existing = state.repeaterTracking.repeaters.get(pathHex);
      debugLog(`Deduplication: path ${pathHex} already seen (existing SNR=${existing.snr}, new SNR=${data.lastSnr})`);
      
      // Keep the best (highest) SNR
      if (data.lastSnr > existing.snr) {
        debugLog(`Deduplication decision: updating path ${pathHex} with better SNR: ${existing.snr} -> ${data.lastSnr}`);
        state.repeaterTracking.repeaters.set(pathHex, {
          snr: data.lastSnr,
          seenCount: existing.seenCount + 1
        });
      } else {
        debugLog(`Deduplication decision: keeping existing SNR for path ${pathHex} (existing ${existing.snr} >= new ${data.lastSnr})`);
        // Still increment seen count
        existing.seenCount++;
      }
    } else {
      // New path
      debugLog(`Adding new repeater echo: path=${pathHex}, SNR=${data.lastSnr}`);
      state.repeaterTracking.repeaters.set(pathHex, {
        snr: data.lastSnr,
        seenCount: 1
      });
    }
  } catch (error) {
    debugError(`Error processing rx_log entry: ${error.message}`, error);
  }
}

/**
 * Stop listening for repeater echoes and return the results
 * @returns {Array<{repeaterId: string, snr: number}>} Array of repeater telemetry
 */
function stopRepeaterTracking() {
  if (!state.repeaterTracking.isListening) {
    return [];
  }
  
  debugLog(`Stopping repeater echo tracking`);
  
  // Stop listening for rx_log events
  if (state.connection && state.repeaterTracking.rxLogHandler) {
    state.connection.off(Constants.PushCodes.LogRxData, state.repeaterTracking.rxLogHandler);
    debugLog(`Unregistered LogRxData event handler`);
  }
  
  // Clear timeout
  if (state.repeaterTracking.listenTimeout) {
    clearTimeout(state.repeaterTracking.listenTimeout);
    state.repeaterTracking.listenTimeout = null;
  }
  
  // Get the results
  const repeaters = Array.from(state.repeaterTracking.repeaters.entries()).map(([id, data]) => ({
    repeaterId: id,
    snr: data.snr
  }));
  
  // Sort by repeater ID for deterministic output
  repeaters.sort((a, b) => a.repeaterId.localeCompare(b.repeaterId));
  
  debugLog(`Final aggregated repeater list: ${repeaters.length > 0 ? repeaters.map(r => `${r.repeaterId}(${r.snr}dB)`).join(', ') : 'none'}`);
  
  // Reset state
  state.repeaterTracking.isListening = false;
  state.repeaterTracking.sentTimestamp = null;
  state.repeaterTracking.sentPayload = null;
  state.repeaterTracking.repeaters.clear();
  state.repeaterTracking.rxLogHandler = null;
  
  return repeaters;
}

/**
 * Format repeater telemetry for output
 * @param {Array<{repeaterId: string, snr: number}>} repeaters - Array of repeater telemetry
 * @returns {string} Formatted repeater string (e.g., "4e(11.5),77(9.75)" or "none")
 */
function formatRepeaterTelemetry(repeaters) {
  if (repeaters.length === 0) {
    return "None";
  }
  
  // Format as: path(snr), path(snr), ...
  // Display exact SNR values as received
  return repeaters.map(r => `${r.repeaterId}(${r.snr})`).join(',');
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
      setStatus("Waiting for GPS fix", STATUS_COLORS.warning);
      return null;
    }
    
    // Check if GPS data is too old for auto ping
    const ageMs = Date.now() - state.lastFix.tsMs;
    const intervalMs = getSelectedIntervalMs();
    const maxAge = intervalMs + GPS_FRESHNESS_BUFFER_MS;
    
    if (ageMs >= maxAge) {
      debugLog(`GPS data too old for auto ping (${ageMs}ms), attempting to refresh`);
      setStatus("GPS data too old, requesting fresh position", STATUS_COLORS.warning);
      
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
 * Log ping information to the UI with repeater telemetry
 * Creates a session log entry that will be updated with repeater data
 * @param {string} payload - The ping message
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {HTMLElement|null} The list item element for later updates, or null
 */
function logPingToUI(payload, lat, lon) {
  // Use ISO format for data storage but user-friendly format for display
  const now = new Date();
  const isoStr = now.toISOString();
  
  if (lastPingEl) {
    lastPingEl.textContent = `${now.toLocaleString()} — ${payload}`;
  }

  if (sessionPingsEl) {
    // Create log entry with placeholder for repeater data
    // Format: timestamp | lat,lon | repeaters (using ISO for consistency with requirements)
    const line = `${isoStr} | ${lat.toFixed(5)},${lon.toFixed(5)} | ...`;
    const li = document.createElement('li');
    li.textContent = line;
    li.setAttribute('data-timestamp', isoStr);
    li.setAttribute('data-lat', lat.toFixed(5));
    li.setAttribute('data-lon', lon.toFixed(5));
    sessionPingsEl.appendChild(li);
    // Auto-scroll to bottom
    sessionPingsEl.scrollTop = sessionPingsEl.scrollHeight;
    return li;
  }
  
  return null;
}

/**
 * Update a ping log entry with repeater telemetry
 * @param {HTMLElement|null} logEntry - The log entry element to update
 * @param {Array<{repeaterId: string, snr: number}>} repeaters - Array of repeater telemetry
 */
function updatePingLogWithRepeaters(logEntry, repeaters) {
  if (!logEntry) return;
  
  const timestamp = logEntry.getAttribute('data-timestamp');
  const lat = logEntry.getAttribute('data-lat');
  const lon = logEntry.getAttribute('data-lon');
  const repeaterStr = formatRepeaterTelemetry(repeaters);
  
  // Update the log entry with final repeater data
  logEntry.textContent = `${timestamp} | ${lat},${lon} | ${repeaterStr}`;
  
  debugLog(`Updated ping log entry with repeater telemetry: ${repeaterStr}`);
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
      setStatus(`Wait ${remainingSec}s before sending another ping`, STATUS_COLORS.warning);
      return;
    }

    // Handle countdown timers based on ping type
    if (manual && state.running) {
      // Manual ping during auto mode: pause the auto countdown
      debugLog("Manual ping during auto mode - pausing auto countdown");
      pauseAutoCountdown();
      setStatus("Sending manual ping", STATUS_COLORS.info);
    } else if (!manual && state.running) {
      // Auto ping: stop the countdown timer to avoid status conflicts
      stopAutoCountdown();
      setStatus("Sending auto ping", STATUS_COLORS.info);
    } else if (manual) {
      // Manual ping when auto is not running
      setStatus("Sending manual ping", STATUS_COLORS.info);
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
        setStatus("Ping skipped, outside of geofenced region", STATUS_COLORS.warning);
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
    
    // Capture GPS coordinates at ping time - these will be used for API post after 7s delay
    state.capturedPingCoords = { lat, lon, accuracy };
    debugLog(`GPS coordinates captured at ping time: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, accuracy=${accuracy}m`);
    
    // Start repeater echo tracking BEFORE sending the ping
    debugLog(`Channel ping transmission: timestamp=${new Date().toISOString()}, channel=${ch.channelIdx}, payload="${payload}"`);
    startRepeaterTracking(payload, ch.channelIdx);
    
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
    setStatus("Ping sent", STATUS_COLORS.success);
    
    // Create UI log entry with placeholder for repeater data
    const logEntry = logPingToUI(payload, lat, lon);
    
    // Start RX listening countdown
    // The minimum 500ms visibility of "Ping sent" is enforced by setStatus()
    if (state.connection) {
      debugLog(`Starting RX listening window for ${RX_LOG_LISTEN_WINDOW_MS}ms`);
      startRxListeningCountdown(RX_LOG_LISTEN_WINDOW_MS);
    }
    
    // Schedule the sequence: listen for 7s, THEN finalize repeats and post to API
    // This timeout is stored in meshMapperTimer for cleanup purposes
    state.meshMapperTimer = setTimeout(async () => {
      debugLog(`RX listening window completed after ${RX_LOG_LISTEN_WINDOW_MS}ms`);
      
      // Stop listening countdown
      stopRxListeningCountdown();
      
      // Stop repeater tracking and get final results
      const repeaters = stopRepeaterTracking();
      debugLog(`Finalized heard repeats: ${repeaters.length} unique paths detected`);
      
      // Update UI log with repeater data
      updatePingLogWithRepeaters(logEntry, repeaters);
      
      // Format repeater data for API
      const heardRepeatsStr = formatRepeaterTelemetry(repeaters);
      debugLog(`Formatted heard_repeats for API: "${heardRepeatsStr}"`);
      
      // Use captured coordinates for API post (not current GPS position)
      if (state.capturedPingCoords) {
        const { lat: apiLat, lon: apiLon, accuracy: apiAccuracy } = state.capturedPingCoords;
        debugLog(`Using captured ping coordinates for API post: lat=${apiLat.toFixed(5)}, lon=${apiLon.toFixed(5)}, accuracy=${apiAccuracy}m`);
        
        // Post to API with heard repeats data
        await postApiAndRefreshMap(apiLat, apiLon, apiAccuracy, heardRepeatsStr);
      } else {
        // This should never happen as coordinates are always captured before ping
        debugError(`CRITICAL: No captured ping coordinates available for API post - this indicates a logic error`);
        debugError(`Skipping API post to avoid posting incorrect coordinates`);
      }
      
      // Clear captured coordinates after API post completes (always, regardless of path)
      state.capturedPingCoords = null;
      debugLog(`Cleared captured ping coordinates after API post`);
      
      // Clear timer reference
      state.meshMapperTimer = null;
    }, RX_LOG_LISTEN_WINDOW_MS);
    
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
    setStatus(`Wait ${remainingSec}s before toggling auto mode`, STATUS_COLORS.warning);
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
    setStatus(`Wait ${remainingSec}s before toggling auto mode`, STATUS_COLORS.warning);
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
  setStatus("Connecting", STATUS_COLORS.info);

  try {
    debugLog("Opening BLE connection...");
    const conn = await WebBleConnection.open();
    state.connection = conn;
    debugLog("BLE connection object created");

    conn.on("connected", async () => {
      debugLog("BLE connected event fired");
      // Keep "Connecting" status visible during the full connection process
      // Don't show "Connected" until everything is complete
      setConnectButton(true);
      connectBtn.disabled = false;
      const selfInfo = await conn.getSelfInfo();
      debugLog(`Device info: ${selfInfo?.name || "[No device]"}`);
      
      // Validate and store public key
      if (!selfInfo?.publicKey || selfInfo.publicKey.length !== 32) {
        debugError("Missing or invalid public key from device", selfInfo?.publicKey);
        setStatus("Unable to read device public key; try again", STATUS_COLORS.error);
        state.disconnectReason = "error"; // Mark as error disconnect
        // Disconnect after a brief delay to ensure user sees the error message
        setTimeout(() => {
          disconnect().catch(err => debugError(`Disconnect after public key error failed: ${err.message}`));
        }, 1500);
        return;
      }
      
      // Convert public key to hex and store
      state.devicePublicKey = BufferUtils.bytesToHex(selfInfo.publicKey);
      debugLog(`Device public key stored: ${state.devicePublicKey.substring(0, 16)}...`);
      
      deviceInfoEl.textContent = selfInfo?.name || "[No device]";
      updateAutoButton();
      try { 
        await conn.syncDeviceTime?.(); 
        debugLog("Device time synced");
      } catch { 
        debugLog("Device time sync not available or failed");
      }
      try {
        // Check capacity immediately after time sync, before channel setup and GPS init
        const allowed = await checkCapacity("connect");
        if (!allowed) {
          debugWarn("Capacity check denied, disconnecting");
          // Status message already set by checkCapacity()
          // disconnectReason already set by checkCapacity()
          // Disconnect after a brief delay to ensure user sees the message
          setTimeout(() => {
            disconnect().catch(err => debugError(`Disconnect after capacity denial failed: ${err.message}`));
          }, 1500);
          return;
        }
        
        // Capacity check passed, proceed with channel setup and GPS initialization
        await ensureChannel();
        await primeGpsOnce();
        
        // Connection complete, show Connected status
        setStatus("Connected", STATUS_COLORS.success);
        debugLog("Full connection process completed successfully");
      } catch (e) {
        debugError(`Channel setup failed: ${e.message}`, e);
        setStatus(e.message || "Channel setup failed", STATUS_COLORS.error);
        state.disconnectReason = "error"; // Mark as error disconnect
      }
    });

    conn.on("disconnected", () => {
      debugLog("BLE disconnected event fired");
      
      // Only set "Disconnected" status for normal disconnections
      // Preserve error messages (app_down, capacity_full, error) instead of overwriting
      if (state.disconnectReason === "normal" || state.disconnectReason === null || state.disconnectReason === undefined) {
        setStatus("Disconnected", STATUS_COLORS.error);
      } else {
        debugLog(`Preserving disconnect status for reason: ${state.disconnectReason}`);
      }
      
      setConnectButton(false);
      deviceInfoEl.textContent = "—";
      state.connection = null;
      state.channel = null;
      state.devicePublicKey = null; // Clear public key
      state.disconnectReason = null; // Reset disconnect reason
      stopAutoPing(true); // Ignore cooldown check on disconnect
      enableControls(false);
      updateAutoButton();
      stopGeoWatch();
      stopGpsAgeUpdater(); // Ensure age updater stops
      stopDistanceUpdater(); // Ensure distance updater stops
      stopRepeaterTracking(); // Stop repeater echo tracking
      
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
    setStatus("Connection failed", STATUS_COLORS.error);
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
  
  // Set disconnectReason to "normal" if not already set (for user-initiated disconnects)
  if (state.disconnectReason === null || state.disconnectReason === undefined) {
    state.disconnectReason = "normal";
  }
  
  setStatus("Disconnecting", STATUS_COLORS.info);

  // Release capacity slot if we have a public key
  if (state.devicePublicKey) {
    try {
      debugLog("Releasing capacity slot");
      await checkCapacity("disconnect");
    } catch (e) {
      debugWarn(`Failed to release capacity slot: ${e.message}`);
      // Don't fail disconnect if capacity release fails
    }
  }

  // Delete the wardriving channel before disconnecting
  try {
    if (state.channel && typeof state.connection.deleteChannel === "function") {
      debugLog(`Deleting channel ${CHANNEL_NAME} at index ${state.channel.channelIdx}`);
      await state.connection.deleteChannel(state.channel.channelIdx);
      debugLog(`Channel ${CHANNEL_NAME} deleted successfully`);
    }
  } catch (e) {
    debugWarn(`Failed to delete channel ${CHANNEL_NAME}: ${e.message}`);
    // Don't fail disconnect if channel deletion fails
  }

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
    state.disconnectReason = "error"; // Mark as error disconnect
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
      setStatus(e.message || "Connection failed", STATUS_COLORS.error);
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
