
// Minimal Wardrive sender with wake locks:
// - Connect to MeshCore Companion via Web Bluetooth (BLE)
// - Send pings as "@[MapperBot]<LAT LON>[ <power> ]" (power only if specified)
// - Manual "Send Ping" and Auto mode (interval selectable: 15/30/60s)
// - Acquire wake lock during auto mode to keep screen awake

import { WebBleConnection } from "/content/mc/index.js"; // your BLE client
import Constants from "/content/mc/constants.js";
import Packet from "/content/mc/packet.js";

// ---- Config ----
const CHANNEL_NAME     = "#wardriving";        // change to "#wardrive" if needed
const DEFAULT_INTERVAL_S = 30;                 // fallback if selector unavailable
const PING_PREFIX      = "@[MapperBot]";
const GPS_FRESHNESS_BUFFER_MS = 5000;          // Buffer time for GPS freshness checks
const GPS_ACCURACY_THRESHOLD_M = 100;          // Maximum acceptable GPS accuracy in meters
const MESHMAPPER_DELAY_MS = 7000;              // Delay MeshMapper API call by 7 seconds
const COOLDOWN_MS = 7000;                      // Cooldown period for manual ping and auto toggle
const REPEATER_LISTEN_MS = 7000;               // Listen for repeater echoes for 7 seconds
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
  apiPostTime: null, // Timestamp when API post will occur
  repeaterListenTimer: null, // Timer for stopping repeater listener
  repeaterData: null, // Current repeater collection data {sessionLi, repeaters: Map}
  repeaterLogListener: null // LogRxData event listener reference
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

// ---- Repeater Tracking ----
function startRepeaterTracking(sessionLi) {
  // Clean up any existing tracking
  stopRepeaterTracking();
  
  // Initialize repeater data collection
  state.repeaterData = {
    sessionLi: sessionLi,
    repeaters: new Map() // Map of repeaterID -> SNR
  };
  
  // Create listener for LogRxData events
  state.repeaterLogListener = (logData) => {
    try {
      // Check if repeater data collection is still active
      if (!state.repeaterData) return;
      
      // Validate input data
      if (!logData || typeof logData.lastSnr !== 'number' || !logData.raw) return;
      
      // Parse the packet from raw data
      let packet;
      try {
        packet = Packet.fromBytes(logData.raw);
      } catch (parseError) {
        console.warn("Failed to parse packet from LogRxData:", parseError);
        return;
      }
      
      // Check if this is a group text message (our ping echo)
      // Verify path exists and has at least one byte (repeater ID)
      if (packet.getPayloadType() === Packet.PAYLOAD_TYPE_GRP_TXT && 
          packet.path && packet.path.length > 0) {
        // Extract repeater ID (first byte of path)
        const repeaterId = packet.path[0];
        
        // Validate repeater ID is a valid byte value (0-255)
        // Note: repeaterId can be 0 (valid byte value), so we check type and range
        if (repeaterId === undefined || typeof repeaterId !== 'number' || 
            !Number.isInteger(repeaterId) || repeaterId < 0 || repeaterId > 255) {
          console.warn(`Invalid repeater ID: ${repeaterId}`);
          return;
        }
        
        // SNR ranges from -12 to +12 dB
        // Note: logData.lastSnr is already processed (readInt8() / 4) by the connection layer
        const snr = Math.round(logData.lastSnr);
        
        // Store or update repeater data
        // Keep the highest SNR value (closest to +12dB) for duplicate repeaters
        if (!state.repeaterData.repeaters.has(repeaterId) || 
            state.repeaterData.repeaters.get(repeaterId) < snr) {
          state.repeaterData.repeaters.set(repeaterId, snr);
          console.log(`Repeater detected: ID=${repeaterId}, SNR=${snr}dB`);
        }
      }
    } catch (e) {
      console.warn("Failed to parse repeater data:", e);
    }
  };
  
  // Start listening for LogRxData events
  if (state.connection) {
    state.connection.on(Constants.PushCodes.LogRxData, state.repeaterLogListener);
  }
  
  // Schedule stop after REPEATER_LISTEN_MS
  state.repeaterListenTimer = setTimeout(() => {
    stopRepeaterTracking();
  }, REPEATER_LISTEN_MS);
}

function stopRepeaterTracking() {
  // Stop the timer
  if (state.repeaterListenTimer) {
    clearTimeout(state.repeaterListenTimer);
    state.repeaterListenTimer = null;
  }
  
  // Remove the event listener
  if (state.repeaterLogListener && state.connection) {
    state.connection.off(Constants.PushCodes.LogRxData, state.repeaterLogListener);
    state.repeaterLogListener = null;
  }
  
  // Update the session log entry with repeater data
  if (state.repeaterData && state.repeaterData.sessionLi) {
    const repeaters = state.repeaterData.repeaters;
    if (repeaters.size > 0) {
      // Format repeater data as [ID1(SNR1),ID2(SNR2),...]
      // SNR values range from -12 to +12 dB, e.g., [25(-8),21(-5),14(3)]
      const repeaterList = Array.from(repeaters.entries())
        .sort((a, b) => a[0] - b[0]) // Sort by repeater ID
        .map(([id, snr]) => `${id}(${snr})`)
        .join(',');
      
      // Append to the existing text in the session log
      const currentText = state.repeaterData.sessionLi.textContent;
      state.repeaterData.sessionLi.textContent = `${currentText}  [${repeaterList}]`;
      console.log(`Session ping updated with ${repeaters.size} repeater(s)`);
    }
  }
  
  // Clear repeater data
  state.repeaterData = null;
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

    const payload = buildPayload(lat, lon);

    const ch = await ensureChannel();
    await state.connection.sendChannelTextMessage(ch.channelIdx, payload);

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
    
    // Format timestamp as ISO 8601 without milliseconds: YYYY-MM-DDTHH:MM:SSZ
    const nowStr = new Date().toISOString().split('.')[0] + 'Z';
    if (lastPingEl) lastPingEl.textContent = `${nowStr} — ${payload}`;

    // Session log
    if (sessionPingsEl) {
      const line = `${nowStr}  ${lat.toFixed(5)} ${lon.toFixed(5)}`;
      const li = document.createElement('li');
      li.textContent = line;
      sessionPingsEl.appendChild(li);
       // Auto-scroll to bottom when a new entry arrives
      sessionPingsEl.scrollTop = sessionPingsEl.scrollHeight;
      
      // Start tracking repeater echoes for this ping
      startRepeaterTracking(li);
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
      stopRepeaterTracking();
      state.cooldownEndTime = null;
      
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
