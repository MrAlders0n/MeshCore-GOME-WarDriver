
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
    
    // Also add to Error Log UI (use try-catch to prevent recursive errors)
    try {
      // Extract source tag if present (e.g., "[BLE]" from "[BLE] Connection failed")
      const tagMatch = message.match(/^\[([^\]]+)\]/);
      const source = tagMatch ? tagMatch[1] : null;
      
      // Remove tag from message if present
      const cleanMessage = tagMatch ? message.replace(/^\[[^\]]+\]\s*/, '') : message;
      
      // Only add to Error Log if the UI is initialized
      if (typeof addErrorLogEntry === 'function') {
        addErrorLogEntry(cleanMessage, source);
      }
    } catch (e) {
      // Silently fail to prevent recursive errors
      console.error('Failed to add error to Error Log UI:', e);
    }
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
const RX_LOG_LISTEN_WINDOW_MS = 6000;         // Listen window for repeater echoes (6 seconds)
const CHANNEL_GROUP_TEXT_HEADER = 0x15;       // Header byte for Meshtastic GroupText packets (0x15) - used exclusively for Session Log echo detection

// Pre-computed channel hash and key for the wardriving channel
// These will be computed once at startup and used for message correlation and decryption
let WARDRIVING_CHANNEL_HASH = null;
let WARDRIVING_CHANNEL_KEY = null;

// Initialize the wardriving channel hash and key at startup
(async function initializeChannelHash() {
  try {
    WARDRIVING_CHANNEL_KEY = await deriveChannelKey(CHANNEL_NAME);
    WARDRIVING_CHANNEL_HASH = await computeChannelHash(WARDRIVING_CHANNEL_KEY);
    debugLog(`[INIT] Wardriving channel hash pre-computed at startup: 0x${WARDRIVING_CHANNEL_HASH.toString(16).padStart(2, '0')}`);
    debugLog(`[INIT] Wardriving channel key cached for message decryption (${WARDRIVING_CHANNEL_KEY.length} bytes)`);
  } catch (error) {
    debugError(`[INIT] CRITICAL: Failed to pre-compute channel hash/key: ${error.message}`);
    debugError(`[INIT] Repeater echo tracking will be disabled. Please reload the page.`);
    // Channel hash and key remain null, which will be checked before starting tracking
  }
})();

// Ottawa Geofence Configuration
const OTTAWA_CENTER_LAT = 45.4215;  // Parliament Hill latitude
const OTTAWA_CENTER_LON = -75.6972; // Parliament Hill longitude
const OTTAWA_GEOFENCE_RADIUS_M = 150000; // 150 km in meters

// Distance-Based Ping Filtering
const MIN_PING_DISTANCE_M = 25; // Minimum distance (25m) between pings

// Passive RX Log Batch Configuration
const RX_BATCH_DISTANCE_M = 25;        // Distance trigger for flushing batch (separate from MIN_PING_DISTANCE_M for independent tuning)
const RX_BATCH_TIMEOUT_MS = 30000;     // Max hold time per repeater (30 sec)
const RX_BATCH_MIN_WAIT_MS = 2000;     // Min wait to collect burst RX events

// API Batch Queue Configuration
const API_BATCH_MAX_SIZE = 50;              // Maximum messages per batch POST
const API_BATCH_FLUSH_INTERVAL_MS = 30000;  // Flush every 30 seconds
const API_TX_FLUSH_DELAY_MS = 3000;         // Flush 3 seconds after TX ping

// MeshMapper API Configuration
const MESHMAPPER_API_URL = "https://yow.meshmapper.net/wardriving-api.php";
const MESHMAPPER_CAPACITY_CHECK_URL = "https://yow.meshmapper.net/capacitycheck.php";
const MESHMAPPER_API_KEY = "59C7754DABDF5C11CA5F5D8368F89";
const MESHMAPPER_DEFAULT_WHO = "GOME-WarDriver"; // Default identifier
const MESHMAPPER_RX_LOG_API_URL = "https://yow.meshmapper.net/wardriving-api.php";

// Static for now; will be made dynamic later.
const WARDIVE_IATA_CODE = "YOW";

// ---- App Version Configuration ----
// This constant is injected by GitHub Actions during build/deploy
// For release builds: Contains the release version (e.g., "v1.3.0")
// For DEV builds: Contains "DEV-<EPOCH>" format (e.g., "DEV-1734652800")
const APP_VERSION = "UNKNOWN"; // Placeholder - replaced during build

// ---- Capacity Check Reason Messages ----
// Maps API reason codes to user-facing error messages
const REASON_MESSAGES = {
  outofdate: "App out of date, please update",
  // Future reasons can be added here
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

// ---- DOM refs (from index.html; unchanged except the two new selectors) ----
const $ = (id) => document.getElementById(id);
const statusEl       = $("status");
const deviceInfoEl   = $("deviceInfo");
const channelInfoEl  = $("channelInfo");
const connectBtn     = $("connectBtn");
const txPingBtn      = $("txPingBtn");
const txRxAutoBtn    = $("txRxAutoBtn");
const rxAutoBtn      = $("rxAutoBtn");
const lastPingEl     = $("lastPing");
const gpsInfoEl = document.getElementById("gpsInfo");
const gpsAccEl = document.getElementById("gpsAcc");
const distanceInfoEl = document.getElementById("distanceInfo"); // Distance from last ping
const txPingsEl = document.getElementById("txPings"); // TX log container
const coverageFrameEl = document.getElementById("coverageFrame");
setConnectButton(false);
setConnStatus("Disconnected", STATUS_COLORS.error);

// NEW: selectors
const intervalSelect = $("intervalSelect"); // 15 / 30 / 60 seconds
const powerSelect    = $("powerSelect");    // "", "0.3w", "0.6w", "1.0w"

// TX Log selectors
const txLogSummaryBar = $("txLogSummaryBar");
const txLogBottomSheet = $("txLogBottomSheet");
const txLogScrollContainer = $("txLogScrollContainer");
const txLogCount = $("txLogCount");
const txLogLastTime = $("txLogLastTime");
const txLogLastSnr = $("txLogLastSnr");
const txLogCopyBtn = $("txLogCopyBtn");

// RX Log selectors
const rxLogSummaryBar = $("rxLogSummaryBar");
const rxLogBottomSheet = $("rxLogBottomSheet");
const rxLogScrollContainer = $("rxLogScrollContainer");
const rxLogCount = $("rxLogCount");
const rxLogLastTime = $("rxLogLastTime");
const rxLogLastRepeater = $("rxLogLastRepeater");
const rxLogSnrChip = $("rxLogSnrChip");
const rxLogEntries = $("rxLogEntries");
const rxLogExpandArrow = $("rxLogExpandArrow");
const rxLogCopyBtn = $("rxLogCopyBtn");

// Error Log selectors
const errorLogSummaryBar = $("errorLogSummaryBar");
const errorLogBottomSheet = $("errorLogBottomSheet");
const errorLogScrollContainer = $("errorLogScrollContainer");
const errorLogCount = $("errorLogCount");
const errorLogLastTime = $("errorLogLastTime");
const errorLogLastError = $("errorLogLastError");
const errorLogEntries = $("errorLogEntries");
const errorLogExpandArrow = $("errorLogExpandArrow");
const errorLogCopyBtn = $("errorLogCopyBtn");

// Session log state
const txLogState = {
  entries: [],  // Array of parsed log entries
  isExpanded: false,
  autoScroll: true
};

// RX log state (passive observations)
const rxLogState = {
  entries: [],  // Array of parsed RX log entries
  isExpanded: false,
  autoScroll: true,
  maxEntries: 100  // Limit to prevent memory issues
};

// Error log state
const errorLogState = {
  entries: [],  // Array of error log entries
  isExpanded: false,
  autoScroll: true,
  maxEntries: 50,  // Limit to prevent memory issues
  previewLength: 20  // Character length for error message preview in summary
};

// ---- State ----
const state = {
  connection: null,
  channel: null,
  autoTimerId: null,
  txRxAutoRunning: false,  // TX/RX Auto mode flag (renamed from running)
  rxAutoRunning: false,    // RX Auto mode flag (passive-only wardriving)
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
  capturedPingCoords: null, // { lat, lon, accuracy } captured at ping time, used for API post after 7s delay
  devicePublicKey: null, // Hex string of device's public key (used for capacity check)
  wardriveSessionId: null, // Session ID from capacity check API (used for all MeshMapper API posts)
  debugMode: false, // Whether debug mode is enabled by MeshMapper API
  tempTxRepeaterData: null, // Temporary storage for TX repeater debug data
  disconnectReason: null, // Tracks the reason for disconnection (e.g., "app_down", "capacity_full", "public_key_error", "channel_setup_error", "ble_disconnect_error", "session_id_error", "normal", or API reason codes like "outofdate")
  channelSetupErrorMessage: null, // Error message from channel setup failure
  bleDisconnectErrorMessage: null, // Error message from BLE disconnect failure
  txTracking: {
    isListening: false,           // Whether we're currently listening for TX echoes
    sentTimestamp: null,          // Timestamp when the ping was sent
    sentPayload: null,            // The payload text that was sent
    channelIdx: null,             // Channel index for reference
    repeaters: new Map(),         // Map<repeaterId, {snr, seenCount, metadata}>
    listenTimeout: null,          // Timeout handle for 7-second window
    rxLogHandler: null,           // Handler function for rx_log events
    currentLogEntry: null,        // Current log entry being updated (for incremental UI updates)
  },
  rxTracking: {
    isListening: false,           // TRUE when unified listener is active (always on when connected)
    isWardriving: false,          // TRUE when TX/RX Auto OR RX Auto enabled
    rxLogHandler: null,           // Handler function for RX log events
  },
  rxBatchBuffer: new Map()        // Map<repeaterId, {firstLocation, bestObservation}>
};

// API Batch Queue State
const apiQueue = {
  messages: [],           // Array of pending payloads
  flushTimerId: null,     // Timer ID for periodic flush (30s)
  txFlushTimerId: null,   // Timer ID for TX-triggered flush (3s)
  isProcessing: false     // Lock to prevent concurrent flush operations
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
    debugLog(`[UI] Status update (same message): "${text}"`);
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
  debugLog(`[UI] Status queued (${delayNeeded}ms delay): "${text}" (current: "${statusMessageState.currentText}")`);
  
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
  statusEl.className = `text-sm font-medium ${color}`;
  statusMessageState.lastSetTime = Date.now();
  statusMessageState.currentText = text;
  statusMessageState.currentColor = color;
  debugLog(`[UI] Status applied: "${text}"`);
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
    setDynamicStatus(result, defaultColor, immediate);
  } else {
    setDynamicStatus(result.message, result.color || defaultColor, immediate);
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
    if (!state.txRxAutoRunning) return null;
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
      debugLog(`[TIMER] Pausing auto countdown with ${state.pausedAutoTimerRemainingMs}ms remaining`);
    } else {
      debugLog(`[TIMER] Auto countdown time out of reasonable range (${remainingMs}ms), not pausing`);
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
      debugLog(`[TIMER] Resuming auto countdown with ${state.pausedAutoTimerRemainingMs}ms remaining`);
      startAutoCountdown(state.pausedAutoTimerRemainingMs);
      state.pausedAutoTimerRemainingMs = null;
      return true;
    } else {
      debugLog(`[TIMER] Paused time out of reasonable range (${state.pausedAutoTimerRemainingMs}ms), not resuming`);
      state.pausedAutoTimerRemainingMs = null;
    }
  }
  return false;
}

/**
 * Handle manual ping blocked during auto mode by resuming the paused countdown
 * This ensures the UI returns to showing the auto countdown instead of staying stuck on the skip message
 * 
 * When a manual ping is blocked during auto mode (GPS unavailable, outside geofence, or too close), this function:
 * 1. Attempts to resume the paused auto countdown timer with remaining time
 * 2. If no paused countdown exists, schedules a new auto ping
 * 3. Does nothing if auto mode is not running
 * 
 * @returns {void}
 */
function handleManualPingBlockedDuringAutoMode() {
  if (state.txRxAutoRunning) {
    debugLog("[TX/RX AUTO] Manual ping blocked during auto mode - resuming auto countdown");
    const resumed = resumeAutoCountdown();
    if (!resumed) {
      debugLog("[TX/RX AUTO] No paused countdown to resume, scheduling new auto ping");
      scheduleNextAutoPing();
    }
  }
}

function startRxListeningCountdown(delayMs) {
  debugLog(`[TIMER] Starting RX listening countdown: ${delayMs}ms`);
  state.rxListeningEndTime = Date.now() + delayMs;
  rxListeningCountdownTimer.start(delayMs);
}

function stopRxListeningCountdown() {
  debugLog(`[TIMER] Stopping RX listening countdown`);
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
  debugLog(`[UI] updateControlsForCooldown: connected=${connected}, inCooldown=${inCooldown}, pingInProgress=${state.pingInProgress}, txRxAutoRunning=${state.txRxAutoRunning}, rxAutoRunning=${state.rxAutoRunning}`);
  
  // TX Ping button - disabled during cooldown or ping in progress
  txPingBtn.disabled = !connected || inCooldown || state.pingInProgress;
  
  // TX/RX Auto button - disabled during cooldown, ping in progress, OR when RX Auto running
  txRxAutoBtn.disabled = !connected || inCooldown || state.pingInProgress || state.rxAutoRunning;
  
  // RX Auto button - disabled when TX/RX Auto running (no cooldown restriction for RX-only mode)
  rxAutoBtn.disabled = !connected || state.txRxAutoRunning;
}

/**
 * Helper function to unlock ping controls after ping operation completes
 * @param {string} reason - Debug reason for unlocking controls
 */
function unlockPingControls(reason) {
  state.pingInProgress = false;
  updateControlsForCooldown();
  debugLog(`[UI] Ping controls unlocked (pingInProgress=false) ${reason}`);
}

// Timer cleanup
function cleanupAllTimers() {
  debugLog("[TIMER] Cleaning up all timers");
  
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
  
  // Clean up API queue timers
  stopFlushTimers();
  
  // Clean up state timer references
  state.autoCountdownTimer = null;
  
  stopAutoCountdown();
  stopRxListeningCountdown();
  state.cooldownEndTime = null;
  state.pausedAutoTimerRemainingMs = null;
  
  // Clear captured ping coordinates
  state.capturedPingCoords = null;
  
  // Clear ping in progress flag
  state.pingInProgress = false;
  
  // Clear device public key
  state.devicePublicKey = null;
  
  // Clear wardrive session ID and debug mode
  state.wardriveSessionId = null;
  state.debugMode = false;
  state.tempTxRepeaterData = null;
  
  // Clear RX batch buffer (no timeouts to clear anymore)
  if (state.rxBatchBuffer && state.rxBatchBuffer.size > 0) {
    state.rxBatchBuffer.clear();
    debugLog("[RX BATCH] RX batch buffer cleared");
  }
}

