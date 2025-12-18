
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

// GPS Enhancement Configuration
const MIN_PING_DISTANCE_M = 25;                // Minimum distance between pings in meters
const OTTAWA_CENTER_LAT = 45.4215;             // Ottawa center (Parliament Hill) latitude
const OTTAWA_CENTER_LON = -75.6972;            // Ottawa center (Parliament Hill) longitude
const OTTAWA_GEOFENCE_RADIUS_KM = 150;         // Service area radius in kilometers (covers greater Ottawa region)

// ---- GPS Distance Calculation (Haversine Formula) ----
const EARTH_RADIUS_METERS = 6371000; // Earth's mean radius in meters
const DEG_TO_RAD = Math.PI / 180;    // Conversion factor from degrees to radians

/**
 * Calculate the great-circle distance between two GPS coordinates using the Haversine formula.
 * @param {number} lat1 - Latitude of first point in degrees
 * @param {number} lon1 - Longitude of first point in degrees
 * @param {number} lat2 - Latitude of second point in degrees
 * @param {number} lon2 - Longitude of second point in degrees
 * @returns {number} Distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG_TO_RAD;
  const φ2 = lat2 * DEG_TO_RAD;
  const Δφ = (lat2 - lat1) * DEG_TO_RAD;
  const Δλ = (lon2 - lon1) * DEG_TO_RAD;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c; // Distance in meters
}

/**
 * Check if current location is within the Ottawa geofence.
 * @param {number} lat - Current latitude
 * @param {number} lon - Current longitude
 * @returns {object} { inBounds: boolean, distanceKm: number }
 */
function checkGeofence(lat, lon) {
  const distanceM = calculateDistance(lat, lon, OTTAWA_CENTER_LAT, OTTAWA_CENTER_LON);
  const distanceKm = distanceM / 1000;
  const inBounds = distanceKm <= OTTAWA_GEOFENCE_RADIUS_KM;
  console.log(`[Geofence] Location: ${lat}, ${lon} | Distance from Ottawa: ${distanceKm.toFixed(1)}km | Limit: ${OTTAWA_GEOFENCE_RADIUS_KM}km | InBounds: ${inBounds}`);
  return { inBounds, distanceKm };
}

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
  apiPostTime: null, // Timestamp when API post will occur
  lastPingLocation: null, // { lat, lon, tsMs } - location of last successful ping for distance filtering
  tooCloseToLastPing: false, // True when user hasn't moved far enough from last ping
  outsideGeofence: false // True when user is outside the Ottawa geofence
};