function enableControls(connected) {
  connectBtn.disabled     = false;
  channelInfoEl.textContent = CHANNEL_NAME;
  updateControlsForCooldown();
  
  // Keep ping controls always visible but disable when not connected
  // This is handled by updateControlsForCooldown() which sets disabled state
  // No need to show/hide the controls anymore
}
function updateAutoButton() {
  // Update TX/RX Auto button
  if (state.txRxAutoRunning) {
    txRxAutoBtn.textContent = "Stop TX/RX";
    txRxAutoBtn.classList.remove("bg-indigo-600","hover:bg-indigo-500");
    txRxAutoBtn.classList.add("bg-amber-600","hover:bg-amber-500");
  } else {
    txRxAutoBtn.textContent = "TX/RX Auto";
    txRxAutoBtn.classList.add("bg-indigo-600","hover:bg-indigo-500");
    txRxAutoBtn.classList.remove("bg-amber-600","hover:bg-amber-500");
  }
  
  // Update RX Auto button
  if (state.rxAutoRunning) {
    rxAutoBtn.textContent = "Stop RX";
    rxAutoBtn.classList.remove("bg-indigo-600","hover:bg-indigo-500");
    rxAutoBtn.classList.add("bg-amber-600","hover:bg-amber-500");
  } else {
    rxAutoBtn.textContent = "RX Auto";
    rxAutoBtn.classList.add("bg-indigo-600","hover:bg-indigo-500");
    rxAutoBtn.classList.remove("bg-amber-600","hover:bg-amber-500");
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
    debugLog("[UI] Coverage iframe URL:", url);
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

/**
 * Set connection status bar message
 * Updates the #connectionStatus element with one of four fixed states:
 * - "Connected" - Device ready for wardriving after full connection (green)
 * - "Connecting" - Connection process in progress (blue)
 * - "Disconnected" - No device connected (red)
 * - "Disconnecting" - Disconnection process in progress (blue)
 * 
 * @param {string} text - Connection status text (one of the four states above)
 * @param {string} color - Status color class from STATUS_COLORS
 */
function setConnStatus(text, color) {
  const connectionStatusEl = document.getElementById("connectionStatus");
  const statusIndicatorEl = document.getElementById("statusIndicator");
  
  if (!connectionStatusEl) return;
  
  debugLog(`[UI] Connection status: "${text}"`);
  connectionStatusEl.textContent = text;
  connectionStatusEl.className = `font-medium ${color}`;
  
  // Update status indicator dot color to match
  if (statusIndicatorEl) {
    statusIndicatorEl.className = `text-lg ${color}`;
  }
}

/**
 * Set dynamic status bar message
 * Updates the #status element with non-connection status messages.
 * Uses 500ms minimum visibility for first display, immediate for countdown updates.
 * 
 * Connection status words (Connected/Connecting/Disconnecting/Disconnected) are blocked
 * and replaced with em dash (—) placeholder.
 * 
 * @param {string} text - Status message text (null/empty shows "—")
 * @param {string} color - Status color class from STATUS_COLORS
 * @param {boolean} immediate - If true, bypass minimum visibility (for countdown timers)
 */
function setDynamicStatus(text, color = STATUS_COLORS.idle, immediate = false) {
  // Normalize empty/null/whitespace to em dash
  if (!text || text.trim() === '') {
    text = '—';
    color = STATUS_COLORS.idle;
  }
  
  // Block connection words from dynamic bar
  const connectionWords = ['Connected', 'Connecting', 'Disconnecting', 'Disconnected'];
  if (connectionWords.includes(text)) {
    debugWarn(`[UI] Attempted to show connection word "${text}" in dynamic status bar - blocked, showing em dash instead`);
    text = '—';
    color = STATUS_COLORS.idle;
  }
  
  // Reuse existing setStatus implementation with minimum visibility
  setStatus(text, color, immediate);
}



// ---- Wake Lock helpers ----
async function acquireWakeLock() {
  debugLog("[WAKE LOCK] Attempting to acquire wake lock");
  if (navigator.bluetooth && typeof navigator.bluetooth.setScreenDimEnabled === "function") {
    try {
      navigator.bluetooth.setScreenDimEnabled(true);
      state.bluefyLockEnabled = true;
      debugLog("[WAKE LOCK] Bluefy screen-dim prevention enabled");
      return;
    } catch (e) {
      debugWarn("[WAKE LOCK] Bluefy setScreenDimEnabled failed:", e);
    }
  }
  try {
    if ("wakeLock" in navigator && typeof navigator.wakeLock.request === "function") {
      state.wakeLock = await navigator.wakeLock.request("screen");
      debugLog("[WAKE LOCK] Wake lock acquired successfully");
      state.wakeLock.addEventListener?.("release", () => debugLog("[WAKE LOCK] Wake lock released"));
    } else {
      debugLog("[WAKE LOCK] Wake Lock API not supported on this device");
    }
  } catch (err) {
    debugError(`[WAKE LOCK] Could not obtain wake lock: ${err.name}, ${err.message}`);
  }
}
async function releaseWakeLock() {
  debugLog("[WAKE LOCK] Attempting to release wake lock");
  if (state.bluefyLockEnabled && navigator.bluetooth && typeof navigator.bluetooth.setScreenDimEnabled === "function") {
    try {
      navigator.bluetooth.setScreenDimEnabled(false);
      state.bluefyLockEnabled = false;
      debugLog("[WAKE LOCK] Bluefy screen-dim prevention disabled");
    } catch (e) {
      debugWarn("[WAKE LOCK] Bluefy setScreenDimEnabled(false) failed:", e);
    }
  }
  try {
    if (state.wakeLock) {
      await state.wakeLock.release?.();
      state.wakeLock = null;
      debugLog("[WAKE LOCK] Wake lock released successfully");
    }
  } catch (e) {
    debugWarn("[WAKE LOCK] Error releasing wake lock:", e);
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
  debugLog(`[GEOFENCE] Calculating Haversine distance: (${lat1.toFixed(5)}, ${lon1.toFixed(5)}) to (${lat2.toFixed(5)}, ${lon2.toFixed(5)})`);
  
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
  
  debugLog(`[GEOFENCE] Haversine distance calculated: ${distance.toFixed(2)}m`);
  return distance;
}

/**
 * Validate that GPS coordinates are within the Ottawa geofence
 * @param {number} lat - Latitude to check
 * @param {number} lon - Longitude to check
 * @returns {boolean} True if within geofence, false otherwise
 */
function validateGeofence(lat, lon) {
  debugLog(`[GEOFENCE] Validating geofence for coordinates: (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
  debugLog(`[GEOFENCE] Geofence center: (${OTTAWA_CENTER_LAT}, ${OTTAWA_CENTER_LON}), radius: ${OTTAWA_GEOFENCE_RADIUS_M}m`);
  
  const distance = calculateHaversineDistance(lat, lon, OTTAWA_CENTER_LAT, OTTAWA_CENTER_LON);
  const isWithinGeofence = distance <= OTTAWA_GEOFENCE_RADIUS_M;
  
  debugLog(`[GEOFENCE] Geofence validation: distance=${distance.toFixed(2)}m, within_geofence=${isWithinGeofence}`);
  return isWithinGeofence;
}

/**
 * Validate that current GPS coordinates are at least 25m from last successful ping
 * @param {number} lat - Current latitude
 * @param {number} lon - Current longitude
 * @returns {boolean} True if distance >= 25m or no previous ping, false otherwise
 */
function validateMinimumDistance(lat, lon) {
  debugLog(`[GEOFENCE] Validating minimum distance for coordinates: (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
  
  if (!state.lastSuccessfulPingLocation) {
    debugLog("[GEOFENCE] No previous successful ping location, minimum distance check skipped");
    return true;
  }
  
  const { lat: lastLat, lon: lastLon } = state.lastSuccessfulPingLocation;
  debugLog(`[GEOFENCE] Last successful ping location: (${lastLat.toFixed(5)}, ${lastLon.toFixed(5)})`);
  
  const distance = calculateHaversineDistance(lat, lon, lastLat, lastLon);
  const isMinimumDistanceMet = distance >= MIN_PING_DISTANCE_M;
  
  debugLog(`[GEOFENCE] Distance validation: distance=${distance.toFixed(2)}m, minimum_distance_met=${isMinimumDistanceMet} (threshold=${MIN_PING_DISTANCE_M}m)`);
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
    distanceInfoEl.textContent = `∆${Math.round(distance)}m`;
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
      // GPS errors are now shown in Dynamic Status Bar, not in GPS block
      gpsInfoEl.textContent = "-";
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
  gpsAccEl.textContent = accM ? `±${Math.round(accM)}m` : "-";
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
    debugLog("[GPS] GPS watch already running, skipping start");
    return;
  }
  if (!("geolocation" in navigator)) {
    debugError("[GPS] Geolocation not available in navigator");
    return;
  }

  debugLog("[GPS] Starting GPS watch");
  state.gpsState = "acquiring";
  updateGpsUi();
  startGpsAgeUpdater(); // Start the age counter

  state.geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      debugLog(`[GPS] GPS fix acquired: lat=${pos.coords.latitude.toFixed(5)}, lon=${pos.coords.longitude.toFixed(5)}, accuracy=${pos.coords.accuracy}m`);
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
      debugError(`[GPS] GPS watch error: ${err.code} - ${err.message}`);
      state.gpsState = "error";
      // Display GPS error in Dynamic Status Bar
      setDynamicStatus("GPS error - check permissions", STATUS_COLORS.error);
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
    debugLog("[GPS] No GPS watch to stop");
    return;
  }
  debugLog("[GPS] Stopping GPS watch");
  navigator.geolocation.clearWatch(state.geoWatchId);
  state.geoWatchId = null;
  stopGpsAgeUpdater(); // Stop the age counter
}
async function primeGpsOnce() {
  debugLog("[GPS] Priming GPS with initial position request");
  // Start continuous watch so the UI keeps updating
  startGeoWatch();

  state.gpsState = "acquiring";
  updateGpsUi();

  try {
    const pos = await getCurrentPosition();

    debugLog(`[GPS] Initial GPS position acquired: lat=${pos.coords.latitude.toFixed(5)}, lon=${pos.coords.longitude.toFixed(5)}, accuracy=${pos.coords.accuracy}m`);
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
      debugLog(`[GPS] GPS accuracy ${state.lastFix.accM}m is within threshold, refreshing coverage map`);
      scheduleCoverageRefresh(
        state.lastFix.lat,
        state.lastFix.lon
      );
    } else {
      debugLog(`[GPS] GPS accuracy ${state.lastFix.accM}m exceeds threshold (${GPS_ACCURACY_THRESHOLD_M}m), skipping map refresh`);
    }

  } catch (e) {
    debugError(`[GPS] primeGpsOnce failed: ${e.message}`);
    state.gpsState = "error";
    // Display GPS error in Dynamic Status Bar
    setDynamicStatus("GPS error - check permissions", STATUS_COLORS.error);
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
  
  debugLog(`[CHANNEL] Channel key derived successfully (${channelKey.length} bytes)`);
  
  return channelKey;
}

// ---- Channel helpers ----
async function createWardriveChannel() {
  if (!state.connection) throw new Error("Not connected");
  
  debugLog(`[CHANNEL] Attempting to create channel: ${CHANNEL_NAME}`);
  
  // Get all channels
  const channels = await state.connection.getChannels();
  debugLog(`[CHANNEL] Retrieved ${channels.length} channels`);
  
  // Find first empty channel slot
  let emptyIdx = -1;
  for (let i = 0; i < channels.length; i++) {
    if (channels[i].name === '') {
      emptyIdx = i;
      debugLog(`[CHANNEL] Found empty channel slot at index: ${emptyIdx}`);
      break;
    }
  }
  
  // Throw error if no free slots
  if (emptyIdx === -1) {
    debugError(`[CHANNEL] No empty channel slots available`);
    throw new Error(
      `No empty channel slots available. Please free a channel slot on your companion first.`
    );
  }
  
  // Derive the channel key from the channel name
  const channelKey = await deriveChannelKey(CHANNEL_NAME);
  
  // Create the channel
  debugLog(`[CHANNEL] Creating channel ${CHANNEL_NAME} at index ${emptyIdx}`);
  await state.connection.setChannel(emptyIdx, CHANNEL_NAME, channelKey);
  debugLog(`[CHANNEL] Channel ${CHANNEL_NAME} created successfully at index ${emptyIdx}`);
  
  // Return channel object
  return {
    channelIdx: emptyIdx,
    name: CHANNEL_NAME
  };
}

async function ensureChannel() {
  if (!state.connection) throw new Error("Not connected");
  if (state.channel) {
    debugLog(`[CHANNEL] Using existing channel: ${CHANNEL_NAME}`);
    return state.channel;
  }

  setDynamicStatus("Looking for #wardriving channel", STATUS_COLORS.info);
  debugLog(`[CHANNEL] Looking up channel: ${CHANNEL_NAME}`);
  let ch = await state.connection.findChannelByName(CHANNEL_NAME);
  
  if (!ch) {
    setDynamicStatus("Channel #wardriving not found", STATUS_COLORS.info);
    debugLog(`[CHANNEL] Channel ${CHANNEL_NAME} not found, attempting to create it`);
    try {
      ch = await createWardriveChannel();
      setDynamicStatus("Created #wardriving", STATUS_COLORS.success);
      debugLog(`[CHANNEL] Channel ${CHANNEL_NAME} created successfully`);
    } catch (e) {
      debugError(`[CHANNEL] Failed to create channel ${CHANNEL_NAME}: ${e.message}`);
      enableControls(false);
      throw new Error(
        `Channel ${CHANNEL_NAME} not found and could not be created: ${e.message}`
      );
    }
  } else {
    setDynamicStatus("Channel #wardriving found", STATUS_COLORS.success);
    debugLog(`[CHANNEL] Channel found: ${CHANNEL_NAME} (index: ${ch.channelIdx})`);
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
    debugError("[CAPACITY] checkCapacity called but no public key stored");
    return reason === "connect" ? false : true; // Fail closed on connect, allow disconnect
  }

  // Set status for connect requests
  if (reason === "connect") {
    setDynamicStatus("Acquiring wardriving slot", STATUS_COLORS.info);
  }

  try {
    const payload = {
      key: MESHMAPPER_API_KEY,
      public_key: state.devicePublicKey,
      ver: APP_VERSION,
      who: getDeviceIdentifier(),
      ver: APP_VERSION,
      reason: reason
    };

    debugLog(`[CAPACITY] Checking capacity: reason=${reason}, public_key=${state.devicePublicKey.substring(0, 16)}..., who=${payload.who}`);

    const response = await fetch(MESHMAPPER_CAPACITY_CHECK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      debugError(`[CAPACITY] Capacity check API returned error status ${response.status}`);
      // Fail closed on network errors for connect
      if (reason === "connect") {
        debugError("[CAPACITY] Failing closed (denying connection) due to API error");
        state.disconnectReason = "app_down"; // Track disconnect reason
        return false;
      }
      return true; // Always allow disconnect to proceed
    }

    const data = await response.json();
    debugLog(`[CAPACITY] Capacity check response: allowed=${data.allowed}, session_id=${data.session_id || 'missing'}, debug_mode=${data.debug_mode || 'not set'}, reason=${data.reason || 'none'}`);

    // Handle capacity full vs. allowed cases separately
    if (data.allowed === false && reason === "connect") {
      // Check if a reason code is provided
      if (data.reason) {
        debugLog(`[CAPACITY] API returned reason code: ${data.reason}`);
        state.disconnectReason = data.reason; // Store the reason code directly
      } else {
        state.disconnectReason = "capacity_full"; // Default to capacity_full
      }
      return false;
    }
    
    // For connect requests, validate session_id and check debug_mode
    if (reason === "connect" && data.allowed === true) {
      if (!data.session_id) {
        debugError("[CAPACITY] Capacity check returned allowed=true but session_id is missing");
        state.disconnectReason = "session_id_error"; // Track disconnect reason
        return false;
      }
      
      // Store the session_id for use in MeshMapper API posts
      state.wardriveSessionId = data.session_id;
      debugLog(`[CAPACITY] Wardrive session ID received and stored: ${state.wardriveSessionId}`);
      
      // Check for debug_mode flag (optional field)
      if (data.debug_mode === 1) {
        state.debugMode = true;
        debugLog(`[CAPACITY] 🐛 DEBUG MODE ENABLED by API`);
      } else {
        state.debugMode = false;
        debugLog(`[CAPACITY] Debug mode NOT enabled`);
      }
    }
    
    // For disconnect requests, clear the session_id and debug mode
    if (reason === "disconnect") {
      if (state.wardriveSessionId) {
        debugLog(`[CAPACITY] Clearing wardrive session ID on disconnect: ${state.wardriveSessionId}`);
        state.wardriveSessionId = null;
      }
      state.debugMode = false;
      debugLog(`[CAPACITY] Debug mode cleared on disconnect`);
    }
    
    return data.allowed === true;

  } catch (error) {
    debugError(`[CAPACITY] Capacity check failed: ${error.message}`);
    
    // Fail closed on network errors for connect
    if (reason === "connect") {
      debugError("[CAPACITY] Failing closed (denying connection) due to network error");
      state.disconnectReason = "app_down"; // Track disconnect reason
      return false;
    }
    
    return true; // Always allow disconnect to proceed
  }
}

/**
 * Convert raw bytes to hex string
 * @param {Uint8Array} bytes - Raw bytes
 * @returns {string} Hex string representation
 */
function bytesToHex(bytes) {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * Build debug data object for a single packet observation
 * @param {Object} rawPacketData - Raw packet data from handleTxLogging or handleRxLogging
 * @param {string} heardByte - The "heard" byte (first for TX, last for RX) as hex string
 * @returns {Object} Debug data object
 */
function buildDebugData(metadata, heardByte, repeaterId) {
  // Convert path bytes to hex string - these are the ACTUAL bytes used
  const parsedPathHex = Array.from(metadata.pathBytes)
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
    .join('');
  
  return {
    raw_packet: bytesToHex(metadata.raw),
    raw_snr: metadata.snr,
    raw_rssi: metadata.rssi,
    parsed_header: metadata.header.toString(16).padStart(2, '0').toUpperCase(),
    parsed_path_length: metadata.pathLength,
    parsed_path: parsedPathHex,  // ACTUAL raw bytes
    parsed_payload: bytesToHex(metadata.encryptedPayload),
    parsed_heard: heardByte,
    repeaterId: repeaterId
  };
}

/**
 * Post wardrive ping data to MeshMapper API
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {string} heardRepeats - Heard repeats string (e.g., "4e(1.75),b7(-0.75)" or "None")
 */
async function postToMeshMapperAPI(lat, lon, heardRepeats) {
  try {
    // Validate session_id exists before posting
    if (!state.wardriveSessionId) {
      debugError("[API QUEUE] Cannot post to MeshMapper API: no session_id available");
      setDynamicStatus("Missing session ID", STATUS_COLORS.error);
      state.disconnectReason = "session_id_error"; // Track disconnect reason
      // Disconnect after a brief delay to ensure user sees the error message
      setTimeout(() => {
        disconnect().catch(err => debugError(`[BLE] Disconnect after missing session_id failed: ${err.message}`));
      }, 1500);
      return; // Exit early
    }
    
    const payload = {
      key: MESHMAPPER_API_KEY,
      lat,
      lon,
      who: getDeviceIdentifier(),
      power: getCurrentPowerSetting(),
      heard_repeats: heardRepeats,
      ver: APP_VERSION,
      test: 0,
      iata: WARDIVE_IATA_CODE,
      session_id: state.wardriveSessionId,
      WARDRIVE_TYPE: "TX"
    };

    // Add debug data if debug mode is enabled and repeater data is available
    if (state.debugMode && state.tempTxRepeaterData && state.tempTxRepeaterData.length > 0) {
      debugLog(`[API QUEUE] 🐛 Debug mode active - building debug_data array for TX`);
      
      const debugDataArray = [];
      
      for (const repeater of state.tempTxRepeaterData) {
        if (repeater.metadata) {
          const heardByte = repeater.repeaterId;  // First byte of path
          const debugData = buildDebugData(repeater.metadata, heardByte, repeater.repeaterId);
          debugDataArray.push(debugData);
          debugLog(`[API QUEUE] 🐛 Added debug data for TX repeater: ${repeater.repeaterId}`);
        }
      }
      
      if (debugDataArray.length > 0) {
        payload.debug_data = debugDataArray;
        debugLog(`[API QUEUE] 🐛 TX payload includes ${debugDataArray.length} debug_data entries`);
      }
      
      // Clear temp data after use
      state.tempTxRepeaterData = null;
    }

    debugLog(`[API QUEUE] Posting to MeshMapper API: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, who=${payload.who}, power=${payload.power}, heard_repeats=${heardRepeats}, ver=${payload.ver}, iata=${payload.iata}, session_id=${payload.session_id}, WARDRIVE_TYPE=${payload.WARDRIVE_TYPE}${payload.debug_data ? `, debug_data=${payload.debug_data.length} entries` : ''}`);

    const response = await fetch(MESHMAPPER_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    debugLog(`[API QUEUE] MeshMapper API response status: ${response.status}`);

    // Always try to parse the response body to check for slot revocation
    // regardless of HTTP status code
    try {
      const data = await response.json();
      debugLog(`[API QUEUE] MeshMapper API response data: ${JSON.stringify(data)}`);
      
      // Check if slot has been revoked
      if (data.allowed === false) {
        debugError("[API QUEUE] MeshMapper slot has been revoked");
        setDynamicStatus("API post failed (revoked)", STATUS_COLORS.error);
        state.disconnectReason = "slot_revoked"; // Track disconnect reason
        // Disconnect after a brief delay to ensure user sees the error message
        setTimeout(() => {
          disconnect().catch(err => debugError(`[BLE] Disconnect after slot revocation failed: ${err.message}`));
        }, 1500);
        return; // Exit early after slot revocation
      } else if (data.allowed === true) {
        debugLog("[API QUEUE] MeshMapper API allowed check passed: device still has an active MeshMapper slot");
      } else {
        debugError(`[API QUEUE] MeshMapper API response missing 'allowed' field: ${JSON.stringify(data)}`);
      }
    } catch (parseError) {
      debugError(`[API QUEUE] Failed to parse MeshMapper API response: ${parseError.message}`);
      // Continue operation if we can't parse the response
    }

    if (!response.ok) {
      debugError(`[API QUEUE] MeshMapper API returned error status ${response.status}`);
    } else {
      debugLog(`[API QUEUE] MeshMapper API post successful (status ${response.status})`);
    }
  } catch (error) {
    // Log error but don't fail the ping
    debugError(`[API QUEUE] MeshMapper API post failed: ${error.message}`);
  }
}

/**
 * Post to MeshMapper API in background (non-blocking)
 * This function runs asynchronously after the RX listening window completes
 * UI status messages are suppressed for successful posts, errors are shown
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} accuracy - GPS accuracy in meters
 * @param {string} heardRepeats - Heard repeats string (e.g., "4e(1.75),b7(-0.75)" or "None")
 */
async function postApiInBackground(lat, lon, accuracy, heardRepeats) {
  debugLog(`[API QUEUE] postApiInBackground called with heard_repeats="${heardRepeats}"`);
  
  // Hidden 3-second delay before API POST (no user-facing status message)
  debugLog("[API QUEUE] Starting 3-second delay before API POST");
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  debugLog("[API QUEUE] 3-second delay complete, posting to API");
  try {
    await postToMeshMapperAPI(lat, lon, heardRepeats);
    debugLog("[API QUEUE] Background API post completed successfully");
    // No success status message - suppress from UI
  } catch (error) {
    debugError("[API QUEUE] Background API post failed:", error);
    // Errors are propagated to caller for user notification
    throw error;
  }
  
  // Update map after API post
  debugLog("[UI] Scheduling coverage map refresh");
  setTimeout(() => {
    const shouldRefreshMap = accuracy && accuracy < GPS_ACCURACY_THRESHOLD_M;
    
    if (shouldRefreshMap) {
      debugLog(`[UI] Refreshing coverage map (accuracy ${accuracy}m within threshold)`);
      scheduleCoverageRefresh(lat, lon);
    } else {
      debugLog(`[UI] Skipping map refresh (accuracy ${accuracy}m exceeds threshold)`);
    }
  }, MAP_REFRESH_DELAY_MS);
}

/**
 * Post to MeshMapper API and refresh coverage map after heard repeats are finalized
 * This function now queues TX messages instead of posting immediately
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} accuracy - GPS accuracy in meters
 * @param {string} heardRepeats - Heard repeats string (e.g., "4e(1.75),b7(-0.75)" or "None")
 */
async function postApiAndRefreshMap(lat, lon, accuracy, heardRepeats) {
  debugLog(`[API QUEUE] postApiAndRefreshMap called with heard_repeats="${heardRepeats}"`);
  
  // Build payload
  const payload = {
    key: MESHMAPPER_API_KEY,
    lat,
    lon,
    who: getDeviceIdentifier(),
    power: getCurrentPowerSetting(),
    heard_repeats: heardRepeats,
    ver: APP_VERSION,
    test: 0,
    iata: WARDIVE_IATA_CODE,
    session_id: state.wardriveSessionId
  };
  
  // Queue message instead of posting immediately
  queueApiMessage(payload, "TX");
  debugLog(`[API QUEUE] TX message queued: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, heard_repeats="${heardRepeats}"`);
  
  // Update map after queueing
  setTimeout(() => {
    const shouldRefreshMap = accuracy && accuracy < GPS_ACCURACY_THRESHOLD_M;
    
    if (shouldRefreshMap) {
      debugLog(`[UI] Refreshing coverage map (accuracy ${accuracy}m within threshold)`);
      scheduleCoverageRefresh(lat, lon);
    } else {
      debugLog(`[UI] Skipping map refresh (accuracy ${accuracy}m exceeds threshold)`);
    }
    
    // Unlock ping controls now that message is queued
    unlockPingControls("after TX message queued");
    
    // Update status based on current mode
    if (state.connection) {
      if (state.txRxAutoRunning) {
        // Check if we should resume a paused auto countdown (manual ping during auto mode)
        const resumed = resumeAutoCountdown();
        if (!resumed) {
          // No paused timer to resume, schedule new auto ping (this was an auto ping)
          debugLog("[TX/RX AUTO] Scheduling next auto ping");
          scheduleNextAutoPing();
        } else {
          debugLog("[TX/RX AUTO] Resumed auto countdown after manual ping");
        }
      } else {
        debugLog("[TX/RX AUTO] Setting dynamic status to show queue size");
        // Status already set by queueApiMessage()
      }
    }
  }, MAP_REFRESH_DELAY_MS);
}

// ---- API Batch Queue System ----

/**
 * Queue an API message for batch posting
 * @param {Object} payload - The API payload object
 * @param {string} wardriveType - "TX" or "RX" wardrive type
 */
function queueApiMessage(payload, wardriveType) {
  debugLog(`[API QUEUE] Queueing ${wardriveType} message`);
  
  // Add WARDRIVE_TYPE to payload
  const messagePayload = {
    ...payload,
    WARDRIVE_TYPE: wardriveType
  };
  
  apiQueue.messages.push(messagePayload);
  debugLog(`[API QUEUE] Queue size: ${apiQueue.messages.length}/${API_BATCH_MAX_SIZE}`);
  
  // Start periodic flush timer if this is the first message
  if (apiQueue.messages.length === 1 && !apiQueue.flushTimerId) {
    startFlushTimer();
  }
  
  // If TX type: start/reset 3-second flush timer
  if (wardriveType === "TX") {
    scheduleTxFlush();
  }
  
  // If queue reaches max size: flush immediately
  if (apiQueue.messages.length >= API_BATCH_MAX_SIZE) {
    debugLog(`[API QUEUE] Queue reached max size (${API_BATCH_MAX_SIZE}), flushing immediately`);
    flushApiQueue();
  }
  
  // Queue depth is logged above for debugging - no need to show in dynamic status bar
}

/**
 * Schedule flush 3 seconds after TX ping
 * Resets timer if called again (coalesces rapid TX pings)
 */
function scheduleTxFlush() {
  debugLog(`[API QUEUE] Scheduling TX flush in ${API_TX_FLUSH_DELAY_MS}ms`);
  
  // Clear existing TX flush timer if present
  if (apiQueue.txFlushTimerId) {
    clearTimeout(apiQueue.txFlushTimerId);
    debugLog(`[API QUEUE] Cleared previous TX flush timer`);
  }
  
  // Schedule new TX flush
  apiQueue.txFlushTimerId = setTimeout(() => {
    debugLog(`[API QUEUE] TX flush timer fired`);
    flushApiQueue();
  }, API_TX_FLUSH_DELAY_MS);
}

/**
 * Start the 30-second periodic flush timer
 */
function startFlushTimer() {
  debugLog(`[API QUEUE] Starting periodic flush timer (${API_BATCH_FLUSH_INTERVAL_MS}ms)`);
  
  // Clear existing timer if present
  if (apiQueue.flushTimerId) {
    clearInterval(apiQueue.flushTimerId);
  }
  
  // Start periodic flush timer
  apiQueue.flushTimerId = setInterval(() => {
    if (apiQueue.messages.length > 0) {
      debugLog(`[API QUEUE] Periodic flush timer fired, flushing ${apiQueue.messages.length} messages`);
      flushApiQueue();
    }
  }, API_BATCH_FLUSH_INTERVAL_MS);
}

/**
 * Stop all flush timers (periodic and TX)
 */
function stopFlushTimers() {
  debugLog(`[API QUEUE] Stopping all flush timers`);
  
  if (apiQueue.flushTimerId) {
    clearInterval(apiQueue.flushTimerId);
    apiQueue.flushTimerId = null;
    debugLog(`[API QUEUE] Periodic flush timer stopped`);
  }
  
  if (apiQueue.txFlushTimerId) {
    clearTimeout(apiQueue.txFlushTimerId);
    apiQueue.txFlushTimerId = null;
    debugLog(`[API QUEUE] TX flush timer stopped`);
  }
}

/**
 * Flush all queued messages to the API
 * Prevents concurrent flushes with isProcessing flag
 * @returns {Promise<void>}
 */
async function flushApiQueue() {
  // Prevent concurrent flushes
  if (apiQueue.isProcessing) {
    debugWarn(`[API QUEUE] Flush already in progress, skipping`);
    return;
  }
  
  // Nothing to flush
  if (apiQueue.messages.length === 0) {
    debugLog(`[API QUEUE] Queue is empty, nothing to flush`);
    return;
  }
  
  // Lock processing
  apiQueue.isProcessing = true;
  debugLog(`[API QUEUE] Starting flush of ${apiQueue.messages.length} messages`);
  
  // Clear TX flush timer when flushing
  if (apiQueue.txFlushTimerId) {
    clearTimeout(apiQueue.txFlushTimerId);
    apiQueue.txFlushTimerId = null;
  }
  
  // Take all messages from queue
  const batch = [...apiQueue.messages];
  apiQueue.messages = [];
  
  // Count TX and RX messages for logging
  const txCount = batch.filter(m => m.WARDRIVE_TYPE === "TX").length;
  const rxCount = batch.filter(m => m.WARDRIVE_TYPE === "RX").length;
  debugLog(`[API QUEUE] Batch composition: ${txCount} TX, ${rxCount} RX`);
  
  // Status removed from dynamic status bar - debug log above is sufficient for debugging
  
  try {
    // Validate session_id exists
    if (!state.wardriveSessionId) {
      debugError("[API QUEUE] Cannot flush: no session_id available");
      setDynamicStatus("Missing session ID", STATUS_COLORS.error);
      state.disconnectReason = "session_id_error";
      setTimeout(() => {
        disconnect().catch(err => debugError(`[BLE] Disconnect after missing session_id failed: ${err.message}`));
      }, 1500);
      return;
    }
    
    debugLog(`[API QUEUE] POST to ${MESHMAPPER_API_URL} with ${batch.length} messages`);
    
    const response = await fetch(MESHMAPPER_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch)
    });
    
    debugLog(`[API QUEUE] Response status: ${response.status}`);
    
    // Parse response to check for slot revocation
    try {
      const data = await response.json();
      debugLog(`[API QUEUE] Response data: ${JSON.stringify(data)}`);
      
      // Check if slot has been revoked
      if (data.allowed === false) {
        debugError("[API QUEUE] MeshMapper slot has been revoked");
        setDynamicStatus("API post failed (revoked)", STATUS_COLORS.error);
        state.disconnectReason = "slot_revoked";
        setTimeout(() => {
          disconnect().catch(err => debugError(`[BLE] Disconnect after slot revocation failed: ${err.message}`));
        }, 1500);
        return;
      } else if (data.allowed === true) {
        debugLog("[API QUEUE] Slot check passed");
      }
    } catch (parseError) {
      debugError(`[API QUEUE] Failed to parse response: ${parseError.message}`);
    }
    
    if (!response.ok) {
      debugError(`[API QUEUE] API returned error status ${response.status}`);
      setDynamicStatus("Error: API batch post failed", STATUS_COLORS.error);
    } else {
      debugLog(`[API QUEUE] Batch post successful: ${txCount} TX, ${rxCount} RX`);
      // Clear status after successful post
      if (state.connection && !state.txRxAutoRunning) {
        setDynamicStatus("Idle");
      }
    }
  } catch (error) {
    debugError(`[API QUEUE] Batch post failed: ${error.message}`);
    setDynamicStatus("Error: API batch post failed", STATUS_COLORS.error);
  } finally {
    // Unlock processing
    apiQueue.isProcessing = false;
    debugLog(`[API QUEUE] Flush complete`);
  }
}

/**
 * Get queue status for debugging
 * @returns {Object} Queue status object
 */
function getQueueStatus() {
  return {
    queueSize: apiQueue.messages.length,
    isProcessing: apiQueue.isProcessing,
    hasPeriodicTimer: apiQueue.flushTimerId !== null,
    hasTxTimer: apiQueue.txFlushTimerId !== null
  };
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
 * Parse RX packet metadata from raw bytes
 * Single source of truth for header/path extraction
 * @param {Object} data - LogRxData event data (contains lastSnr, lastRssi, raw)
 * @returns {Object} Parsed metadata object
 */
function parseRxPacketMetadata(data) {
  debugLog(`[RX PARSE] Starting metadata parsing`);
  
  // Extract header byte from raw[0]
  const header = data.raw[0];
  
  // Extract path length from header upper 4 bits: (header >> 4) & 0x0F
  const pathLength = (header >> 4) & 0x0F;
  
  // Extract raw path bytes as array: raw.slice(1, 1 + pathLength)
  const pathBytes = Array.from(data.raw.slice(1, 1 + pathLength));
  
  // Derive first hop (for TX repeater ID): pathBytes[0]
  const firstHop = pathBytes.length > 0 ? pathBytes[0] : null;
  
  // Derive last hop (for RX repeater ID): pathBytes[pathLength - 1]
  const lastHop = pathBytes.length > 0 ? pathBytes[pathLength - 1] : null;
  
  // Extract encrypted payload: raw.slice(1 + pathLength)
  const encryptedPayload = data.raw.slice(1 + pathLength);
  
  debugLog(`[RX PARSE] Parsed metadata: header=0x${header.toString(16).padStart(2, '0')}, pathLength=${pathLength}, firstHop=${firstHop ? '0x' + firstHop.toString(16).padStart(2, '0') : 'null'}, lastHop=${lastHop ? '0x' + lastHop.toString(16).padStart(2, '0') : 'null'}`);
  
  return {
    raw: data.raw,                     // Full raw packet bytes
    header: header,                    // Header byte
    pathLength: pathLength,            // Number of hops
    pathBytes: pathBytes,              // Raw path bytes array
    firstHop: firstHop,                // First hop ID (TX)
    lastHop: lastHop,                  // Last hop ID (RX)
    snr: data.lastSnr,                 // SNR value
    rssi: data.lastRssi,               // RSSI value
    encryptedPayload: encryptedPayload // Rest of packet
  };
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
function startTxTracking(payload, channelIdx) {
  debugLog(`[PING] Starting repeater echo tracking for ping: "${payload}" on channel ${channelIdx}`);
  debugLog(`[PING] 7-second rx_log listening window opened at ${new Date().toISOString()}`);
  
  // Verify we have the channel hash
  if (WARDRIVING_CHANNEL_HASH === null) {
    debugError(`[PING] Cannot start repeater tracking: channel hash not initialized`);
    return;
  }
  
  // Clear any existing tracking state
  stopTxTracking();
  
  debugLog(`[PING] Using pre-computed channel hash for correlation: 0x${WARDRIVING_CHANNEL_HASH.toString(16).padStart(2, '0')}`);
  
  // Initialize tracking state
  state.txTracking.isListening = true;
  state.txTracking.sentTimestamp = Date.now();
  state.txTracking.sentPayload = payload;
  state.txTracking.channelIdx = channelIdx;
  state.txTracking.repeaters.clear();
  
  debugLog(`[TX LOG] Session Log tracking activated - unified handler will delegate echoes to Session Log`);
  
  // Note: The unified RX handler (started at connect) will automatically delegate to
  // handleTxLogging() when isListening = true. No separate handler needed.
  // The 7-second timeout to stop listening is managed by the caller (sendPing function)
}

/**
 * Handle Session Log tracking for repeater echoes
 * Called by unified RX handler when tracking is active
 * @param {Object} metadata - Parsed metadata from parseRxPacketMetadata()
 * @param {Object} data - The LogRxData event data (contains lastSnr, lastRssi, raw)
 * @returns {boolean} True if packet was an echo and tracked, false otherwise
 */
async function handleTxLogging(metadata, data) {
  const originalPayload = state.txTracking.sentPayload;
  const channelIdx = state.txTracking.channelIdx;
  const expectedChannelHash = WARDRIVING_CHANNEL_HASH;
  try {
    debugLog(`[TX LOG] Processing rx_log entry: SNR=${metadata.snr}, RSSI=${metadata.rssi}`);
    
    // VALIDATION STEP 1: Header validation for echo detection
    // Only GroupText packets (CHANNEL_GROUP_TEXT_HEADER) can be echoes of our channel messages
    if (metadata.header !== CHANNEL_GROUP_TEXT_HEADER) {
      debugLog(`[TX LOG] Ignoring: header validation failed (header=0x${metadata.header.toString(16).padStart(2, '0')})`);
      return false;
    }
    
    debugLog(`[TX LOG] Header validation passed: 0x${metadata.header.toString(16).padStart(2, '0')}`);
    
    // VALIDATION STEP 2: Validate this message is for our channel by comparing channel hash
    // Channel message payload structure: [1 byte channel_hash][2 bytes MAC][encrypted message]
    if (metadata.encryptedPayload.length < 3) {
      debugLog(`[TX LOG] Ignoring: payload too short to contain channel hash`);
      return false;
    }
    
    const packetChannelHash = metadata.encryptedPayload[0];
    debugLog(`[TX LOG] Message correlation check: packet_channel_hash=0x${packetChannelHash.toString(16).padStart(2, '0')}, expected=0x${expectedChannelHash.toString(16).padStart(2, '0')}`);
    
    if (packetChannelHash !== expectedChannelHash) {
      debugLog(`[TX LOG] Ignoring: channel hash mismatch (packet=0x${packetChannelHash.toString(16).padStart(2, '0')}, expected=0x${expectedChannelHash.toString(16).padStart(2, '0')})`);
      return false;
    }
    
    debugLog(`[TX LOG] Channel hash match confirmed - this is a message on our channel`);
    
    // VALIDATION STEP 3: Decrypt and verify message content matches what we sent
    // This ensures we're tracking echoes of OUR specific ping, not other messages on the channel
    debugLog(`[MESSAGE_CORRELATION] Starting message content verification...`);
    
    if (WARDRIVING_CHANNEL_KEY) {
      debugLog(`[MESSAGE_CORRELATION] Channel key available, attempting decryption...`);
      const decryptedMessage = await decryptGroupTextPayload(metadata.encryptedPayload, WARDRIVING_CHANNEL_KEY);
      
      if (decryptedMessage === null) {
        debugLog(`[MESSAGE_CORRELATION] ❌ REJECT: Failed to decrypt message`);
        return false;
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
        return false;
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
    
    // VALIDATION STEP 4: Check path length (repeater echo vs direct transmission)
    // For channel messages, the path contains repeater hops
    // Each hop in the path is 1 byte (repeater ID)
    if (metadata.pathLength === 0) {
      debugLog(`[TX LOG] Ignoring: no path (direct transmission, not a repeater echo)`);
      return false;
    }
    
    // Extract only the first hop (first repeater ID) from the path
    // The path may contain multiple hops (e.g., [0x22, 0xd0, 0x5d, 0x46, 0x8b])
    // but we only care about the first repeater that echoed our message
    // Example: path [0x22, 0xd0, 0x5d] becomes "22" (only first hop)
    const firstHopId = metadata.firstHop;
    const pathHex = firstHopId.toString(16).padStart(2, '0');
    
    debugLog(`[PING] Repeater echo accepted: first_hop=${pathHex}, SNR=${metadata.snr}, full_path_length=${metadata.pathLength}`);
    
    // Check if we already have this path
    if (state.txTracking.repeaters.has(pathHex)) {
      const existing = state.txTracking.repeaters.get(pathHex);
      debugLog(`[PING] Deduplication: path ${pathHex} already seen (existing SNR=${existing.snr}, new SNR=${metadata.snr})`);
      
      // Keep the best (highest) SNR
      if (metadata.snr > existing.snr) {
        debugLog(`[PING] Deduplication decision: updating path ${pathHex} with better SNR: ${existing.snr} -> ${metadata.snr}`);
        state.txTracking.repeaters.set(pathHex, {
          snr: metadata.snr,
          seenCount: existing.seenCount + 1,
          metadata: metadata  // Store full metadata for debug mode
        });
        
        // Trigger incremental UI update since SNR changed
        updateCurrentTxLogEntryWithLiveRepeaters();
      } else {
        debugLog(`[PING] Deduplication decision: keeping existing SNR for path ${pathHex} (existing ${existing.snr} >= new ${metadata.snr})`);
        // Still increment seen count
        existing.seenCount++;
      }
    } else {
      // New path
      debugLog(`[PING] Adding new repeater echo: path=${pathHex}, SNR=${metadata.snr}`);
      state.txTracking.repeaters.set(pathHex, {
        snr: metadata.snr,
        seenCount: 1,
        metadata: metadata  // Store full metadata for debug mode
      });
      
      // Trigger incremental UI update for the new repeater
      updateCurrentTxLogEntryWithLiveRepeaters();
    }
    
    // Successfully tracked this echo
    debugLog(`[TX LOG] ✅ Echo tracked successfully`);
    return true;
    
  } catch (error) {
    debugError(`[TX LOG] Error processing rx_log entry: ${error.message}`, error);
    return false;
  }
}

/**
 * Stop listening for repeater echoes and return the results
 * @returns {Array<{repeaterId: string, snr: number}>} Array of repeater telemetry
 */
function stopTxTracking() {
  if (!state.txTracking.isListening) {
    return [];
  }
  
  debugLog(`[PING] Stopping repeater echo tracking`);
  
  // No need to unregister handler - unified handler continues running
  // Just clear the tracking state
  
  // Get the results with full data (including metadata for debug mode)
  const repeaters = Array.from(state.txTracking.repeaters.entries()).map(([id, data]) => ({
    repeaterId: id,
    snr: data.snr,
    metadata: data.metadata  // Include metadata for debug mode
  }));
  
  // Sort by repeater ID for deterministic output
  repeaters.sort((a, b) => a.repeaterId.localeCompare(b.repeaterId));
  
  debugLog(`[PING] Final aggregated repeater list: ${repeaters.length > 0 ? repeaters.map(r => `${r.repeaterId}(${r.snr}dB)`).join(', ') : 'none'}`);
  
  // Reset state
  state.txTracking.isListening = false;
  state.txTracking.sentTimestamp = null;
  state.txTracking.sentPayload = null;
  state.txTracking.repeaters.clear();
  state.txTracking.rxLogHandler = null; // Kept for compatibility
  state.txTracking.currentLogEntry = null;
  
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

// ---- Passive RX Log Listening ----

/**
 * Unified RX log event handler - processes all incoming packets
 * Delegates to Session Log tracking when active, otherwise handles passive RX logging
 * @param {Object} data - The LogRxData event data (contains lastSnr, lastRssi, raw)
 */
async function handleUnifiedRxLogEvent(data) {
  try {
    // Defensive check: ensure listener is marked as active
    if (!state.rxTracking.isListening) {
      debugWarn("[UNIFIED RX] Received event but listener marked inactive - reactivating");
      state.rxTracking.isListening = true;
    }
    
    // Parse metadata ONCE
    const metadata = parseRxPacketMetadata(data);
    
    debugLog(`[UNIFIED RX] Packet received: header=0x${metadata.header.toString(16)}, pathLength=${metadata.pathLength}`);
    
    // Route to TX tracking if active (during 7s echo window)
    if (state.txTracking.isListening) {
      debugLog("[UNIFIED RX] TX tracking active - checking for echo");
      const wasEcho = await handleTxLogging(metadata, data);
      if (wasEcho) {
        debugLog("[UNIFIED RX] Packet was TX echo, done");
        return;
      }
    }
    
    // Route to RX wardriving if active (when TX/RX Auto OR RX Auto enabled)
    if (state.rxTracking.isWardriving) {
      debugLog("[UNIFIED RX] RX wardriving active - logging observation");
      await handleRxLogging(metadata, data);
    }
    
    // If neither active, packet is received but ignored
    // Listener stays on, just not processing for wardriving
    
  } catch (error) {
    debugError("[UNIFIED RX] Error processing rx_log entry", error);
  }
}

/**
 * Handle passive RX logging - monitors all incoming packets not handled by Session Log
 * Extracts the LAST hop from the path (direct repeater) and records observation
 * @param {Object} metadata - Parsed metadata from parseRxPacketMetadata()
 * @param {Object} data - The LogRxData event data (contains lastSnr, lastRssi, raw)
 */
async function handleRxLogging(metadata, data) {
  try {
    debugLog(`[RX LOG] Processing packet for passive logging`);
    
    // VALIDATION: Check path length (need at least one hop)
    // A packet's path array contains the sequence of repeater IDs that forwarded the message.
    // Packets with no path are direct transmissions (node-to-node) and don't provide
    // information about repeater coverage, so we skip them for RX wardriving purposes.
    if (metadata.pathLength === 0) {
      debugLog(`[RX LOG] Ignoring: no path (direct transmission, not via repeater)`);
      return;
    }
    
    // Extract LAST hop from path (the repeater that directly delivered to us)
    const lastHopId = metadata.lastHop;
    const repeaterId = lastHopId.toString(16).padStart(2, '0');
    
    debugLog(`[RX LOG] Packet heard via last hop: ${repeaterId}, SNR=${metadata.snr}, path_length=${metadata.pathLength}`);
    
    // Get current GPS location
    if (!state.lastFix) {
      debugLog(`[RX LOG] No GPS fix available, skipping entry`);
      return;
    }
    
    const lat = state.lastFix.lat;
    const lon = state.lastFix.lon;
    const timestamp = new Date().toISOString();
    
    // Add entry to RX log (including RSSI, path length, and header for CSV export)
    addRxLogEntry(repeaterId, metadata.snr, metadata.rssi, metadata.pathLength, metadata.header, lat, lon, timestamp);
    
    debugLog(`[RX LOG] ✅ Observation logged: repeater=${repeaterId}, snr=${metadata.snr}, location=${lat.toFixed(5)},${lon.toFixed(5)}`);
    
    // Handle tracking for API (best SNR with distance trigger)
    handleRxBatching(
      repeaterId, 
      metadata.snr, 
      metadata.rssi, 
      metadata.pathLength, 
      metadata.header, 
      { lat, lon }, 
      metadata
    );
    
  } catch (error) {
    debugError(`[RX LOG] Error processing passive RX: ${error.message}`, error);
  }
}



/**
 * Start unified RX listening - handles both TX Log tracking and RX logging
 * Idempotent: safe to call multiple times
 */
function startUnifiedRxListening() {
  // Idempotent: safe to call multiple times
  if (state.rxTracking.isListening && state.rxTracking.rxLogHandler) {
    debugLog(`[UNIFIED RX] Already listening, skipping start`);
    return;
  }
  
  if (!state.connection) {
    debugWarn(`[UNIFIED RX] Cannot start: no connection`);
    return;
  }
  
  debugLog(`[UNIFIED RX] Starting unified RX listening`);
  
  const handler = (data) => handleUnifiedRxLogEvent(data);
  state.rxTracking.rxLogHandler = handler;
  state.connection.on(Constants.PushCodes.LogRxData, handler);
  state.rxTracking.isListening = true;
  
  debugLog(`[UNIFIED RX] ✅ Unified listening started successfully`);
}

/**
 * Stop unified RX listening
 */
function stopUnifiedRxListening() {
  if (!state.rxTracking.isListening) {
    return;
  }
  
  debugLog(`[UNIFIED RX] Stopping unified RX listening`);
  
  if (state.connection && state.rxTracking.rxLogHandler) {
    state.connection.off(Constants.PushCodes.LogRxData, state.rxTracking.rxLogHandler);
    debugLog(`[UNIFIED RX] Unregistered LogRxData event handler`);
  }
  
  state.rxTracking.isListening = false;
  state.rxTracking.isWardriving = false;  // Also disable wardriving
  state.rxTracking.rxLogHandler = null;
  
  debugLog(`[UNIFIED RX] ✅ Unified listening stopped`);
}



/**
 * Future: Post RX log data to MeshMapper API
 * @param {Array} entries - Array of RX log entries
 */
async function postRxLogToMeshMapperAPI(entries) {
  if (!MESHMAPPER_RX_LOG_API_URL) {
    debugLog('[RX LOG] RX Log API posting not configured yet');
    return;
  }
  
  // Future implementation:
  // - Batch post accumulated RX log entries
  // - Include session_id from state.wardriveSessionId
  // - Format: { observations: [{ repeaterId, snr, lat, lon, timestamp }] }
  debugLog(`[RX LOG] Would post ${entries.length} RX log entries to API (not implemented yet)`);
}

// ---- Passive RX Batch API Integration ----

/**
 * Handle passive RX event for API batching
 * Tracks best SNR observation per repeater with distance-based trigger
 * @param {string} repeaterId - Repeater ID (hex string)
 * @param {number} snr - Signal to noise ratio
 * @param {number} rssi - Received signal strength indicator
 * @param {number} pathLength - Number of hops in the path
 * @param {number} header - Packet header byte
 * @param {Object} currentLocation - Current GPS location {lat, lon}
 * @param {Object} metadata - Parsed metadata for debug mode
 */
function handleRxBatching(repeaterId, snr, rssi, pathLength, header, currentLocation, metadata) {
  // Get or create buffer entry for this repeater
  let buffer = state.rxBatchBuffer.get(repeaterId);
  
  if (!buffer) {
    // First time hearing this repeater - create new entry
    buffer = {
      firstLocation: { lat: currentLocation.lat, lng: currentLocation.lon },
      bestObservation: {
        snr,
        rssi,
        pathLength,
        header,
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        timestamp: Date.now(),
        metadata: metadata  // Store full metadata for debug mode
      }
    };
    state.rxBatchBuffer.set(repeaterId, buffer);
    debugLog(`[RX BATCH] First observation for repeater ${repeaterId}: SNR=${snr}`);
  } else {
    // Already tracking this repeater - check if new SNR is better
    if (snr > buffer.bestObservation.snr) {
      debugLog(`[RX BATCH] Better SNR for repeater ${repeaterId}: ${buffer.bestObservation.snr} -> ${snr}`);
      buffer.bestObservation = {
        snr,
        rssi,
        pathLength,
        header,
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        timestamp: Date.now(),
        metadata: metadata  // Store full metadata for debug mode
      };
    } else {
      debugLog(`[RX BATCH] Ignoring worse SNR for repeater ${repeaterId}: current=${buffer.bestObservation.snr}, new=${snr}`);
    }
  }
  
  // Check distance trigger (25m from firstLocation)
  const distance = calculateHaversineDistance(
    currentLocation.lat,
    currentLocation.lon,
    buffer.firstLocation.lat,
    buffer.firstLocation.lng
  );
  
  debugLog(`[RX BATCH] Distance check for repeater ${repeaterId}: ${distance.toFixed(2)}m from first observation (threshold=${RX_BATCH_DISTANCE_M}m)`);
  
  if (distance >= RX_BATCH_DISTANCE_M) {
    debugLog(`[RX BATCH] Distance threshold met for repeater ${repeaterId}, flushing`);
    flushRepeater(repeaterId);
  }
}

/**
 * Flush a single repeater's batch - post best observation to API
 * @param {string} repeaterId - Repeater ID to flush
 */
function flushRepeater(repeaterId) {
  debugLog(`[RX BATCH] Flushing repeater ${repeaterId}`);
  
  const buffer = state.rxBatchBuffer.get(repeaterId);
  if (!buffer) {
    debugLog(`[RX BATCH] No buffer to flush for repeater ${repeaterId}`);
    return;
  }
  
  const best = buffer.bestObservation;
  
  // Build API entry using BEST observation's location
  const entry = {
    repeater_id: repeaterId,
    location: { lat: best.lat, lng: best.lon },  // Location of BEST SNR packet
    snr: best.snr,
    rssi: best.rssi,
    pathLength: best.pathLength,
    header: best.header,
    timestamp: best.timestamp,
    metadata: best.metadata  // For debug mode
  };
  
  debugLog(`[RX BATCH] Posting repeater ${repeaterId}: snr=${best.snr}, location=${best.lat.toFixed(5)},${best.lon.toFixed(5)}`);
  
  // Queue for API posting
  queueRxApiPost(entry);
  
  // Remove from buffer
  state.rxBatchBuffer.delete(repeaterId);
  debugLog(`[RX BATCH] Repeater ${repeaterId} removed from buffer`);
}

/**
 * Flush all active batches (called on session end, disconnect, etc.)
 * @param {string} trigger - What caused the flush: 'session_end' | 'disconnect' | etc.
 */
function flushAllRxBatches(trigger = 'session_end') {
  debugLog(`[RX BATCH] Flushing all repeaters, trigger=${trigger}, active_repeaters=${state.rxBatchBuffer.size}`);
  
  if (state.rxBatchBuffer.size === 0) {
    debugLog(`[RX BATCH] No repeaters to flush`);
    return;
  }
  
  // Iterate all repeaters and flush each one
  const repeaterIds = Array.from(state.rxBatchBuffer.keys());
  for (const repeaterId of repeaterIds) {
    flushRepeater(repeaterId);
  }
  
  debugLog(`[RX BATCH] All repeaters flushed: ${repeaterIds.length} total`);
}

/**
 * Queue an entry for API posting
 * Uses the batch queue system to aggregate RX messages
 * @param {Object} entry - The entry to post (with best observation data)
 */
function queueRxApiPost(entry) {
  // Validate session_id exists
  if (!state.wardriveSessionId) {
    debugWarn(`[RX BATCH API] Cannot queue: no session_id available`);
    return;
  }
  
  // Format heard_repeats as "repeater_id(snr)" - e.g., "4e(12.0)"
  // Use absolute value and format with one decimal place
  const heardRepeats = `${entry.repeater_id}(${Math.abs(entry.snr).toFixed(1)})`;
  
  const payload = {
    key: MESHMAPPER_API_KEY,
    lat: entry.location.lat,
    lon: entry.location.lng,
    who: getDeviceIdentifier(),
    power: getCurrentPowerSetting(),
    heard_repeats: heardRepeats,
    ver: APP_VERSION,
    test: 0,
    iata: WARDIVE_IATA_CODE,
    session_id: state.wardriveSessionId
  };
  
  // Add debug data if debug mode is enabled
  if (state.debugMode && entry.metadata) {
    debugLog(`[RX BATCH API] 🐛 Debug mode active - adding debug_data for RX`);
    
    // For RX, parsed_heard is the LAST byte of path
    const lastHopId = entry.metadata.lastHop;
    const heardByte = lastHopId.toString(16).padStart(2, '0').toUpperCase();
    
    const debugData = buildDebugData(entry.metadata, heardByte, entry.repeater_id);
    payload.debug_data = debugData;
    
    debugLog(`[RX BATCH API] 🐛 RX payload includes debug_data for repeater ${entry.repeater_id}`);
  }
  
  // Queue message instead of posting immediately
  queueApiMessage(payload, "RX");
  debugLog(`[RX BATCH API] RX message queued: repeater=${entry.repeater_id}, snr=${entry.snr.toFixed(1)}, location=${entry.location.lat.toFixed(5)},${entry.location.lng.toFixed(5)}`);
}

// ---- Mobile Session Log Bottom Sheet ----

/**
 * Parse log entry string into structured data
 * @param {string} logLine - Log line in format "timestamp | lat,lon | events"
 * @returns {Object} Parsed log entry with timestamp, coords, and events
 */
function parseLogEntry(logLine) {
  const parts = logLine.split(' | ');
  if (parts.length !== 3) {
    return null;
  }
  
  const [timestamp, coords, eventsStr] = parts;
  const [lat, lon] = coords.split(',').map(s => s.trim());
  
  // Parse events: "4e(12),b7(0)" or "None"
  const events = [];
  if (eventsStr && eventsStr !== 'None' && eventsStr !== '...') {
    const eventTokens = eventsStr.split(',');
    for (const token of eventTokens) {
      const match = token.match(/^([a-f0-9]+)\(([^)]+)\)$/i);
      if (match) {
        events.push({
          type: match[1],
          value: parseFloat(match[2])
        });
      }
    }
  }
  
  return {
    timestamp,
    lat,
    lon,
    events
  };
}

/**
 * Get SNR severity class based on value
 * Red: -12 to -1
 * Orange: 0 to 5
 * Green: 6 to 13+
 * @param {number} snr - SNR value
 * @returns {string} CSS class name
 */
function getSnrSeverityClass(snr) {
  if (snr <= -1) {
    return 'snr-red';
  } else if (snr <= 5) {
    return 'snr-orange';
  } else {
    return 'snr-green';
  }
}

/**
 * Create chip element for a heard repeat
 * @param {string} type - Event type (repeater ID)
 * @param {number} value - SNR value
 * @returns {HTMLElement} Chip element
 */
function createChipElement(type, value) {
  const chip = document.createElement('span');
  chip.className = `chip ${getSnrSeverityClass(value)}`;
  
  const idSpan = document.createElement('span');
  idSpan.className = 'chipId';
  idSpan.textContent = type;
  
  const snrSpan = document.createElement('span');
  snrSpan.className = 'chipSnr';
  snrSpan.textContent = `${value.toFixed(2)} dB`;
  
  chip.appendChild(idSpan);
  chip.appendChild(snrSpan);
  
  return chip;
}

/**
 * Create log entry element for mobile view
 * @param {Object} entry - Parsed log entry
 * @returns {HTMLElement} Log entry element
 */
function createLogEntryElement(entry) {
  debugLog(`[UI] Creating log entry element for timestamp: ${entry.timestamp}`);
  const logEntry = document.createElement('div');
  logEntry.className = 'logEntry';
  
  // Top row: time + coords
  const topRow = document.createElement('div');
  topRow.className = 'logRowTop';
  
  const time = document.createElement('span');
  time.className = 'logTime';
  // Format timestamp to show only time (HH:MM:SS)
  const date = new Date(entry.timestamp);
  time.textContent = date.toLocaleTimeString();
  
  const coords = document.createElement('span');
  coords.className = 'logCoords';
  coords.textContent = `${entry.lat},${entry.lon}`;
  
  topRow.appendChild(time);
  topRow.appendChild(coords);
  
  // Chips row: heard repeats
  const chipsRow = document.createElement('div');
  chipsRow.className = 'heardChips';
  
  if (entry.events.length === 0) {
    const noneSpan = document.createElement('span');
    noneSpan.className = 'text-xs text-slate-500 italic';
    noneSpan.textContent = 'No repeats heard';
    chipsRow.appendChild(noneSpan);
    debugLog(`[UI] Log entry has no events (no repeats heard)`);
  } else {
    debugLog(`[UI] Log entry has ${entry.events.length} event(s)`);
    entry.events.forEach(event => {
      const chip = createChipElement(event.type, event.value);
      chipsRow.appendChild(chip);
      debugLog(`[UI] Added chip for repeater ${event.type} with SNR ${event.value} dB`);
    });
  }
  
  logEntry.appendChild(topRow);
  logEntry.appendChild(chipsRow);
  
  debugLog(`[UI] Log entry element created successfully with class: ${logEntry.className}`);
  return logEntry;
}

/**
 * Update summary bar with latest log data
 */
function updateTxLogSummary() {
  if (!txLogCount || !txLogLastTime || !txLogLastSnr) return;
  
  const count = txLogState.entries.length;
  txLogCount.textContent = count === 1 ? '1 ping' : `${count} pings`;
  
  if (count === 0) {
    txLogLastTime.textContent = 'No data';
    txLogLastSnr.textContent = '—';
    debugLog('[TX LOG] Session log summary updated: no entries');
    return;
  }
  
  const lastEntry = txLogState.entries[count - 1];
  const date = new Date(lastEntry.timestamp);
  txLogLastTime.textContent = date.toLocaleTimeString();
  
  // Count total heard repeats in the latest ping
  const heardCount = lastEntry.events.length;
  debugLog(`[TX LOG] Session log summary updated: ${count} total pings, latest ping heard ${heardCount} repeats`);
  
  if (heardCount > 0) {
    txLogLastSnr.textContent = heardCount === 1 ? '1 Repeat' : `${heardCount} Repeats`;
    txLogLastSnr.className = 'text-xs font-mono text-slate-300';
  } else {
    txLogLastSnr.textContent = '0 Repeats';
    txLogLastSnr.className = 'text-xs font-mono text-slate-500';
  }
}

/**
 * Render all log entries to the session log
 */
function renderTxLogEntries() {
  if (!txPingsEl) return;
  
  debugLog(`[UI] Rendering ${txLogState.entries.length} log entries`);
  txPingsEl.innerHTML = '';
  
  if (txLogState.entries.length === 0) {
    // Show placeholder when no entries
    const placeholder = document.createElement('div');
    placeholder.className = 'text-xs text-slate-500 italic text-center py-4';
    placeholder.textContent = 'No pings logged yet';
    txPingsEl.appendChild(placeholder);
    debugLog(`[UI] Rendered placeholder (no entries)`);
    return;
  }
  
  // Render newest first
  const entries = [...txLogState.entries].reverse();
  
  entries.forEach((entry, index) => {
    const element = createLogEntryElement(entry);
    txPingsEl.appendChild(element);
    debugLog(`[UI] Appended log entry ${index + 1}/${entries.length} to txPingsEl`);
  });
  
  // Auto-scroll to top (newest)
  if (txLogState.autoScroll && txLogScrollContainer) {
    txLogScrollContainer.scrollTop = 0;
    debugLog(`[UI] Auto-scrolled to top of log container`);
  }
  
  debugLog(`[UI] Finished rendering all log entries`);
}

/**
 * Toggle session log expanded/collapsed
 */
function toggleTxLogBottomSheet() {
  txLogState.isExpanded = !txLogState.isExpanded;
  
  if (txLogBottomSheet) {
    if (txLogState.isExpanded) {
      txLogBottomSheet.classList.add('open');
      txLogBottomSheet.classList.remove('hidden');
    } else {
      txLogBottomSheet.classList.remove('open');
      txLogBottomSheet.classList.add('hidden');
    }
  }
  
  // Toggle arrow rotation
  const logExpandArrow = document.getElementById('txLogExpandArrow');
  if (logExpandArrow) {
    if (txLogState.isExpanded) {
      logExpandArrow.classList.add('expanded');
    } else {
      logExpandArrow.classList.remove('expanded');
    }
  }
  
  // Toggle copy button and status visibility
  if (txLogState.isExpanded) {
    // Hide status elements, show copy button
    if (txLogLastSnr) txLogLastSnr.classList.add('hidden');
    if (txLogCopyBtn) txLogCopyBtn.classList.remove('hidden');
    debugLog('[TX LOG] Expanded - showing copy button, hiding status');
  } else {
    // Show status elements, hide copy button
    if (txLogLastSnr) txLogLastSnr.classList.remove('hidden');
    if (txLogCopyBtn) txLogCopyBtn.classList.add('hidden');
    debugLog('[TX LOG] Collapsed - hiding copy button, showing status');
  }
}

/**
 * Add entry to session log
 * @param {string} timestamp - ISO timestamp
 * @param {string} lat - Latitude
 * @param {string} lon - Longitude
 * @param {string} eventsStr - Events string (e.g., "4e(12),b7(0)" or "None")
 */
function addTxLogEntry(timestamp, lat, lon, eventsStr) {
  const logLine = `${timestamp} | ${lat},${lon} | ${eventsStr}`;
  const entry = parseLogEntry(logLine);
  
  if (entry) {
    txLogState.entries.push(entry);
    renderTxLogEntries();
    updateTxLogSummary();
  }
}

// ---- RX Log UI Functions ----

/**
 * Parse RX log entry into structured data
 * @param {Object} entry - RX log entry object
 * @returns {Object} Parsed RX log entry with formatted data
 */
function parseRxLogEntry(entry) {
  return {
    repeaterId: entry.repeaterId,
    snr: entry.snr,
    rssi: entry.rssi,
    pathLength: entry.pathLength,
    header: entry.header,
    lat: entry.lat.toFixed(5),
    lon: entry.lon.toFixed(5),
    timestamp: entry.timestamp
  };
}

/**
 * Create DOM element for RX log entry
 * @param {Object} entry - RX log entry object
 * @returns {HTMLElement} DOM element for the RX log entry
 */
function createRxLogEntryElement(entry) {
  const parsed = parseRxLogEntry(entry);
  
  const logEntry = document.createElement('div');
  logEntry.className = 'logEntry';
  
  // Top row: time + coords
  const topRow = document.createElement('div');
  topRow.className = 'logRowTop';
  
  const time = document.createElement('span');
  time.className = 'logTime';
  const date = new Date(parsed.timestamp);
  time.textContent = date.toLocaleTimeString();
  
  const coords = document.createElement('span');
  coords.className = 'logCoords';
  coords.textContent = `${parsed.lat},${parsed.lon}`;
  
  topRow.appendChild(time);
  topRow.appendChild(coords);
  
  // Chips row: repeater ID and SNR
  const chipsRow = document.createElement('div');
  chipsRow.className = 'heardChips';
  
  // Create chip for repeater with SNR
  const chip = createChipElement(parsed.repeaterId, parsed.snr);
  chipsRow.appendChild(chip);
  
  logEntry.appendChild(topRow);
  logEntry.appendChild(chipsRow);
  
  return logEntry;
}

/**
 * Update RX log summary bar with latest data
 */
function updateRxLogSummary() {
  if (!rxLogCount || !rxLogLastTime || !rxLogLastRepeater) return;
  
  const count = rxLogState.entries.length;
  rxLogCount.textContent = count === 1 ? '1 observation' : `${count} observations`;
  
  if (count === 0) {
    rxLogLastTime.textContent = 'No data';
    rxLogLastRepeater.textContent = '—';
    // Hide SNR chip when no entries
    if (rxLogSnrChip) {
      rxLogSnrChip.classList.add('hidden');
    }
    debugLog('[PASSIVE RX UI] Summary updated: no entries');
    return;
  }
  
  const lastEntry = rxLogState.entries[count - 1];
  const date = new Date(lastEntry.timestamp);
  rxLogLastTime.textContent = date.toLocaleTimeString();
  rxLogLastRepeater.textContent = lastEntry.repeaterId;
  
  // Update SNR chip
  if (rxLogSnrChip && rxLogState.entries.length > 0) {
    const snrClass = getSnrSeverityClass(lastEntry.snr);
    rxLogSnrChip.className = `chip-mini ${snrClass}`;
    rxLogSnrChip.textContent = `${lastEntry.snr.toFixed(2)} dB`;
    rxLogSnrChip.classList.remove('hidden');
    debugLog(`[PASSIVE RX UI] SNR chip updated: ${lastEntry.snr.toFixed(2)} dB (${snrClass})`);
  } else if (rxLogSnrChip) {
    rxLogSnrChip.classList.add('hidden');
  }
  
  debugLog(`[PASSIVE RX UI] Summary updated: ${count} observations, last repeater: ${lastEntry.repeaterId}`);
}

/**
 * Render all RX log entries
 */
/**
 * Render RX log entries (full render or incremental)
 * @param {boolean} fullRender - If true, re-render all entries. If false, only render new entries.
 */
function renderRxLogEntries(fullRender = false) {
  if (!rxLogEntries) return;
  
  if (fullRender) {
    debugLog(`[PASSIVE RX UI] Full render of ${rxLogState.entries.length} RX log entries`);
    rxLogEntries.innerHTML = '';
    
    if (rxLogState.entries.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.className = 'text-xs text-slate-500 italic text-center py-4';
      placeholder.textContent = 'No RX observations yet';
      rxLogEntries.appendChild(placeholder);
      debugLog(`[PASSIVE RX UI] Rendered placeholder (no entries)`);
      return;
    }
    
    // Render newest first
    const entries = [...rxLogState.entries].reverse();
    
    entries.forEach((entry, index) => {
      const element = createRxLogEntryElement(entry);
      rxLogEntries.appendChild(element);
    });
    
    debugLog(`[PASSIVE RX UI] Full render complete: ${entries.length} entries`);
  } else {
    // Incremental render: only add the newest entry
    if (rxLogState.entries.length === 0) {
      debugLog(`[PASSIVE RX UI] No entries to render incrementally`);
      return;
    }
    
    // Remove placeholder if it exists
    const placeholder = rxLogEntries.querySelector('.text-xs.text-slate-500.italic');
    if (placeholder) {
      placeholder.remove();
    }
    
    // Get the newest entry (last in array) and prepend it (newest first display)
    const newestEntry = rxLogState.entries[rxLogState.entries.length - 1];
    const element = createRxLogEntryElement(newestEntry);
    rxLogEntries.insertBefore(element, rxLogEntries.firstChild);
    
    debugLog(`[PASSIVE RX UI] Appended entry ${rxLogState.entries.length}/${rxLogState.entries.length}`);
  }
  
  // Auto-scroll to top (newest)
  if (rxLogState.autoScroll && rxLogScrollContainer) {
    rxLogScrollContainer.scrollTop = 0;
    debugLog(`[PASSIVE RX UI] Auto-scrolled to top`);
  }
}

/**
 * Toggle RX log expanded/collapsed
 */
function toggleRxLogBottomSheet() {
  rxLogState.isExpanded = !rxLogState.isExpanded;
  
  if (rxLogBottomSheet) {
    if (rxLogState.isExpanded) {
      rxLogBottomSheet.classList.add('open');
      rxLogBottomSheet.classList.remove('hidden');
    } else {
      rxLogBottomSheet.classList.remove('open');
      rxLogBottomSheet.classList.add('hidden');
    }
  }
  
  // Toggle arrow rotation
  if (rxLogExpandArrow) {
    if (rxLogState.isExpanded) {
      rxLogExpandArrow.classList.add('expanded');
    } else {
      rxLogExpandArrow.classList.remove('expanded');
    }
  }
  
  // Toggle copy button and status visibility
  if (rxLogState.isExpanded) {
    // Hide status, show copy button
    if (rxLogLastRepeater) rxLogLastRepeater.classList.add('hidden');
    if (rxLogSnrChip) rxLogSnrChip.classList.add('hidden');
    if (rxLogCopyBtn) rxLogCopyBtn.classList.remove('hidden');
    debugLog('[PASSIVE RX UI] Expanded - showing copy button, hiding status');
  } else {
    // Show status, hide copy button
    if (rxLogLastRepeater) rxLogLastRepeater.classList.remove('hidden');
    if (rxLogSnrChip && rxLogState.entries.length > 0) {
      rxLogSnrChip.classList.remove('hidden');
    }
    if (rxLogCopyBtn) rxLogCopyBtn.classList.add('hidden');
    debugLog('[PASSIVE RX UI] Collapsed - hiding copy button, showing status');
  }
}

/**
 * Add entry to RX log
 * @param {string} repeaterId - Repeater ID (hex)
 * @param {number} snr - Signal-to-noise ratio
 * @param {number} rssi - Received Signal Strength Indicator
 * @param {number} pathLength - Number of hops in packet path
 * @param {number} header - Packet header byte
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {string} timestamp - ISO timestamp
 */
function addRxLogEntry(repeaterId, snr, rssi, pathLength, header, lat, lon, timestamp) {
  const entry = {
    repeaterId,
    snr,
    rssi,
    pathLength,
    header,
    lat,
    lon,
    timestamp
  };
  
  rxLogState.entries.push(entry);
  
  // Apply max entries limit
  if (rxLogState.entries.length > rxLogState.maxEntries) {
    const removed = rxLogState.entries.shift();
    debugLog(`[PASSIVE RX UI] Max entries limit reached, removed oldest entry (repeater=${removed.repeaterId})`);
    // Need full re-render when removing old entries
    renderRxLogEntries(true);
  } else {
    // Incremental render - only append the new entry
    renderRxLogEntries(false);
  }
  
  updateRxLogSummary();
  
  debugLog(`[PASSIVE RX UI] Added entry: repeater=${repeaterId}, snr=${snr}, location=${lat.toFixed(5)},${lon.toFixed(5)}`);
}

// ---- Error Log ----

/**
 * Create DOM element for Error log entry
 * @param {Object} entry - Error log entry object
 * @returns {HTMLElement} DOM element for the error log entry
 */
function createErrorLogEntryElement(entry) {
  const logEntry = document.createElement('div');
  logEntry.className = 'logEntry';
  
  // Top row: time + error type/source
  const topRow = document.createElement('div');
  topRow.className = 'logRowTop';
  
  const time = document.createElement('span');
  time.className = 'logTime';
  const date = new Date(entry.timestamp);
  time.textContent = date.toLocaleTimeString();
  
  const source = document.createElement('span');
  source.className = 'text-xs font-mono text-red-400';
  source.textContent = entry.source || 'ERROR';
  
  topRow.appendChild(time);
  topRow.appendChild(source);
  
  // Message row
  const messageRow = document.createElement('div');
  messageRow.className = 'text-xs text-red-300 break-words mt-1';
  messageRow.textContent = entry.message;
  
  logEntry.appendChild(topRow);
  logEntry.appendChild(messageRow);
  
  return logEntry;
}

/**
 * Update error log summary bar
 */
function updateErrorLogSummary() {
  if (!errorLogCount || !errorLogLastTime) return;
  
  const count = errorLogState.entries.length;
  
  if (count === 0) {
    errorLogCount.textContent = '0 errors';
    errorLogLastTime.textContent = 'No errors';
    errorLogLastTime.classList.add('hidden');
    if (errorLogLastError) {
      errorLogLastError.textContent = '—';
    }
    debugLog('[ERROR LOG] Summary updated: no entries');
    return;
  }
  
  const lastEntry = errorLogState.entries[errorLogState.entries.length - 1];
  errorLogCount.textContent = `${count} error${count !== 1 ? 's' : ''}`;
  
  const date = new Date(lastEntry.timestamp);
  errorLogLastTime.textContent = date.toLocaleTimeString();
  errorLogLastTime.classList.remove('hidden');
  
  if (errorLogLastError) {
    // Show preview of error message
    const preview = lastEntry.message.length > errorLogState.previewLength 
      ? lastEntry.message.substring(0, errorLogState.previewLength) + '...' 
      : lastEntry.message;
    errorLogLastError.textContent = preview;
  }
  
  debugLog(`[ERROR LOG] Summary updated: ${count} errors, last: ${lastEntry.message.substring(0, 30)}...`);
}

/**
 * Render Error log entries (full render or incremental)
 * @param {boolean} fullRender - If true, re-render all entries. If false, only render new entries.
 */
function renderErrorLogEntries(fullRender = false) {
  if (!errorLogEntries) return;
  
  if (fullRender) {
    debugLog(`[ERROR LOG] Full render of ${errorLogState.entries.length} error log entries`);
    errorLogEntries.innerHTML = '';
    
    if (errorLogState.entries.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.className = 'text-xs text-slate-500 italic text-center py-4';
      placeholder.textContent = 'No errors logged';
      errorLogEntries.appendChild(placeholder);
      debugLog(`[ERROR LOG] Rendered placeholder (no entries)`);
      return;
    }
    
    // Render newest first
    const entries = [...errorLogState.entries].reverse();
    
    entries.forEach((entry, index) => {
      const element = createErrorLogEntryElement(entry);
      errorLogEntries.appendChild(element);
    });
    
    debugLog(`[ERROR LOG] Full render complete: ${entries.length} entries`);
  } else {
    // Incremental render: only add the newest entry
    if (errorLogState.entries.length === 0) {
      debugLog(`[ERROR LOG] No entries to render incrementally`);
      return;
    }
    
    // Remove placeholder if it exists
    const placeholder = errorLogEntries.querySelector('.text-xs.text-slate-500.italic');
    if (placeholder) {
      placeholder.remove();
    }
    
    // Get the newest entry (last in array) and prepend it (newest first display)
    const newestEntry = errorLogState.entries[errorLogState.entries.length - 1];
    const element = createErrorLogEntryElement(newestEntry);
    errorLogEntries.insertBefore(element, errorLogEntries.firstChild);
    
    debugLog(`[ERROR LOG] Appended entry ${errorLogState.entries.length}/${errorLogState.entries.length}`);
  }
  
  // Auto-scroll to top (newest)
  if (errorLogState.autoScroll && errorLogScrollContainer) {
    errorLogScrollContainer.scrollTop = 0;
    debugLog(`[ERROR LOG] Auto-scrolled to top`);
  }
}

/**
 * Toggle Error log expanded/collapsed
 */
function toggleErrorLogBottomSheet() {
  errorLogState.isExpanded = !errorLogState.isExpanded;
  
  if (errorLogBottomSheet) {
    if (errorLogState.isExpanded) {
      errorLogBottomSheet.classList.add('open');
      errorLogBottomSheet.classList.remove('hidden');
    } else {
      errorLogBottomSheet.classList.remove('open');
      errorLogBottomSheet.classList.add('hidden');
    }
  }
  
  // Toggle arrow rotation
  if (errorLogExpandArrow) {
    if (errorLogState.isExpanded) {
      errorLogExpandArrow.classList.add('expanded');
    } else {
      errorLogExpandArrow.classList.remove('expanded');
    }
  }
  
  // Toggle copy button and status visibility
  if (errorLogState.isExpanded) {
    // Hide status, show copy button
    if (errorLogLastError) errorLogLastError.classList.add('hidden');
    if (errorLogCopyBtn) errorLogCopyBtn.classList.remove('hidden');
    debugLog('[ERROR LOG] Expanded - showing copy button, hiding status');
  } else {
    // Show status, hide copy button
    if (errorLogLastError) errorLogLastError.classList.remove('hidden');
    if (errorLogCopyBtn) errorLogCopyBtn.classList.add('hidden');
    debugLog('[ERROR LOG] Collapsed - hiding copy button, showing status');
  }
}

/**
 * Add entry to Error log
 * @param {string} message - Error message
 * @param {string} source - Optional source/context of the error
 */
function addErrorLogEntry(message, source = null) {
  const entry = {
    message,
    source,
    timestamp: new Date().toISOString()
  };
  
  errorLogState.entries.push(entry);
  
  // Apply max entries limit
  if (errorLogState.entries.length > errorLogState.maxEntries) {
    const removed = errorLogState.entries.shift();
    debugLog(`[ERROR LOG] Max entries limit reached, removed oldest entry`);
    // Need full re-render when removing old entries
    renderErrorLogEntries(true);
  } else {
    // Incremental render - only append the new entry
    renderErrorLogEntries(false);
  }
  
  updateErrorLogSummary();
  
  debugLog(`[ERROR LOG] Added entry: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
}

// ---- CSV Export Functions ----

/**
 * Convert Session Log to CSV format
 * Columns: Timestamp,Latitude,Longitude,Repeater1_ID,Repeater1_SNR,Repeater2_ID,Repeater2_SNR,...
 * @returns {string} CSV formatted string
 */
function txLogToCSV() {
  debugLog('[TX LOG] Converting session log to CSV format');
  
  if (txLogState.entries.length === 0) {
    debugWarn('[TX LOG] No session log entries to export');
    return 'Timestamp,Latitude,Longitude,Repeats\n';
  }
  
  // Fixed 4-column header
  const header = 'Timestamp,Latitude,Longitude,Repeats\n';
  
  // Build CSV rows
  const rows = txLogState.entries.map(entry => {
    let row = `${entry.timestamp},${entry.lat},${entry.lon}`;
    
    // Combine all repeater data into single Repeats column
    // Format: repeaterID(snr)|repeaterID(snr)|...
    if (entry.events.length > 0) {
      const repeats = entry.events.map(event => {
        return `${event.type}(${event.value.toFixed(2)})`;
      }).join('|');
      row += `,${repeats}`;
    } else {
      row += ',';
    }
    
    return row;
  });
  
  const csv = header + rows.join('\n');
  debugLog(`[TX LOG] CSV export complete: ${txLogState.entries.length} entries`);
  return csv;
}

/**
 * Convert RX Log to CSV format
 * Columns: Timestamp,RepeaterID,SNR,RSSI,PathLength
 * @returns {string} CSV formatted string
 */
function rxLogToCSV() {
  debugLog('[PASSIVE RX UI] Converting RX log to CSV format');
  
  if (rxLogState.entries.length === 0) {
    debugWarn('[PASSIVE RX UI] No RX log entries to export');
    return 'Timestamp,RepeaterID,SNR,RSSI,PathLength\n';
  }
  
  const header = 'Timestamp,RepeaterID,SNR,RSSI,PathLength\n';
  
  const rows = rxLogState.entries.map(entry => {
    // Handle potentially missing fields from old entries
    const snr = entry.snr !== undefined ? entry.snr.toFixed(2) : '';
    const rssi = entry.rssi !== undefined ? entry.rssi : '';
    const pathLength = entry.pathLength !== undefined ? entry.pathLength : '';
    return `${entry.timestamp},${entry.repeaterId},${snr},${rssi},${pathLength}`;
  });
  
  const csv = header + rows.join('\n');
  debugLog(`[PASSIVE RX UI] CSV export complete: ${rxLogState.entries.length} entries`);
  return csv;
}

/**
 * Convert Error Log to CSV format
 * Columns: Timestamp,ErrorType,Message
 * @returns {string} CSV formatted string
 */
function errorLogToCSV() {
  debugLog('[ERROR LOG] Converting error log to CSV format');
  
  if (errorLogState.entries.length === 0) {
    debugWarn('[ERROR LOG] No error log entries to export');
    return 'Timestamp,ErrorType,Message\n';
  }
  
  const header = 'Timestamp,ErrorType,Message\n';
  
  const rows = errorLogState.entries.map(entry => {
    // Escape quotes in both source and message fields
    const source = (entry.source || 'ERROR').replace(/"/g, '""');
    const message = entry.message.replace(/"/g, '""');
    return `${entry.timestamp},"${source}","${message}"`;
  });
  
  const csv = header + rows.join('\n');
  debugLog(`[ERROR LOG] CSV export complete: ${errorLogState.entries.length} entries`);
  return csv;
}

/**
 * Copy log data to clipboard as CSV
 * @param {string} logType - Type of log: 'session', 'rx', or 'error'
 * @param {HTMLButtonElement} button - The button element that triggered the copy
 */
async function copyLogToCSV(logType, button) {
  try {
    debugLog(`[UI] Copy to CSV requested for ${logType} log`);
    
    let csv;
    let logTag;
    
    switch (logType) {
      case 'session':
        csv = txLogToCSV();
        logTag = '[TX LOG]';
        break;
      case 'rx':
        csv = rxLogToCSV();
        logTag = '[RX LOG UI]';
        break;
      case 'error':
        csv = errorLogToCSV();
        logTag = '[ERROR LOG]';
        break;
      default:
        debugError('[UI] Unknown log type for CSV export:', logType);
        return;
    }
    
    // Copy to clipboard
    await navigator.clipboard.writeText(csv);
    debugLog(`${logTag} CSV data copied to clipboard`);
    
    // Show feedback
    const originalText = button.textContent;
    button.textContent = 'Copied!';
    button.classList.add('copied');
    
    // Reset after 1.5 seconds
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
      debugLog(`${logTag} Copy button feedback reset`);
    }, 1500);
    
  } catch (error) {
    debugError(`[UI] Failed to copy ${logType} log to clipboard:`, error.message);
    // Show error feedback
    const originalText = button.textContent;
    button.textContent = 'Failed';
    setTimeout(() => {
      button.textContent = originalText;
    }, 1500);
  }
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
  debugLog(`[GPS] Fresh GPS acquired: lat=${coords.lat.toFixed(5)}, lon=${coords.lon.toFixed(5)}, accuracy=${coords.accuracy}m`);
  
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
      debugWarn("[TX/RX AUTO] Auto ping skipped: no GPS fix available yet");
      setDynamicStatus("Waiting for GPS fix", STATUS_COLORS.warning);
      return null;
    }
    
    // Check if GPS data is too old for auto ping
    const ageMs = Date.now() - state.lastFix.tsMs;
    const intervalMs = getSelectedIntervalMs();
    const maxAge = intervalMs + GPS_FRESHNESS_BUFFER_MS;
    
    if (ageMs >= maxAge) {
      debugLog(`[GPS] GPS data too old for auto ping (${ageMs}ms), attempting to refresh`);
      setDynamicStatus("GPS data too old, requesting fresh position", STATUS_COLORS.warning);
      
      try {
        return await acquireFreshGpsPosition();
      } catch (e) {
        debugError(`[GPS] Could not refresh GPS position for auto ping: ${e.message}`, e);
        // Set skip reason so the countdown will show the appropriate message
        state.skipReason = "gps too old";
        return null;
      }
    }
    
    debugLog(`[GPS] Using GPS watch data: lat=${state.lastFix.lat.toFixed(5)}, lon=${state.lastFix.lon.toFixed(5)} (age: ${ageMs}ms)`);
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
      debugLog(`[GPS] Using GPS watch data for manual ping (age: ${ageMs}ms, watch active)`);
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
        debugLog(`[GPS] Using cached GPS data (age: ${ageMs}ms, watch inactive)`);
        return {
          lat: state.lastFix.lat,
          lon: state.lastFix.lon,
          accuracy: state.lastFix.accM
        };
      }
    }
    
    // Data exists but is too old
    debugLog(`[GPS] GPS data too old (${ageMs}ms), requesting fresh position`);
    setDynamicStatus("GPS data too old, requesting fresh position", STATUS_COLORS.warning);
  }
  
  // Get fresh GPS coordinates for manual ping
  debugLog("[GPS] Requesting fresh GPS position for manual ping");
  try {
    return await acquireFreshGpsPosition();
  } catch (e) {
    debugError(`[GPS] Could not get fresh GPS location: ${e.message}`, e);
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
 * @returns {Object|null} The log entry object for later updates, or null
 */
function logTxPingToUI(payload, lat, lon) {
  // Use ISO format for data storage but user-friendly format for display
  const now = new Date();
  const isoStr = now.toISOString();
  
  if (lastPingEl) {
    lastPingEl.textContent = `${now.toLocaleString()} — ${payload}`;
  }

  // Create log entry with placeholder for repeater data
  const logData = {
    timestamp: isoStr,
    lat: lat.toFixed(5),
    lon: lon.toFixed(5),
    eventsStr: '...'
  };
  
  // Add to session log (this will handle both mobile and desktop)
  addTxLogEntry(logData.timestamp, logData.lat, logData.lon, logData.eventsStr);
  
  return logData;
}

/**
 * Update a ping log entry with repeater telemetry
 * @param {Object|null} logData - The log data object to update
 * @param {Array<{repeaterId: string, snr: number}>} repeaters - Array of repeater telemetry
 */
function updateTxLogWithRepeaters(logData, repeaters) {
  if (!logData) return;
  
  const repeaterStr = formatRepeaterTelemetry(repeaters);
  
  // Find and update the entry in txLogState
  const entryIndex = txLogState.entries.findIndex(
    e => e.timestamp === logData.timestamp && e.lat === logData.lat && e.lon === logData.lon
  );
  
  if (entryIndex !== -1) {
    // Update the entry
    const logLine = `${logData.timestamp} | ${logData.lat},${logData.lon} | ${repeaterStr}`;
    const updatedEntry = parseLogEntry(logLine);
    
    if (updatedEntry) {
      txLogState.entries[entryIndex] = updatedEntry;
      renderTxLogEntries();
      updateTxLogSummary();
    }
  }
  
  debugLog(`[PING] Updated ping log entry with repeater telemetry: ${repeaterStr}`);
}

/**
 * Incrementally update the current ping log entry as repeaters are detected
 * This provides real-time updates during the RX listening window
 */
function updateCurrentTxLogEntryWithLiveRepeaters() {
  // Only update if we're actively listening and have a current log entry
  if (!state.txTracking.isListening || !state.txTracking.currentLogEntry) {
    return;
  }
  
  const logData = state.txTracking.currentLogEntry;
  
  // Convert current repeaters Map to array format
  const repeaters = Array.from(state.txTracking.repeaters.entries()).map(([id, data]) => ({
    repeaterId: id,
    snr: data.snr
  }));
  
  // Sort by repeater ID for deterministic output
  repeaters.sort((a, b) => a.repeaterId.localeCompare(b.repeaterId));
  
  // Reuse the existing updateTxLogWithRepeaters function
  updateTxLogWithRepeaters(logData, repeaters);
  
  debugLog(`[PING] Incrementally updated ping log entry: ${repeaters.length} repeater(s) detected so far`);
}

/**
 * Send a wardrive ping with current GPS coordinates
 * @param {boolean} manual - Whether this is a manual ping (true) or auto ping (false)
 */
async function sendPing(manual = false) {
  debugLog(`[PING] sendPing called (manual=${manual})`);
  try {
    // Check cooldown only for manual pings
    if (manual && isInCooldown()) {
      const remainingSec = getRemainingCooldownSeconds();
      debugLog(`[PING] Manual ping blocked by cooldown (${remainingSec}s remaining)`);
      setDynamicStatus(`Wait ${remainingSec}s before sending another ping`, STATUS_COLORS.warning);
      return;
    }

    // Handle countdown timers based on ping type
    if (manual && state.txRxAutoRunning) {
      // Manual ping during auto mode: pause the auto countdown
      debugLog("[PING] Manual ping during auto mode - pausing auto countdown");
      pauseAutoCountdown();
      setDynamicStatus("Sending manual ping", STATUS_COLORS.info);
    } else if (!manual && state.txRxAutoRunning) {
      // Auto ping: stop the countdown timer to avoid status conflicts
      stopAutoCountdown();
      setDynamicStatus("Sending auto ping", STATUS_COLORS.info);
    } else if (manual) {
      // Manual ping when auto is not running
      setDynamicStatus("Sending manual ping", STATUS_COLORS.info);
    }

    // Get GPS coordinates
    const coords = await getGpsCoordinatesForPing(!manual && state.txRxAutoRunning);
    if (!coords) {
      // GPS not available, message already shown
      // For auto mode, schedule next attempt
      if (!manual && state.txRxAutoRunning) {
        scheduleNextAutoPing();
      }
      // For manual ping during auto mode, resume the paused countdown
      if (manual) {
        handleManualPingBlockedDuringAutoMode();
      }
      return;
    }
    
    const { lat, lon, accuracy } = coords;

    // VALIDATION 1: Geofence check (FIRST - must be within Ottawa 150km)
    debugLog("[PING] Starting geofence validation");
    if (!validateGeofence(lat, lon)) {
      debugLog("[PING] Ping blocked: outside geofence");
      
      // Set skip reason for auto mode countdown display
      state.skipReason = "outside geofence";
      
      if (manual) {
        // Manual ping: show skip message that persists
        setDynamicStatus("Ping skipped, outside of geofenced region", STATUS_COLORS.warning);
        // If auto mode is running, resume the paused countdown
        handleManualPingBlockedDuringAutoMode();
      } else if (state.txRxAutoRunning) {
        // Auto ping: schedule next ping and show countdown with skip message
        scheduleNextAutoPing();
      }
      
      return;
    }
    debugLog("[PING] Geofence validation passed");

    // VALIDATION 2: Distance check (SECOND - must be ≥ 25m from last successful ping)
    debugLog("[PING] Starting distance validation");
    if (!validateMinimumDistance(lat, lon)) {
      debugLog("[PING] Ping blocked: too close to last ping");
      
      // Set skip reason for auto mode countdown display
      state.skipReason = "too close";
      
      if (manual) {
        // Manual ping: show skip message that persists
        setDynamicStatus("Ping skipped, too close to last ping", STATUS_COLORS.warning);
        // If auto mode is running, resume the paused countdown
        handleManualPingBlockedDuringAutoMode();
      } else if (state.txRxAutoRunning) {
        // Auto ping: schedule next ping and show countdown with skip message
        scheduleNextAutoPing();
      }
      
      return;
    }
    debugLog("[PING] Distance validation passed");

    // Both validations passed - execute ping operation (Mesh + API)
    debugLog("[PING] All validations passed, executing ping operation");
    
    // Lock ping controls for the entire ping lifecycle (until API post completes)
    state.pingInProgress = true;
    updateControlsForCooldown();
    debugLog("[PING] Ping controls locked (pingInProgress=true)");
    
    const payload = buildPayload(lat, lon);
    debugLog(`[PING] Sending ping to channel: "${payload}"`);

    const ch = await ensureChannel();
    
    // Capture GPS coordinates at ping time - these will be used for API post after 10s delay
    state.capturedPingCoords = { lat, lon, accuracy };
    debugLog(`[PING] GPS coordinates captured at ping time: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, accuracy=${accuracy}m`);
    
    // Start repeater echo tracking BEFORE sending the ping
    debugLog(`[PING] Channel ping transmission: timestamp=${new Date().toISOString()}, channel=${ch.channelIdx}, payload="${payload}"`);
    startTxTracking(payload, ch.channelIdx);
    
    await state.connection.sendChannelTextMessage(ch.channelIdx, payload);
    debugLog(`[PING] Ping sent successfully to channel ${ch.channelIdx}`);

    // Ping operation succeeded - update last successful ping location
    state.lastSuccessfulPingLocation = { lat, lon };
    debugLog(`[PING] Updated last successful ping location: (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
    
    // Clear skip reason on successful ping
    state.skipReason = null;

    // Start cooldown period after successful ping
    debugLog(`[PING] Starting ${COOLDOWN_MS}ms cooldown`);
    startCooldown();

    // Update status after ping is sent
    setDynamicStatus("Ping sent", STATUS_COLORS.success);
    
    // Create UI log entry with placeholder for repeater data
    const logEntry = logTxPingToUI(payload, lat, lon);
    
    // Store log entry in repeater tracking state for incremental updates
    state.txTracking.currentLogEntry = logEntry;
    
    // Start RX listening countdown
    // The minimum 500ms visibility of "Ping sent" is enforced by setStatus()
    if (state.connection) {
      debugLog(`[PING] Starting RX listening window for ${RX_LOG_LISTEN_WINDOW_MS}ms`);
      startRxListeningCountdown(RX_LOG_LISTEN_WINDOW_MS);
    }
    
    // Schedule the sequence: listen for 10s, THEN finalize repeats and background the API post
    // This timeout is stored in meshMapperTimer for cleanup purposes
    // Capture coordinates locally to prevent race conditions with concurrent pings
    const capturedCoords = state.capturedPingCoords;
    state.meshMapperTimer = setTimeout(async () => {
      debugLog(`[PING] RX listening window completed after ${RX_LOG_LISTEN_WINDOW_MS}ms`);
      
      // Stop listening countdown
      stopRxListeningCountdown();
      
      // Stop repeater tracking and get final results
      const repeaters = stopTxTracking();
      debugLog(`[PING] Finalized heard repeats: ${repeaters.length} unique paths detected`);
      
      // Update UI log with repeater data
      updateTxLogWithRepeaters(logEntry, repeaters);
      
      // Format repeater data for API
      const heardRepeatsStr = formatRepeaterTelemetry(repeaters);
      debugLog(`[PING] Formatted heard_repeats for API: "${heardRepeatsStr}"`);
      
      // Store repeater data temporarily for debug mode
      if (state.debugMode) {
        state.tempTxRepeaterData = repeaters;
        debugLog(`[PING] 🐛 Stored ${repeaters.length} repeater(s) data for debug mode`);
      }
      
      // Update status and start next timer IMMEDIATELY (before API post)
      // This is the key change: we don't wait for API to complete
      if (state.connection) {
        if (state.txRxAutoRunning) {
          // Check if we should resume a paused auto countdown (manual ping during auto mode)
          const resumed = resumeAutoCountdown();
          if (!resumed) {
            // No paused timer to resume, schedule new auto ping (this was an auto ping)
            debugLog("[TX/RX AUTO] Scheduling next auto ping immediately after RX window");
            scheduleNextAutoPing();
          } else {
            debugLog("[TX/RX AUTO] Resumed auto countdown after manual ping");
          }
        } else {
          debugLog("[UI] Setting dynamic status to Idle (manual mode)");
          setDynamicStatus("Idle");
        }
      }
      
      // Unlock ping controls immediately (don't wait for API)
      unlockPingControls("after RX listening window completion");
      
      // Background the API posting (runs asynchronously, doesn't block)
      // Use captured coordinates for API post (not current GPS position)
      if (capturedCoords) {
        const { lat: apiLat, lon: apiLon, accuracy: apiAccuracy } = capturedCoords;
        debugLog(`[API QUEUE] Backgrounding API post for coordinates: lat=${apiLat.toFixed(5)}, lon=${apiLon.toFixed(5)}, accuracy=${apiAccuracy}m`);
        
        // Post to API in background (async, fire-and-forget with error handling)
        postApiInBackground(apiLat, apiLon, apiAccuracy, heardRepeatsStr).catch(error => {
          debugError(`[API QUEUE] Background API post failed: ${error.message}`, error);
          // Show error to user only if API fails
          setDynamicStatus("Error: API post failed", STATUS_COLORS.error);
        });
      } else {
        // This should never happen as coordinates are always captured before ping
        debugError(`[API QUEUE] CRITICAL: No captured ping coordinates available for API post - this indicates a logic error`);
        debugError(`[API QUEUE] Skipping API post to avoid posting incorrect coordinates`);
      }
      
      // Clear timer reference
      state.meshMapperTimer = null;
    }, RX_LOG_LISTEN_WINDOW_MS);
    
    // Update distance display immediately after successful ping
    updateDistanceUi();
  } catch (e) {
    debugError(`[PING] Ping operation failed: ${e.message}`, e);
    setDynamicStatus(e.message || "Ping failed", STATUS_COLORS.error);
    
    // Unlock ping controls on error
    unlockPingControls("after error");
  }
}

// ---- Auto mode ----
function stopAutoPing(stopGps = false) {
  debugLog(`[TX/RX AUTO] stopAutoPing called (stopGps=${stopGps})`);
  // Check if we're in cooldown before stopping (unless stopGps is true for disconnect)
  if (!stopGps && isInCooldown()) {
    const remainingSec = getRemainingCooldownSeconds();
    debugLog(`[TX/RX AUTO] Auto ping stop blocked by cooldown (${remainingSec}s remaining)`);
    setDynamicStatus(`Wait ${remainingSec}s before toggling TX/RX Auto`, STATUS_COLORS.warning);
    return;
  }
  
  if (state.autoTimerId) {
    debugLog("[TX/RX AUTO] Clearing auto ping timer");
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Clear skip reason and paused timer state
  state.skipReason = null;
  state.pausedAutoTimerRemainingMs = null;
  
  // DISABLE RX wardriving
  state.rxTracking.isWardriving = false;
  debugLog("[TX/RX AUTO] RX wardriving disabled");
  
  // DO NOT stop unified listener (stays on)
  // REMOVED: stopUnifiedRxListening();
  
  // Only stop GPS watch when disconnecting or page hidden, not during normal stop
  if (stopGps) {
    stopGeoWatch();
  }
  
  state.txRxAutoRunning = false;
  updateAutoButton();
  updateControlsForCooldown();  // Re-enable RX Auto button
  releaseWakeLock();
  debugLog("[TX/RX AUTO] TX/RX Auto stopped");
}

/**
 * Start RX Auto mode (passive-only wardriving)
 */
function startRxAuto() {
  debugLog("[RX AUTO] Starting RX Auto mode");
  
  if (!state.connection) {
    debugError("[RX AUTO] Cannot start - not connected");
    alert("Connect to a MeshCore device first.");
    return;
  }
  
  // Defensive check: ensure unified listener is running
  if (state.connection && !state.rxTracking.isListening) {
    debugWarn("[RX AUTO] Unified listener not active - restarting");
    startUnifiedRxListening();
  }
  
  // ENABLE RX wardriving
  state.rxTracking.isWardriving = true;
  debugLog("[RX AUTO] RX wardriving enabled");
  
  // Set RX Auto mode flag
  state.rxAutoRunning = true;
  updateAutoButton();
  updateControlsForCooldown();  // Disable TX/RX Auto button
  
  // Acquire wake lock
  debugLog("[RX AUTO] Acquiring wake lock");
  acquireWakeLock().catch(console.error);
  
  setDynamicStatus("RX Auto started", STATUS_COLORS.success);
  debugLog("[RX AUTO] RX Auto mode started successfully");
}

/**
 * Stop RX Auto mode
 */
function stopRxAuto() {
  debugLog("[RX AUTO] Stopping RX Auto mode");
  
  if (!state.rxAutoRunning) {
    debugLog("[RX AUTO] RX Auto not running, nothing to stop");
    return;
  }
  
  // DISABLE RX wardriving
  state.rxTracking.isWardriving = false;
  debugLog("[RX AUTO] RX wardriving disabled");
  
  // DO NOT stop unified listener (stays on)
  // REMOVED: stopUnifiedRxListening();
  
  // Clear RX Auto mode flag
  state.rxAutoRunning = false;
  updateAutoButton();
  updateControlsForCooldown();  // Re-enable TX/RX Auto button
  releaseWakeLock();
  
  setDynamicStatus("RX Auto stopped", STATUS_COLORS.idle);
  debugLog("[RX AUTO] RX Auto mode stopped");
}

function scheduleNextAutoPing() {
  if (!state.txRxAutoRunning) {
    debugLog("[TX/RX AUTO] Not scheduling next auto ping - auto mode not running");
    return;
  }
  
  const intervalMs = getSelectedIntervalMs();
  debugLog(`[TX/RX AUTO] Scheduling next auto ping in ${intervalMs}ms`);
  
  // Start countdown immediately (skipReason may be set if ping was skipped)
  startAutoCountdown(intervalMs);
  
  // Schedule the next ping
  state.autoTimerId = setTimeout(() => {
    if (state.txRxAutoRunning) {
      // Clear skip reason before next attempt
      state.skipReason = null;
      debugLog("[TX/RX AUTO] Auto ping timer fired, sending ping");
      sendPing(false).catch(console.error);
    }
  }, intervalMs);
}

function startAutoPing() {
  debugLog("[TX/RX AUTO] startAutoPing called");
  if (!state.connection) {
    debugError("[TX/RX AUTO] Cannot start auto ping - not connected");
    alert("Connect to a MeshCore device first.");
    return;
  }
  
  // Check if we're in cooldown
  if (isInCooldown()) {
    const remainingSec = getRemainingCooldownSeconds();
    debugLog(`[TX/RX AUTO] Auto ping start blocked by cooldown (${remainingSec}s remaining)`);
    setDynamicStatus(`Wait ${remainingSec}s before toggling auto mode`, STATUS_COLORS.warning);
    return;
  }
  
  // Clean up any existing auto-ping timer (but keep GPS watch running)
  if (state.autoTimerId) {
    debugLog("[TX/RX AUTO] Clearing existing auto ping timer");
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Clear any previous skip reason
  state.skipReason = null;
  
  // Defensive check: ensure unified listener is running
  if (state.connection && !state.rxTracking.isListening) {
    debugWarn("[TX/RX AUTO] Unified listener not active - restarting");
    startUnifiedRxListening();
  }
  
  // ENABLE RX wardriving
  state.rxTracking.isWardriving = true;
  debugLog("[TX/RX AUTO] RX wardriving enabled");
  
  // Start GPS watch for continuous updates
  debugLog("[TX/RX AUTO] Starting GPS watch for auto mode");
  startGeoWatch();
  
  state.txRxAutoRunning = true;
  updateAutoButton();
  updateControlsForCooldown();  // Disable RX Auto button

  // Acquire wake lock for auto mode
  debugLog("[TX/RX AUTO] Acquiring wake lock for auto mode");
  acquireWakeLock().catch(console.error);

  // Send first ping immediately
  debugLog("[TX/RX AUTO] Sending initial auto ping");
  sendPing(false).catch(console.error);
}

// ---- BLE connect / disconnect ----
async function connect() {
  debugLog("[BLE] connect() called");
  if (!("bluetooth" in navigator)) {
    debugError("[BLE] Web Bluetooth not supported");
    alert("Web Bluetooth not supported in this browser.");
    return;
  }
  connectBtn.disabled = true;
  
  // Set connection bar to "Connecting" - will remain until GPS init completes
  setConnStatus("Connecting", STATUS_COLORS.info);
  setDynamicStatus("Idle"); // Clear dynamic status

  try {
    debugLog("[BLE] Opening BLE connection...");
    setDynamicStatus("BLE Connection Started", STATUS_COLORS.info); // Show BLE connection start
    const conn = await WebBleConnection.open();
    state.connection = conn;
    debugLog("[BLE] BLE connection object created");

    conn.on("connected", async () => {
      debugLog("[BLE] BLE connected event fired");
      // Keep "Connecting" status visible during the full connection process
      // Don't show "Connected" until everything is complete
      setConnectButton(true);
      connectBtn.disabled = false;
      const selfInfo = await conn.getSelfInfo();
      debugLog(`[BLE] Device info: ${selfInfo?.name || "[No device]"}`);
      
      // Validate and store public key
      if (!selfInfo?.publicKey || selfInfo.publicKey.length !== 32) {
        debugError("[BLE] Missing or invalid public key from device", selfInfo?.publicKey);
        state.disconnectReason = "public_key_error"; // Mark specific disconnect reason
        // Disconnect after a brief delay to ensure "Acquiring wardriving slot" status is visible
        // before the disconnect sequence begins with "Disconnecting"
        setTimeout(() => {
          disconnect().catch(err => debugError(`[BLE] Disconnect after public key error failed: ${err.message}`));
        }, 1500);
        return;
      }
      
      // Convert public key to hex and store
      state.devicePublicKey = BufferUtils.bytesToHex(selfInfo.publicKey);
      debugLog(`[BLE] Device public key stored: ${state.devicePublicKey.substring(0, 16)}...`);
      
      deviceInfoEl.textContent = selfInfo?.name || "[No device]";
      updateAutoButton();
      try { 
        await conn.syncDeviceTime?.(); 
        debugLog("[BLE] Device time synced");
      } catch { 
        debugLog("[BLE] Device time sync not available or failed");
      }
      try {
        // Check capacity immediately after time sync, before channel setup and GPS init
        const allowed = await checkCapacity("connect");
        if (!allowed) {
          debugWarn("[CAPACITY] Capacity check denied, disconnecting");
          // disconnectReason already set by checkCapacity()
          // Status message will be set by disconnected event handler based on disconnectReason
          // Disconnect after a brief delay to ensure "Acquiring wardriving slot" is visible
          setTimeout(() => {
            disconnect().catch(err => debugError(`[BLE] Disconnect after capacity denial failed: ${err.message}`));
          }, 1500);
          return;
        }
        
        // Capacity check passed
        setDynamicStatus("Acquired wardriving slot", STATUS_COLORS.success);
        debugLog("[BLE] Wardriving slot acquired successfully");
        
        // Proceed with channel setup and GPS initialization
        await ensureChannel();
        
        // Start unified RX listening after channel setup
        startUnifiedRxListening();
        debugLog("[BLE] Unified RX listener started on connect");
        
        // CLEAR all logs on connect (new session)
        txLogState.entries = [];
        renderTxLogEntries(true);
        updateTxLogSummary();
        
        rxLogState.entries = [];
        renderRxLogEntries(true);
        updateRxLogSummary();
        
        errorLogState.entries = [];
        renderErrorLogEntries(true);
        updateErrorLogSummary();
        
        debugLog("[BLE] All logs cleared on connect (new session)");
        
        // GPS initialization
        setDynamicStatus("Priming GPS", STATUS_COLORS.info);
        debugLog("[BLE] Starting GPS initialization");
        await primeGpsOnce();
        
        // Connection complete, show Connected status in connection bar
        setConnStatus("Connected", STATUS_COLORS.success);
        setDynamicStatus("Idle"); // Clear dynamic status to em dash
        debugLog("[BLE] Full connection process completed successfully");
      } catch (e) {
        debugError(`[CHANNEL] Channel setup failed: ${e.message}`, e);
        state.disconnectReason = "channel_setup_error"; // Mark specific disconnect reason
        state.channelSetupErrorMessage = e.message || "Channel setup failed"; // Store error message
      }
    });

    conn.on("disconnected", () => {
      debugLog("[BLE] BLE disconnected event fired");
      debugLog(`[BLE] Disconnect reason: ${state.disconnectReason}`);
      
      // Always set connection bar to "Disconnected"
      setConnStatus("Disconnected", STATUS_COLORS.error);
      
      // Set dynamic status based on disconnect reason (WITHOUT "Disconnected:" prefix)
      // First check if reason has a mapped message in REASON_MESSAGES (for API reason codes)
      if (state.disconnectReason && REASON_MESSAGES[state.disconnectReason]) {
        debugLog(`[BLE] Branch: known reason code (${state.disconnectReason})`);
        const errorMsg = REASON_MESSAGES[state.disconnectReason];
        setDynamicStatus(errorMsg, STATUS_COLORS.error, true);
        debugLog(`[BLE] Setting terminal status for reason: ${state.disconnectReason}`);
      } else if (state.disconnectReason === "capacity_full") {
        debugLog("[BLE] Branch: capacity_full");
        setDynamicStatus("MeshMapper at capacity", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for capacity full");
      } else if (state.disconnectReason === "app_down") {
        debugLog("[BLE] Branch: app_down");
        setDynamicStatus("MeshMapper unavailable", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for app down");
      } else if (state.disconnectReason === "slot_revoked") {
        debugLog("[BLE] Branch: slot_revoked");
        setDynamicStatus("MeshMapper slot revoked", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for slot revocation");
      } else if (state.disconnectReason === "session_id_error") {
        debugLog("[BLE] Branch: session_id_error");
        setDynamicStatus("Session error - reconnect", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for session_id error");
      } else if (state.disconnectReason === "public_key_error") {
        debugLog("[BLE] Branch: public_key_error");
        setDynamicStatus("Device key error - reconnect", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for public key error");
      } else if (state.disconnectReason === "channel_setup_error") {
        debugLog("[BLE] Branch: channel_setup_error");
        const errorMsg = state.channelSetupErrorMessage || "Channel setup failed";
        setDynamicStatus(errorMsg, STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for channel setup error");
        state.channelSetupErrorMessage = null; // Clear after use (also cleared in cleanup as safety net)
      } else if (state.disconnectReason === "ble_disconnect_error") {
        debugLog("[BLE] Branch: ble_disconnect_error");
        const errorMsg = state.bleDisconnectErrorMessage || "BLE disconnect failed";
        setDynamicStatus(errorMsg, STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for BLE disconnect error");
        state.bleDisconnectErrorMessage = null; // Clear after use (also cleared in cleanup as safety net)
      } else if (state.disconnectReason === "normal" || state.disconnectReason === null || state.disconnectReason === undefined) {
        debugLog("[BLE] Branch: normal/null/undefined");
        setDynamicStatus("Idle"); // Show em dash for normal disconnect
      } else {
        debugLog(`[BLE] Branch: else (unknown reason: ${state.disconnectReason})`);
        // For unknown disconnect reasons from API, show a generic message
        debugLog(`[BLE] Showing generic error for unknown reason: ${state.disconnectReason}`);
        setDynamicStatus(`Connection not allowed: ${state.disconnectReason}`, STATUS_COLORS.error, true);
      }
      
      setConnectButton(false);
      deviceInfoEl.textContent = "—";
      state.connection = null;
      state.channel = null;
      state.devicePublicKey = null; // Clear public key
      state.wardriveSessionId = null; // Clear wardrive session ID
      state.debugMode = false; // Clear debug mode
      state.tempTxRepeaterData = null; // Clear temp TX data
      state.disconnectReason = null; // Reset disconnect reason
      state.channelSetupErrorMessage = null; // Clear error message
      state.bleDisconnectErrorMessage = null; // Clear error message
      
      // Stop auto modes
      stopAutoPing(true); // Ignore cooldown check on disconnect, stop GPS
      stopRxAuto();  // Stop RX Auto mode
      
      enableControls(false);
      updateAutoButton();
      stopGeoWatch();
      stopGpsAgeUpdater(); // Ensure age updater stops
      stopTxTracking(); // Stop TX echo tracking
      
      // Stop unified RX listening on disconnect
      stopUnifiedRxListening();
      debugLog("[BLE] Unified RX listener stopped on disconnect");
      
      // Flush all pending RX batch data before cleanup
      flushAllRxBatches('disconnect');
      
      // Clear API queue messages (timers already stopped in cleanupAllTimers)
      apiQueue.messages = [];
      debugLog(`[API QUEUE] Queue cleared on disconnect`);
      
      // Clean up all timers
      cleanupAllTimers();
      
      // Clear RX log entries on disconnect
      rxLogState.entries = [];
      renderRxLogEntries(true); // Full render to show placeholder
      updateRxLogSummary();
      debugLog("[BLE] RX log cleared on disconnect");
      
      state.lastFix = null;
      state.lastSuccessfulPingLocation = null;
      state.gpsState = "idle";
      updateGpsUi();
      updateDistanceUi();
      debugLog("[BLE] Disconnect cleanup complete");
    });

  } catch (e) {
    debugError(`[BLE] BLE connection failed: ${e.message}`, e);
    setConnStatus("Disconnected", STATUS_COLORS.error);
    setDynamicStatus("Connection failed", STATUS_COLORS.error);
    connectBtn.disabled = false;
  }
}
async function disconnect() {
  debugLog("[BLE] disconnect() called");
  if (!state.connection) {
    debugLog("[BLE] No connection to disconnect");
    return;
  }

  connectBtn.disabled = true;
  
  // Set disconnectReason to "normal" if not already set (for user-initiated disconnects)
  if (state.disconnectReason === null || state.disconnectReason === undefined) {
    state.disconnectReason = "normal";
  }
  
  // Set connection bar to "Disconnecting" - will remain until cleanup completes
  setConnStatus("Disconnecting", STATUS_COLORS.info);
  setDynamicStatus("Idle"); // Clear dynamic status

  // 1. CRITICAL: Flush API queue FIRST (session_id still valid)
  if (apiQueue.messages.length > 0) {
    debugLog(`[BLE] Flushing ${apiQueue.messages.length} queued messages before disconnect`);
    await flushApiQueue();
  }
  stopFlushTimers();

  // 2. THEN release capacity slot if we have a public key
  if (state.devicePublicKey) {
    try {
      debugLog("[BLE] Releasing capacity slot");
      await checkCapacity("disconnect");
    } catch (e) {
      debugWarn(`[CAPACITY] Failed to release capacity slot: ${e.message}`);
      // Don't fail disconnect if capacity release fails
    }
  }

  // 3. Delete the wardriving channel before disconnecting
  try {
    if (state.channel && typeof state.connection.deleteChannel === "function") {
      debugLog(`[BLE] Deleting channel ${CHANNEL_NAME} at index ${state.channel.channelIdx}`);
      await state.connection.deleteChannel(state.channel.channelIdx);
      debugLog(`[BLE] Channel ${CHANNEL_NAME} deleted successfully`);
    }
  } catch (e) {
    debugWarn(`[CHANNEL] Failed to delete channel ${CHANNEL_NAME}: ${e.message}`);
    // Don't fail disconnect if channel deletion fails
  }

  // 4. Close BLE connection
  try {
    // WebBleConnection typically exposes one of these.
    if (typeof state.connection.close === "function") {
      debugLog("[BLE] Calling connection.close()");
      await state.connection.close();
    } else if (typeof state.connection.disconnect === "function") {
      debugLog("[BLE] Calling connection.disconnect()");
      await state.connection.disconnect();
    } else if (typeof state.connection.device?.gatt?.disconnect === "function") {
      debugLog("[BLE] Calling device.gatt.disconnect()");
      state.connection.device.gatt.disconnect();
    } else {
      debugWarn("[BLE] No known disconnect method on connection object");
    }
  } catch (e) {
    debugError(`[BLE] BLE disconnect failed: ${e.message}`, e);
    state.disconnectReason = "ble_disconnect_error"; // Mark specific disconnect reason
    state.bleDisconnectErrorMessage = e.message || "Disconnect failed"; // Store error message
  } finally {
    connectBtn.disabled = false;
  }
}


// ---- Page visibility ----
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    debugLog("[UI] Page visibility changed to hidden");
    
    // Stop TX/RX Auto if running
    if (state.txRxAutoRunning) {
      debugLog("[UI] Stopping TX/RX Auto due to page hidden");
      stopAutoPing(true); // Ignore cooldown, stop GPS
      setDynamicStatus("Lost focus, TX/RX Auto stopped", STATUS_COLORS.warning);
    }
    
    // Stop RX Auto if running
    if (state.rxAutoRunning) {
      debugLog("[UI] Stopping RX Auto due to page hidden");
      stopRxAuto();
      setDynamicStatus("Lost focus, RX Auto stopped", STATUS_COLORS.warning);
    }
    
    // Release wake lock if neither mode running
    if (!state.txRxAutoRunning && !state.rxAutoRunning) {
      debugLog("[UI] Releasing wake lock due to page hidden");
      releaseWakeLock();
    }
    
    // DO NOT stop unified listener
    
  } else {
    debugLog("[UI] Page visibility changed to visible");
    
    // Defensive check: ensure unified listener is running if connected
    if (state.connection && !state.rxTracking.isListening) {
      debugWarn("[UI] Page visible but unified listener inactive - restarting");
      startUnifiedRxListening();
    }
    
    // User must manually restart auto modes
  }
});

/**
 * Update Connect button state based on radio power selection
 */
function updateConnectButtonState() {
  const radioPowerSelected = getCurrentPowerSetting() !== "";
  const isConnected = !!state.connection;
  
  if (!isConnected) {
    // Only enable Connect if radio power is selected
    connectBtn.disabled = !radioPowerSelected;
    
    // Update dynamic status based on power selection
    if (!radioPowerSelected) {
      debugLog("[UI] Radio power not selected - showing message in status bar");
      setDynamicStatus("Select radio power to connect", STATUS_COLORS.warning);
    } else {
      debugLog("[UI] Radio power selected - clearing message from status bar");
      setDynamicStatus("Idle");
    }
  }
}

// ---- Bind UI & init ----
export async function onLoad() {
  debugLog("[INIT] wardrive.js onLoad() called - initializing");
  setConnStatus("Disconnected", STATUS_COLORS.error);
  enableControls(false);
  updateAutoButton();
  
  // Initialize Connect button state based on radio power
  updateConnectButtonState();

  connectBtn.addEventListener("click", async () => {
    try {
      if (state.connection) {
        await disconnect();
      } else {
        await connect();
      }
    } catch (e) {
      debugError("[UI] Connection button error:", `${e.message}`, e);
      setDynamicStatus(e.message || "Connection failed", STATUS_COLORS.error);
    }
  });
  txPingBtn.addEventListener("click", () => {
    debugLog("[UI] Manual ping button clicked");
    sendPing(true).catch(console.error);
  });
  txRxAutoBtn.addEventListener("click", () => {
    debugLog("[UI] Auto toggle button clicked");
    if (state.txRxAutoRunning) {
      stopAutoPing();
      setDynamicStatus("Auto mode stopped", STATUS_COLORS.idle);
    } else {
      startAutoPing();
    }
  });
  
  // NEW: RX Auto button listener
  rxAutoBtn.addEventListener("click", () => {
    debugLog("[UI] RX Auto button clicked");
    if (state.rxAutoRunning) {
      stopRxAuto();
    } else {
      startRxAuto();
    }
  });

  // Settings panel toggle (for modernized UI)
  const settingsGearBtn = document.getElementById("settingsGearBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  const settingsCloseBtn = document.getElementById("settingsCloseBtn");
  const connectionBar = document.getElementById("connectionBar");
  
  if (settingsGearBtn && settingsPanel && connectionBar) {
    settingsGearBtn.addEventListener("click", () => {
      debugLog("[UI] Settings gear button clicked");
      const isHidden = settingsPanel.classList.contains("hidden");
      settingsPanel.classList.toggle("hidden");
      
      // Update connection bar border radius based on settings panel state
      if (isHidden) {
        // Settings panel is opening - remove bottom rounded corners from connection bar
        connectionBar.classList.remove("rounded-xl", "rounded-b-xl");
        connectionBar.classList. add("rounded-t-xl", "rounded-b-none");
      } else {
        // Settings panel is closing - restore full rounded corners to connection bar
        connectionBar. classList.remove("rounded-t-xl", "rounded-b-none");
        connectionBar.classList. add("rounded-xl");
      }
    });
  }

  if (settingsCloseBtn && settingsPanel && connectionBar) {
    settingsCloseBtn.addEventListener("click", () => {
      debugLog("[UI] Settings close button clicked");
      settingsPanel.classList. add("hidden");
      // Restore full rounded corners to connection bar
      connectionBar.classList.remove("rounded-t-xl", "rounded-b-none");
      connectionBar.classList.add("rounded-xl");
    });
  }

  // Add event listeners to radio power options to update Connect button state
  const powerRadios = document.querySelectorAll('input[name="power"]');
  powerRadios.forEach(radio => {
    radio.addEventListener("change", () => {
      debugLog(`[UI] Radio power changed to: ${getCurrentPowerSetting()}`);
      updateConnectButtonState();
    });
  });

  // Session Log event listener
  if (txLogSummaryBar) {
    txLogSummaryBar.addEventListener("click", () => {
      debugLog("[UI] Log summary bar clicked - toggling session log");
      toggleTxLogBottomSheet();
    });
  }

  // RX Log event listener
  if (rxLogSummaryBar) {
    rxLogSummaryBar.addEventListener("click", () => {
      debugLog("[PASSIVE RX UI] RX log summary bar clicked - toggling RX log");
      toggleRxLogBottomSheet();
    });
  }

  // Error Log event listener
  if (errorLogSummaryBar) {
    errorLogSummaryBar.addEventListener("click", () => {
      debugLog("[ERROR LOG] Error log summary bar clicked - toggling Error log");
      toggleErrorLogBottomSheet();
    });
  }

  // Copy button event listeners
  if (txLogCopyBtn) {
    txLogCopyBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering the summary bar toggle
      debugLog("[TX LOG] Copy button clicked");
      copyLogToCSV('session', txLogCopyBtn);
    });
  }

  if (rxLogCopyBtn) {
    rxLogCopyBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering the summary bar toggle
      debugLog("[PASSIVE RX UI] Copy button clicked");
      copyLogToCSV('rx', rxLogCopyBtn);
    });
  }

  if (errorLogCopyBtn) {
    errorLogCopyBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering the summary bar toggle
      debugLog("[ERROR LOG] Copy button clicked");
      copyLogToCSV('error', errorLogCopyBtn);
    });
  }

  // Prompt location permission early (optional)
  debugLog("[GPS] Requesting initial location permission");
  try { 
    await getCurrentPosition(); 
    debugLog("[GPS] Initial location permission granted");
  } catch (e) { 
    debugLog(`[GPS] Initial location permission not granted: ${e.message}`);
  }
  debugLog("[INIT] wardrive.js initialization complete");
}