// ---- UI helpers ----
function setStatus(text, color = "text-slate-300") {
  statusEl.textContent = text;
  statusEl.className = `font-semibold ${color}`;
}
function updateAutoCountdownStatus() {
  if (!state.running || !state.nextAutoPingTime) {
    return;
  }
  
  const remainingMs = state.nextAutoPingTime - Date.now();
  if (remainingMs <= 0) {
    setStatus("Sending auto ping...", "text-sky-300");
    return;
  }
  
  const remainingSec = Math.ceil(remainingMs / 1000);
  setStatus(`Waiting for next auto ping (${remainingSec}s)`, "text-slate-300");
}
function startAutoCountdown(intervalMs) {
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
}
function stopAutoCountdown() {
  if (state.autoCountdownTimer) {
    clearInterval(state.autoCountdownTimer);
    state.autoCountdownTimer = null;
  }
  state.nextAutoPingTime = null;
}
function updateApiCountdownStatus() {
  if (!state.apiPostTime) {
    return;
  }
  
  const remainingMs = state.apiPostTime - Date.now();
  if (remainingMs <= 0) {
    setStatus("Posting to API...", "text-sky-300");
    return;
  }
  
  const remainingSec = Math.ceil(remainingMs / 1000);
  setStatus(`Wait to post API (${remainingSec}s)`, "text-sky-300");
}
function startApiCountdown(delayMs) {
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
}
function stopApiCountdown() {
  if (state.apiCountdownTimer) {
    clearInterval(state.apiCountdownTimer);
    state.apiCountdownTimer = null;
  }
  state.apiPostTime = null;
}
function isInCooldown() {
  return state.cooldownEndTime && Date.now() < state.cooldownEndTime;
}
function startCooldown() {
  state.cooldownEndTime = Date.now() + COOLDOWN_MS;
  updateControlsForCooldown();
  
  // Clear any existing cooldown update and schedule a new one
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
    console.log("Coverage iframe URL:", url);
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

// Check if current location allows pinging (distance and geofence)
function checkLocationRestrictions() {
  if (!state.lastFix) {
    // No GPS fix, can't check restrictions
    state.tooCloseToLastPing = false;
    state.outsideGeofence = false;
    return;
  }

  const { lat, lon } = state.lastFix;
  
  // Check geofence
  const geofenceCheck = checkGeofence(lat, lon);
  const wasOutside = state.outsideGeofence;
  state.outsideGeofence = !geofenceCheck.inBounds;
  
  // Check distance from last ping
  const wasTooClose = state.tooCloseToLastPing;
  if (state.lastPingLocation) {
    const distanceFromLastPing = calculateDistance(
      lat, lon,
      state.lastPingLocation.lat, state.lastPingLocation.lon
    );
    state.tooCloseToLastPing = distanceFromLastPing < MIN_PING_DISTANCE_M;
    
    // Update status - keep error visible when in restricted state
    if (state.outsideGeofence) {
      setStatus(`Outside service area (${geofenceCheck.distanceKm.toFixed(1)}km from Ottawa)`, "text-red-300");
    } else if (state.tooCloseToLastPing) {
      const remainingDistance = MIN_PING_DISTANCE_M - distanceFromLastPing;
      if (state.running) {
        // In auto mode, show "Haven't moved far enough, waiting for next ping (Xs)"
        const remainingMs = state.nextAutoPingTime ? state.nextAutoPingTime - Date.now() : 0;
        if (remainingMs > 0) {
          const remainingSec = Math.ceil(remainingMs / 1000);
          setStatus(`Haven't moved far enough (need ${remainingDistance.toFixed(1)}m), waiting for next ping (${remainingSec}s)`, "text-amber-300");
        } else {
          setStatus(`Haven't moved far enough (need ${remainingDistance.toFixed(1)}m)`, "text-amber-300");
        }
      } else {
        // In manual mode, show persistent error
        setStatus(`Haven't moved far enough from last ping. Need ${remainingDistance.toFixed(1)}m more`, "text-amber-300");
      }
    } else if ((wasTooClose || wasOutside) && !state.tooCloseToLastPing && !state.outsideGeofence) {
      // Just cleared restrictions
      if (state.running) {
        updateAutoCountdownStatus();
      } else if (!isInCooldown() && state.connection) {
        setStatus("Idle", "text-slate-300");
      }
    }
  } else {
    state.tooCloseToLastPing = false;
    
    // Only update status if geofence state changed
    if (state.outsideGeofence && !wasOutside) {
      setStatus(`Outside service area (${geofenceCheck.distanceKm.toFixed(1)}km from Ottawa)`, "text-red-300");
    } else if (!state.outsideGeofence && wasOutside && state.connection && !isInCooldown() && !state.running) {
      setStatus("Idle", "text-slate-300");
    }
  }
}

// Start continuous GPS age display updates
function startGpsAgeUpdater() {
  if (state.gpsAgeUpdateTimer) return;
  state.gpsAgeUpdateTimer = setInterval(() => {
    updateGpsUi();
    checkLocationRestrictions();
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
      checkLocationRestrictions();
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
async function postToMeshMapperAPI(lat, lon) {
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

    console.log("Posting to MeshMapper API:", { lat, lon, who: whoIdentifier, power: powerValue });

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
    } else {
      console.log("Successfully posted to MeshMapper API");
    }
  } catch (error) {
    // Log error but don't fail the ping
    console.error("Failed to post to MeshMapper API:", error);
  }
}

// ---- Ping ----
async function sendPing(manual = false) {
  try {
    // Check cooldown only for manual pings
    if (manual && isInCooldown()) {
      const remainingMs = state.cooldownEndTime - Date.now();
      const remainingSec = Math.ceil(remainingMs / 1000);
      setStatus(`Please wait ${remainingSec}s before sending another ping`, "text-amber-300");
      return;
    }

    // Stop the countdown timer when sending an auto ping to avoid status conflicts
    if (!manual && state.running) {
      stopAutoCountdown();
      setStatus("Sending auto ping...", "text-sky-300");
    }

    let lat, lon, accuracy;

    // In auto mode, always use the most recent GPS coordinates from the watch
    // In manual mode, get fresh GPS if needed
    if (!manual && state.running) {
      // Auto mode: use GPS watch data
      if (!state.lastFix) {
        // If no GPS fix yet in auto mode, skip this ping and wait for watch to acquire location
        console.warn("Auto ping skipped: waiting for GPS fix");
        setStatus("Waiting for GPS fix...", "text-amber-300");
        return;
      }
      lat = state.lastFix.lat;
      lon = state.lastFix.lon;
      accuracy = state.lastFix.accM;
    } else {
      // Manual mode: check if we have recent enough GPS data
      const intervalMs = getSelectedIntervalMs();
      const maxAge = intervalMs + GPS_FRESHNESS_BUFFER_MS; // Allow buffer beyond interval

      if (state.lastFix && (Date.now() - state.lastFix.tsMs) < maxAge) {
        lat = state.lastFix.lat;
        lon = state.lastFix.lon;
        accuracy = state.lastFix.accM;
      } else {
        // Get fresh GPS coordinates for manual ping
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
    }

    // Validate GPS coordinates (note: 0 is a valid coordinate)
    if (lat == null || lon == null || typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
      const msg = "Invalid GPS coordinates - cannot send ping";
      console.error(`GPS validation failed: lat=${lat}, lon=${lon}`);
      setStatus(msg, "text-red-300");
      if (!manual && state.running) {
        scheduleNextAutoPing();
      }
      return;
    }
    
    // Check geofence: ensure we're within the Ottawa service area
    console.log(`Checking geofence for location: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    const geofenceCheck = checkGeofence(lat, lon);
    console.log(`Geofence check result: inBounds=${geofenceCheck.inBounds}, distance=${geofenceCheck.distanceKm.toFixed(1)}km`);
    
    if (!geofenceCheck.inBounds) {
      const msg = `Outside service area (${geofenceCheck.distanceKm.toFixed(1)}km from Ottawa)`;
      console.log(`❌ Geofence check FAILED: ${msg}`);
      setStatus(msg, "text-red-300");
      
      // In auto mode, schedule next ping to keep checking location
      if (!manual && state.running) {
        scheduleNextAutoPing();
      }
      return;
    }
    console.log(`✓ Geofence check PASSED: Within ${OTTAWA_GEOFENCE_RADIUS_KM}km of Ottawa`);
    
    // Check distance from last ping: skip if too close (within 25m)
    if (state.lastPingLocation) {
      const distanceFromLastPing = calculateDistance(
        lat, lon,
        state.lastPingLocation.lat, state.lastPingLocation.lon
      );
      
      console.log(`Distance from last ping: ${distanceFromLastPing.toFixed(1)}m`);
      
      if (distanceFromLastPing < MIN_PING_DISTANCE_M) {
        const remainingDistance = MIN_PING_DISTANCE_M - distanceFromLastPing;
        console.log(`Ping blocked: too close (${distanceFromLastPing.toFixed(1)}m). Need ${remainingDistance.toFixed(1)}m more`);
        
        if (manual) {
          // For manual ping, show immediate feedback
          setStatus(`Haven't moved far enough from last ping. Need ${remainingDistance.toFixed(1)}m more`, "text-amber-300");
        } else if (state.running) {
          // In auto mode, schedule next ping and let checkLocationRestrictions handle status
          scheduleNextAutoPing();
        }
        return;
      }
    }

    const payload = buildPayload(lat, lon);

    const ch = await ensureChannel();
    await state.connection.sendChannelTextMessage(ch.channelIdx, payload);

    // Store this location as the last successful ping location for distance filtering
    state.lastPingLocation = {
      lat,
      lon,
      tsMs: Date.now()
    };
    console.log(`Last ping location updated: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);

    // Start cooldown period after successful ping
    startCooldown();

    // Update status after ping is sent
    // Brief delay to show "Ping sent" status before moving to countdown
    setStatus(manual ? "Ping sent" : "Auto ping sent", "text-emerald-300");
    
    setTimeout(() => {
      if (state.connection) {
        // Start countdown for API post
        startApiCountdown(MESHMAPPER_DELAY_MS);
      }
    }, STATUS_UPDATE_DELAY_MS);

    // Schedule MeshMapper API call with 7-second delay (non-blocking)
    // Clear any existing timer first
    if (state.meshMapperTimer) {
      clearTimeout(state.meshMapperTimer);
    }

    state.meshMapperTimer = setTimeout(async () => {
      // Capture accuracy in closure to ensure it's available in nested callback
      const capturedAccuracy = accuracy;
      
      // Stop the API countdown since we're posting now
      stopApiCountdown();
      setStatus("Posting to API...", "text-sky-300");
      
      try {
        await postToMeshMapperAPI(lat, lon);
      } catch (error) {
        console.error("MeshMapper API post failed:", error);
        // Continue with map refresh and status update even if API fails
      }
      
      // Update map after API post to ensure backend updated
      setTimeout(() => {
        if (capturedAccuracy && capturedAccuracy < GPS_ACCURACY_THRESHOLD_M) {
          scheduleCoverageRefresh(lat, lon);
        }
        
        // Set status to idle after map update
        if (state.connection) {
          // If in auto mode, schedule next ping. Otherwise, set to idle
          if (state.running) {
            // Schedule the next auto ping with countdown
            scheduleNextAutoPing();
          } else {
            setStatus("Idle", "text-slate-300");
          }
        }
      }, MAP_REFRESH_DELAY_MS);
      
      state.meshMapperTimer = null;
    }, MESHMAPPER_DELAY_MS);
    
    const nowStr = new Date().toLocaleString();
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
function stopAutoPing(stopGps = false) {
  // Check if we're in cooldown before stopping (unless stopGps is true for disconnect)
  if (!stopGps && isInCooldown()) {
    const remainingMs = state.cooldownEndTime - Date.now();
    const remainingSec = Math.ceil(remainingMs / 1000);
    setStatus(`Please wait ${remainingSec}s before toggling auto mode`, "text-amber-300");
    return;
  }
  
  if (state.autoTimerId) {
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Only stop GPS watch when disconnecting or page hidden, not during normal stop
  if (stopGps) {
    stopGeoWatch();
  }
  
  state.running = false;
  updateAutoButton();
  releaseWakeLock();
}
function scheduleNextAutoPing() {
  if (!state.running) return;
  
  const intervalMs = getSelectedIntervalMs();
  
  // Start countdown immediately
  startAutoCountdown(intervalMs);
  
  // Schedule the next ping
  state.autoTimerId = setTimeout(() => {
    if (state.running) {
      sendPing(false).catch(console.error);
    }
  }, intervalMs);
}

function startAutoPing() {
  if (!state.connection) {
    alert("Connect to a MeshCore device first.");
    return;
  }
  
  // Check if we're in cooldown
  if (isInCooldown()) {
    const remainingMs = state.cooldownEndTime - Date.now();
    const remainingSec = Math.ceil(remainingMs / 1000);
    setStatus(`Please wait ${remainingSec}s before toggling auto mode`, "text-amber-300");
    return;
  }
  
  // Clean up any existing auto-ping timer (but keep GPS watch running)
  if (state.autoTimerId) {
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Start GPS watch for continuous updates
  startGeoWatch();
  
  state.running = true;
  updateAutoButton();

  // Acquire wake lock for auto mode
  acquireWakeLock().catch(console.error);

  // Send first ping immediately
  sendPing(false).catch(console.error);
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
      stopAutoPing(true); // Ignore cooldown check on disconnect
      enableControls(false);
      updateAutoButton();
      stopGeoWatch();
      stopGpsAgeUpdater(); // Ensure age updater stops
      
      // Clean up timers
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
      state.lastPingLocation = null; // Clear last ping location on disconnect
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
      stopAutoPing(true); // Ignore cooldown check when page is hidden
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
