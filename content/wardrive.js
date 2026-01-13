
// Minimal Wardrive sender with wake locks:
// - Connect to MeshCore Companion via Web Bluetooth (BLE)
// - Send pings as "@[MapperBot]<LAT LON>[ <power> ]" (power only if specified)
// - Manual "Send Ping" and Auto mode (interval selectable: 15/30/60s)
// - Acquire wake lock during auto mode to keep screen awake

import { WebBleConnection, Constants, Packet, BufferUtils } from "./mc/index.js"; // your BLE client

// ---- Debug Configuration ----
// Enable debug logging via URL parameter (?debug=1) or set default here
const urlParams = new URLSearchParams(window.location.search);
const DEBUG_ENABLED = urlParams.get('debug') === '1' || false; // Set to true to enable debug logging by default

// ---- Remote Debug Configuration ----
// Enable remote debug logging via URL parameters (?debuguser=1&debugkey=<key>)
// When enabled, all console output is batched and POSTed to meshmapper.net/livedebug.php
const REMOTE_DEBUG_USER = urlParams.get('debuguser') === '1';
const REMOTE_DEBUG_KEY = urlParams.get('debugkey') || null;
let REMOTE_DEBUG_ENABLED = REMOTE_DEBUG_USER && REMOTE_DEBUG_KEY; // Can be disabled on no_session error

// Remote Debug Queue State
const REMOTE_DEBUG_ENDPOINT = 'https://meshmapper.net/livedebug.php';
const REMOTE_DEBUG_BATCH_MAX = 100;           // Maximum logs per batch
const REMOTE_DEBUG_FLUSH_INTERVAL_MS = 15000; // Flush every 15 seconds
const REMOTE_DEBUG_RATE_LIMIT = 20;           // Max logs per second
const REMOTE_DEBUG_RATE_RESET_MS = 1000;      // Rate limit reset interval
const REMOTE_DEBUG_GRACE_PERIOD_MS = 10000;   // Grace period before rate limiting starts (15 seconds)

const debugLogQueue = {
  messages: [],           // Array of {date: <epoch>, message: <string>}
  flushTimerId: null,     // Timer ID for periodic flush
  rateResetTimerId: null, // Timer ID for rate limit reset
  logsThisSecond: 0,      // Current rate counter
  droppedCount: 0,        // Logs dropped due to rate limiting
  isProcessing: false,    // Lock to prevent concurrent flush
  startupTimestamp: Date.now()  // App launch time for grace period tracking
};

// Store original console methods before overriding
const originalConsoleLog = console.log.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);

/**
 * Queue a log message for remote debug submission
 * Handles rate limiting (10/sec) and batch size limits
 * @param {string} level - Log level (log, warn, error)
 * @param {Array} args - Arguments passed to console method
 */
function queueRemoteDebugLog(level, args) {
  if (!REMOTE_DEBUG_ENABLED) return;
  
  // Grace period check - bypass rate limiting for first 15 seconds
  const gracePeriodActive = (Date.now() - debugLogQueue.startupTimestamp) < REMOTE_DEBUG_GRACE_PERIOD_MS;
  
  // Rate limiting check (only after grace period)
  if (!gracePeriodActive && debugLogQueue.logsThisSecond >= REMOTE_DEBUG_RATE_LIMIT) {
    debugLogQueue.droppedCount++;
    return; // Drop this log
  }
  
  // Increment counter only after grace period
  if (!gracePeriodActive) {
    debugLogQueue.logsThisSecond++;
  }
  
  // Serialize arguments to string
  const messageParts = args.map(arg => {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  });
  
  // Prepend level prefix for warn/error
  let prefix = '';
  if (level === 'warn') prefix = '[WARN] ';
  if (level === 'error') prefix = '[ERROR] ';
  
  const logEntry = {
    date: Date.now(),
    message: prefix + messageParts.join(' ')
  };
  
  debugLogQueue.messages.push(logEntry);
  
  // Enforce max batch size (drop oldest if over limit)
  if (debugLogQueue.messages.length > REMOTE_DEBUG_BATCH_MAX) {
    debugLogQueue.messages.shift();
    debugLogQueue.droppedCount++;
  }
}

/**
 * Submit queued debug logs to remote endpoint
 * Uses 2-attempt retry, handles no_session error by disabling remote debug
 */
async function submitDebugLogs() {
  if (!REMOTE_DEBUG_ENABLED || debugLogQueue.messages.length === 0) return;
  if (debugLogQueue.isProcessing) return; // Prevent concurrent flushes
  
  debugLogQueue.isProcessing = true;
  
  // Include dropped count in this batch if any logs were dropped
  if (debugLogQueue.droppedCount > 0) {
    debugLogQueue.messages.push({
      date: Date.now(),
      message: `[REMOTE DEBUG] ${debugLogQueue.droppedCount} logs dropped due to rate limiting`
    });
    debugLogQueue.droppedCount = 0;
  }
  
  // Take messages for submission
  const messagesToSend = debugLogQueue.messages.slice();
  debugLogQueue.messages = [];
  
  const payload = {
    debugkey: REMOTE_DEBUG_KEY,
    data: messagesToSend
  };
  
  // Attempt up to 2 times
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(REMOTE_DEBUG_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const result = await response.json();
      
      // Check for no_session error
      if (!result.success && result.reason === 'no_session') {
        REMOTE_DEBUG_ENABLED = false;
        // Stop timers
        if (debugLogQueue.flushTimerId) {
          clearInterval(debugLogQueue.flushTimerId);
          debugLogQueue.flushTimerId = null;
        }
        if (debugLogQueue.rateResetTimerId) {
          clearInterval(debugLogQueue.rateResetTimerId);
          debugLogQueue.rateResetTimerId = null;
        }
        // Show error to user
        originalConsoleError('[REMOTE DEBUG] Session not found - remote debugging disabled:', result.message);
        // Don't retry on no_session
        break;
      }
      
      // Success
      if (result.success) {
        break; // Exit retry loop
      }
      
      // Other error - will retry if attempt < 2
      originalConsoleWarn(`[REMOTE DEBUG] Submit attempt ${attempt} failed:`, result.reason || 'unknown');
      
    } catch (err) {
      originalConsoleWarn(`[REMOTE DEBUG] Submit attempt ${attempt} network error:`, err.message);
      // Will retry if attempt < 2
    }
    
    // Wait 1 second before retry
    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  debugLogQueue.isProcessing = false;
}

/**
 * Start remote debug timers (15s flush, 1s rate reset)
 * Called only if REMOTE_DEBUG_ENABLED is true
 */
function startRemoteDebugTimers() {
  if (!REMOTE_DEBUG_ENABLED) return;
  
  // 15-second flush timer
  debugLogQueue.flushTimerId = setInterval(() => {
    submitDebugLogs().catch(err => {
      originalConsoleError('[REMOTE DEBUG] Flush error:', err.message);
    });
  }, REMOTE_DEBUG_FLUSH_INTERVAL_MS);
  
  // 1-second rate limit reset timer
  debugLogQueue.rateResetTimerId = setInterval(() => {
    debugLogQueue.logsThisSecond = 0;
    
    // Log when grace period expires (once at 15 seconds)
    const elapsed = Date.now() - debugLogQueue.startupTimestamp;
    if (elapsed >= REMOTE_DEBUG_GRACE_PERIOD_MS && elapsed < (REMOTE_DEBUG_GRACE_PERIOD_MS + REMOTE_DEBUG_RATE_RESET_MS)) {
      originalConsoleLog(`[REMOTE DEBUG] Grace period ended - rate limiting now active (${REMOTE_DEBUG_RATE_LIMIT} logs/sec)`);
    }
  }, REMOTE_DEBUG_RATE_RESET_MS);
  
  originalConsoleLog('[REMOTE DEBUG] Remote debug logging enabled - logs will be sent to server every 15s');
}

// Override console methods to capture all output for remote debug
// These overrides call the original method AND queue for remote submission
console.log = function(...args) {
  originalConsoleLog(...args);
  queueRemoteDebugLog('log', args);
};

console.warn = function(...args) {
  originalConsoleWarn(...args);
  queueRemoteDebugLog('warn', args);
};

console.error = function(...args) {
  originalConsoleError(...args);
  queueRemoteDebugLog('error', args);
};

// Start remote debug timers if enabled
if (REMOTE_DEBUG_ENABLED) {
  startRemoteDebugTimers();
  
  // Register beforeunload to attempt final flush
  window.addEventListener('beforeunload', () => {
    if (REMOTE_DEBUG_ENABLED && debugLogQueue.messages.length > 0) {
      // Use sendBeacon for reliable delivery during page unload
      const payload = JSON.stringify({
        debugkey: REMOTE_DEBUG_KEY,
        data: debugLogQueue.messages
      });
      navigator.sendBeacon(REMOTE_DEBUG_ENDPOINT, payload);
    }
  });
}

// Debug logging helper function
function debugLog(message, ...args) {
  // Direct queue for remote-only mode (bypasses console)
  if (REMOTE_DEBUG_ENABLED && !DEBUG_ENABLED) {
    queueRemoteDebugLog('log', [message, ...args]);
    return; // Don't proceed to console
  }
  
  // Console output (which gets captured by override if remote is enabled)
  if (DEBUG_ENABLED) {
    console.log(message, ...args);
  }
}

function debugWarn(message, ...args) {
  // Direct queue for remote-only mode (bypasses console)
  if (REMOTE_DEBUG_ENABLED && !DEBUG_ENABLED) {
    queueRemoteDebugLog('warn', [message, ...args]);
    return; // Don't proceed to console
  }
  
  // Console output (which gets captured by override if remote is enabled)
  if (DEBUG_ENABLED) {
    console.warn(message, ...args);
  }
}

function debugError(message, ...args) {
  // Direct queue for remote-only mode (bypasses console)
  if (REMOTE_DEBUG_ENABLED && !DEBUG_ENABLED) {
    queueRemoteDebugLog('error', [message, ...args]);
    
    // Still add to Error Log UI even in remote-only mode
    try {
      const tagMatch = message.match(/^\[([^\]]+)\]/);
      const source = tagMatch ? tagMatch[1] : null;
      const cleanMessage = tagMatch ? message.replace(/^\[[^\]]+\]\s*/, '') : message;
      
      if (typeof addErrorLogEntry === 'function') {
        addErrorLogEntry(cleanMessage, source);
      }
    } catch (e) {
      // Silently fail to prevent recursive errors
    }
    return; // Don't proceed to console
  }
  
  // Console output (which gets captured by override if remote is enabled)
  if (DEBUG_ENABLED) {
    console.error(message, ...args);
    
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
const ADVERT_HEADER = 0x11;                   // Header byte for ADVERT packets (0x11)

// RX Packet Filter Configuration
const MAX_RX_PATH_LENGTH = 9;                 // Maximum path length for RX packets (drop if exceeded to filter corrupted packets)
const MAX_RX_RSSI_THRESHOLD = -30;            // Maximum RSSI (dBm) for RX packets (drop if ≥ -30 to filter "carpeater" - extremely close/interfering repeaters)
const RX_ALLOWED_CHANNELS = ['#wardriving', 'Public', '#testing', '#ottawa']; // Allowed channels for RX wardriving (Public uses fixed key, hashtag channels use SHA-256 derivation)
const RX_PRINTABLE_THRESHOLD = 0.80;          // Minimum printable character ratio for GRP_TXT (80%)

// Fixed key for Public channel (default MeshCore channel without hashtag)
// This is a well-known key used by all MeshCore devices for the default Public channel
const PUBLIC_CHANNEL_FIXED_KEY = new Uint8Array([
  0x8b, 0x33, 0x87, 0xe9, 0xc5, 0xcd, 0xea, 0x6a,
  0xc9, 0xe5, 0xed, 0xba, 0xa1, 0x15, 0xcd, 0x72
]);

// Pre-computed channel hash and key for the wardriving channel
// These will be computed once at startup and used for message correlation and decryption
let WARDRIVING_CHANNEL_HASH = null;
let WARDRIVING_CHANNEL_KEY = null;

// Pre-computed channel hashes and keys for all allowed RX channels
const RX_CHANNEL_MAP = new Map(); // Map<channelHash, {name, key}>

// ---- Device Models Database ----
// Loaded from device-models.json at startup
let DEVICE_MODELS = [];

// Initialize channel hashes and keys at startup
(async function initializeChannelHash() {
  try {
    // Initialize wardriving channel (for TX tracking)
    WARDRIVING_CHANNEL_KEY = await deriveChannelKey(CHANNEL_NAME);
    WARDRIVING_CHANNEL_HASH = await computeChannelHash(WARDRIVING_CHANNEL_KEY);
    debugLog(`[INIT] Wardriving channel hash pre-computed at startup: 0x${WARDRIVING_CHANNEL_HASH.toString(16).padStart(2, '0')}`);
    debugLog(`[INIT] Wardriving channel key cached for message decryption (${WARDRIVING_CHANNEL_KEY.length} bytes)`);
    
    // Initialize all allowed RX channels
    debugLog(`[INIT] Pre-computing hashes/keys for ${RX_ALLOWED_CHANNELS.length} allowed RX channels...`);
    for (const channelName of RX_ALLOWED_CHANNELS) {
      const key = await getChannelKey(channelName);
      const hash = await computeChannelHash(key);
      RX_CHANNEL_MAP.set(hash, { name: channelName, key: key });
      debugLog(`[INIT] ${channelName} -> hash=0x${hash.toString(16).padStart(2, '0')}`);
    }
    debugLog(`[INIT] ✅ All RX channel hashes/keys initialized successfully`);
  } catch (error) {
    debugError(`[INIT] CRITICAL: Failed to pre-compute channel hash/key: ${error.message}`);
    debugError(`[INIT] Repeater echo tracking will be disabled. Please reload the page.`);
    // Channel hash and key remain null, which will be checked before starting tracking
  }
})();

// Geo-Auth Zone Configuration
const ZONE_CHECK_DISTANCE_M = 100;  // Recheck zone status every 100 meters

// Distance-Based Ping Filtering
const MIN_PING_DISTANCE_M = 25; // Minimum distance (25m) between pings

// Passive RX Log Batch Configuration
const RX_BATCH_DISTANCE_M = 50;        // Distance trigger for flushing batch (50m)
const RX_BATCH_TIMEOUT_MS = 30000;     // Max hold time per repeater (30 sec) - triggers flush if no movement

// Wardrive Batch Queue Configuration
const API_BATCH_MAX_SIZE = 50;              // Maximum messages per batch POST
const API_BATCH_FLUSH_INTERVAL_MS = 30000;  // Flush every 30 seconds
const API_TX_FLUSH_DELAY_MS = 3000;         // Flush 3 seconds after TX ping

// Heartbeat Configuration
const HEARTBEAT_BUFFER_MS = 5 * 60 * 1000;  // Schedule heartbeat 5 minutes before session expiry
const WARDRIVE_RETRY_DELAY_MS = 2000;       // Delay before retry on network failure (2 seconds)

// MeshMapper API Configuration
const WARDRIVE_ENDPOINT = "https://meshmapper.net/wardrive-api.php/wardrive";  // New wardrive data + heartbeat endpoint
const GEO_AUTH_STATUS_URL = "https://meshmapper.net/wardrive-api.php/status";  // Geo-auth zone status endpoint
const GEO_AUTH_URL = "https://meshmapper.net/wardrive-api.php/auth";  // Geo-auth connect/disconnect endpoint
const MESHMAPPER_API_KEY = "59C7754DABDF5C11CA5F5D8368F89";
const MESHMAPPER_DEFAULT_WHO = "GOME-WarDriver"; // Default identifier

// Static for now; will be made dynamic later.
const WARDIVE_IATA_CODE = "YOW";

// ---- App Version Configuration ----
// This constant is injected by GitHub Actions during build/deploy
// For release builds: Contains the release version (e.g., "v1.3.0")
// For DEV builds: Contains "DEV-<EPOCH>" format (e.g., "DEV-1734652800")
const APP_VERSION = "UNKNOWN"; // Placeholder - replaced during build

// ---- Auth Reason Messages ----
// Maps API reason codes to user-facing error messages
const REASON_MESSAGES = {
  // Auth/connect errors
  outofdate: "App out of date, please update",
  unknown_device: "Device not registered - advertise on mesh first",
  outside_zone: "Outside zone",
  zone_disabled: "Zone is disabled",
  zone_full: "Zone at capacity",
  bad_key: "Invalid API key",
  gps_stale: "GPS data too old - try again",
  gps_inaccurate: "GPS accuracy too low - try again",
  // Session errors (wardrive API)
  bad_session: "Invalid session",
  session_expired: "Session expired",
  session_invalid: "Session invalid",
  session_revoked: "Session revoked",
  // Authorization errors (wardrive API)
  invalid_key: "Invalid API key",
  unauthorized: "Unauthorized",
  // Rate limiting (wardrive API)
  rate_limited: "Rate limited - slow down",
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

// ---- DOM refs (from index.html) ----
const $ = (id) => document.getElementById(id);
const statusEl       = $("status");
const channelInfoEl  = $("channelInfo");
const connectBtn     = $("connectBtn");
const txPingBtn      = $("txPingBtn");
const txRxAutoBtn    = $("txRxAutoBtn");
const rxAutoBtn      = $("rxAutoBtn");
const gpsInfoEl = document.getElementById("gpsInfo");
const gpsAccEl = document.getElementById("gpsAcc");
const distanceInfoEl = document.getElementById("distanceInfo"); // Distance from last ping
const txPingsEl = document.getElementById("txPings"); // TX log container
// Double-buffered iframes for seamless map updates
let coverageFrameA = document.getElementById("coverageFrameA");
let coverageFrameB = document.getElementById("coverageFrameB");
let activeFrame = coverageFrameA; // Track which frame is currently visible

// Track last connection status to avoid logging spam (declared here to avoid TDZ with setConnStatus call below)
let lastConnStatusText = null;

setConnectButton(false);
setConnStatus("Disconnected", STATUS_COLORS.error);

// Power, Device Model, and Zone selectors
const deviceModelEl  = $("deviceModel");
// Zone status removed from connection bar - only shown in settings panel (locationDisplay)
const locationDisplay = $("locationDisplay"); // Location (zone code) in settings
const slotsDisplay   = $("slotsDisplay");    // Slot availability in settings

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
  dropCount: 0, // Count of dropped/filtered packets
  carpeaterIgnoreDropCount: 0,  // User-specified repeater drops (silent)
  carpeaterRssiDropCount: 0,     // RSSI failsafe drops (logged)
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
  capturedPingCoords: null, // { lat, lon, accuracy, noisefloor, timestamp } captured at ping time, used for API post after RX window
  devicePublicKey: null, // Hex string of device's public key (used for auth)
  deviceModel: null, // Manufacturer/model string exposed by companion
  firmwareVersion: null, // Parsed firmware version { major, minor, patch } or null for nightly/unparseable
  autoPowerSet: false, // Whether power was automatically set based on device model
  lastNoiseFloor: null, // Most recent noise floor read from companion (dBm) or 'ERR'
  noiseFloorUpdateTimer: null, // Timer for periodic noise floor updates (5s interval)
  deviceName: null,
  wardriveSessionId: null, // Session ID from /auth API (used for all MeshMapper API posts)
  debugMode: false, // Whether debug mode is enabled by MeshMapper API
  txAllowed: false, // Whether TX wardriving is permitted (from /auth response)
  rxAllowed: false, // Whether RX wardriving is permitted (from /auth response)
  sessionExpiresAt: null, // Unix timestamp when session expires (for heartbeat scheduling)
  heartbeatTimerId: null, // Timer ID for heartbeat scheduling
  tempTxRepeaterData: null, // Temporary storage for TX repeater debug data
  disconnectReason: null, // Tracks the reason for disconnection (e.g., "app_down", "unknown_device", "outside_zone", "zone_disabled", "channel_setup_error", "ble_disconnect_error", "session_id_error", "normal", or API reason codes like "outofdate")
  channelSetupErrorMessage: null, // Error message from channel setup failure
  bleDisconnectErrorMessage: null, // Error message from BLE disconnect failure
  pendingApiPosts: [], // Array of pending background API post promises
  currentZone: null, // Current zone object from preflight check: { name, code, enabled, at_capacity, slots_available, slots_max }
  lastZoneCheckCoords: null, // { lat, lon } of last zone status check (for 100m movement trigger)
  zoneCheckInProgress: false, // Prevents duplicate concurrent zone checks
  slotRefreshTimerId: null, // Timer for periodic slot capacity refresh (30s disconnected, 60s connected)
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

// Wardrive Batch Queue State
const wardriveQueue = {
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
  currentColor: '',         // Current status color
  outsideZoneError: null    // Persistent "outside zone" error message (blocks other messages until cleared)
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
  
  // CRITICAL: Clear the actual ping timer to prevent it from firing during manual ping
  if (state.autoTimerId) {
    debugLog(`[TIMER] Clearing ping timer (id=${state.autoTimerId}) during pause`);
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  
  // Stop the UI countdown display
  autoCountdownTimer.stop();
  state.nextAutoPingTime = null;
}

function resumeAutoCountdown() {
  // Resume auto countdown from paused time
  if (state.pausedAutoTimerRemainingMs !== null) {
    // Validate paused time is still reasonable before resuming
    if (state.pausedAutoTimerRemainingMs > MIN_PAUSE_THRESHOLD_MS && state.pausedAutoTimerRemainingMs < MAX_REASONABLE_TIMER_MS) {
      const remainingMs = state.pausedAutoTimerRemainingMs;
      debugLog(`[TIMER] Resuming auto countdown with ${remainingMs}ms remaining`);
      
      // Start the UI countdown display
      startAutoCountdown(remainingMs);
      
      // CRITICAL: Also schedule the actual ping timer with the remaining time
      state.autoTimerId = setTimeout(() => {
        debugLog(`[TX/RX AUTO] Resumed auto ping timer fired (id=${state.autoTimerId})`);
        
        // Double-check guards before sending ping
        if (!state.txRxAutoRunning) {
          debugLog("[TX/RX AUTO] Auto mode no longer running, ignoring timer");
          return;
        }
        if (state.pingInProgress) {
          debugLog("[TX/RX AUTO] Ping already in progress, ignoring timer");
          return;
        }
        
        state.skipReason = null;
        debugLog("[TX/RX AUTO] Sending auto ping (resumed)");
        sendPing(false).catch((e) => debugError("[TX/RX AUTO] Resumed auto ping error:", e?.message || String(e)));
      }, remainingMs);
      debugLog(`[TIMER] Resumed ping timer scheduled (id=${state.autoTimerId})`);
      
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
  const powerSelected = getCurrentPowerSetting() !== "";
  debugLog(`[UI] updateControlsForCooldown: connected=${connected}, inCooldown=${inCooldown}, pingInProgress=${state.pingInProgress}, txRxAutoRunning=${state.txRxAutoRunning}, rxAutoRunning=${state.rxAutoRunning}, powerSelected=${powerSelected}, txAllowed=${state.txAllowed}, rxAllowed=${state.rxAllowed}`);
  
  // TX Ping button - requires TX permission, disabled during cooldown, ping in progress, OR when no power selected
  txPingBtn.disabled = !connected || !state.txAllowed || inCooldown || state.pingInProgress || !powerSelected;
  
  // TX/RX Auto button - requires TX permission, disabled during cooldown, ping in progress, when RX Auto running, OR when no power selected
  txRxAutoBtn.disabled = !connected || !state.txAllowed || inCooldown || state.pingInProgress || state.rxAutoRunning || !powerSelected;
  
  // RX Auto button - enabled when connected with RX permission (including RX-only mode)
  // Disabled during TX/RX Auto mode (can't run both), and requires power selected
  rxAutoBtn.disabled = !connected || !state.rxAllowed || state.txRxAutoRunning || !powerSelected;
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
  stopWardriveTimers();
  
  // Cancel heartbeat timer
  cancelHeartbeat();
  
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
  
  // Clear RX batch buffer (including per-repeater timeout timers)
  if (state.rxBatchBuffer && state.rxBatchBuffer.size > 0) {
    // Clear all timeout timers before clearing the buffer
    for (const [repeaterId, buffer] of state.rxBatchBuffer.entries()) {
      if (buffer.timeoutId) {
        clearTimeout(buffer.timeoutId);
        debugLog(`[RX BATCH] Cleared timeout timer for repeater ${repeaterId} during cleanup`);
      }
    }
    state.rxBatchBuffer.clear();
    debugLog("[RX BATCH] RX batch buffer cleared");
  }
}

function enableControls(connected) {
  setConnectButtonDisabled(false);
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
  // Use current zone code from preflight check, fallback to default
  const zoneCode = (state.currentZone?.code || WARDIVE_IATA_CODE).toLowerCase();
  const base =
    `https://${zoneCode}.meshmapper.net/embed.php?cov_grid=1&fail_grid=1&pings=0&repeaters=1&rep_coverage=0&grid_lines=0&dir=1&meters=1500`;
  return `${base}&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
}
let coverageRefreshTimer = null;
let bufferLoadHandler = null; // Track current load handler for cleanup

/**
 * Schedule a coverage map refresh using double-buffered iframe swap
 * Loads new content in hidden iframe, swaps visibility when ready (no flicker)
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude  
 * @param {number} delayMs - Delay before starting load (default 0)
 */
function scheduleCoverageRefresh(lat, lon, delayMs = 0) {
  if (!coverageFrameA || !coverageFrameB) return;

  if (coverageRefreshTimer) clearTimeout(coverageRefreshTimer);

  coverageRefreshTimer = setTimeout(() => {
    const url = buildCoverageEmbedUrl(lat, lon);
    debugLog("[UI] Coverage iframe loading:", url);
    
    // Determine which frame is hidden (the buffer)
    const bufferFrame = (activeFrame === coverageFrameA) ? coverageFrameB : coverageFrameA;
    
    // Clean up any previous load handler
    if (bufferLoadHandler) {
      bufferFrame.removeEventListener('load', bufferLoadHandler);
      bufferLoadHandler = null;
    }
    
    // Create new load handler that swaps visibility
    bufferLoadHandler = function onBufferLoad() {
      // Delay after load to ensure iframe content is fully rendered
      // Cross-origin iframes may fire load before paint is complete
      setTimeout(() => {
        // Swap opacity: fade out current active, fade in buffer
        activeFrame.classList.remove('coverage-frame-active');
        activeFrame.classList.add('coverage-frame-hidden');
        bufferFrame.classList.remove('coverage-frame-hidden');
        bufferFrame.classList.add('coverage-frame-active');
        
        // Update active frame reference
        activeFrame = bufferFrame;
        debugLog("[UI] Coverage iframe swapped (double-buffer)");
        
        // Clean up
        bufferFrame.removeEventListener('load', bufferLoadHandler);
        bufferLoadHandler = null;
      }, 300); // 300ms delay for content to render
    };
    
    // Set up load listener and start loading in buffer
    bufferFrame.addEventListener('load', bufferLoadHandler);
    bufferFrame.src = url;
  }, delayMs);
}

/**
 * Update map and GPS overlay after a zone check
 * - Updates GPS coordinates and accuracy on the map overlay
 * - Refreshes the map iframe with new coordinates (unless auto mode is running)
 * @param {Object} coords - Coordinates object with lat, lon, accuracy_m properties
 */
function updateMapOnZoneCheck(coords) {
  if (!coords) return;
  
  const { lat, lon, accuracy_m } = coords;
  
  // Update GPS overlay
  if (gpsInfoEl) {
    gpsInfoEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }
  if (gpsAccEl && accuracy_m) {
    gpsAccEl.textContent = `±${Math.round(accuracy_m)}m`;
  }
  
  // Skip map refresh if auto mode is running (ping completion handles map refresh)
  if (state.txRxAutoRunning || state.rxAutoRunning) {
    debugLog(`[GEO AUTH] Skipping map refresh - auto mode running`);
    return;
  }
  
  // Refresh map iframe with new coordinates
  scheduleCoverageRefresh(lat, lon);
  debugLog(`[GEO AUTH] Map updated: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, accuracy=${accuracy_m ? Math.round(accuracy_m) + 'm' : 'N/A'}`);
}

/**
 * Set Connect button visual disabled state
 * Updates opacity and cursor to indicate whether button is clickable
 * @param {boolean} disabled - Whether button should appear disabled
 */
function setConnectButtonDisabled(disabled) {
  if (!connectBtn) return;
  connectBtn.disabled = disabled;
  if (disabled) {
    connectBtn.classList.add("opacity-50", "cursor-not-allowed");
  } else {
    connectBtn.classList.remove("opacity-50", "cursor-not-allowed");
  }
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
  const noiseDisplayEl = document.getElementById("noiseDisplay");
  
  if (!connectionStatusEl) return;
  
  // Only log when status actually changes
  if (text !== lastConnStatusText) {
    debugLog(`[UI] Connection status: "${text}"`);
    lastConnStatusText = text;
  }
  
  // Format based on connection state
  if (text === "Connected") {
    // Show device name on left, noise on right
    const deviceName = state.deviceName || "[No device]";
    let noiseText = "-";
    if (state.lastNoiseFloor === null) {
      noiseText = "Firmware 1.11+";
    } else if (state.lastNoiseFloor === 'ERR') {
      noiseText = "ERR";
    } else {
      noiseText = `${state.lastNoiseFloor}dBm`;
    }
    connectionStatusEl.textContent = deviceName;
    connectionStatusEl.className = 'font-medium text-slate-300';
    
    // Update noise display on right side
    if (noiseDisplayEl) {
      noiseDisplayEl.textContent = `🔊 ${noiseText}`;
    }
  } else if (text === "Disconnected") {
    // Show disconnected status, clear noise
    connectionStatusEl.textContent = text;
    connectionStatusEl.className = `font-medium ${color}`;
    if (noiseDisplayEl) {
      noiseDisplayEl.textContent = '';
    }
  } else {
    // Connecting, Disconnecting - show as-is, clear noise
    connectionStatusEl.textContent = text;
    connectionStatusEl.className = `font-medium ${color}`;
    if (noiseDisplayEl) {
      noiseDisplayEl.textContent = '';
    }
  }
  
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
 * When outsideZoneError is set, all other messages are blocked until the error is cleared.
 * 
 * @param {string} text - Status message text (null/empty shows "—")
 * @param {string} color - Status color class from STATUS_COLORS
 * @param {boolean} immediate - If true, bypass minimum visibility (for countdown timers)
 */
function setDynamicStatus(text, color = STATUS_COLORS.idle, immediate = false) {
  // If outside zone error is active, block all other messages (except clearing it)
  if (statusMessageState.outsideZoneError && text !== statusMessageState.outsideZoneError) {
    debugLog(`[UI] Dynamic status blocked by persistent outside zone error: "${text}"`);
    return;
  }
  
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

/**
 * Update zone status UI based on zone check response
 * @param {Object} zoneData - Zone status response from checkZoneStatus()
 */
function updateZoneStatusUI(zoneData) {
  debugLog(`[GEO AUTH] [UI] Updating zone status UI`);
  
  if (!zoneData) {
    debugWarn(`[GEO AUTH] [UI] No zone data provided, setting error state`);
    locationDisplay.textContent = "Unknown";
    locationDisplay.className = "font-medium text-red-400";
    updateSlotsDisplay(null);
    return;
  }
  
  // Handle success with in_zone
  if (zoneData.success && zoneData.in_zone) {
    const zone = zoneData.zone;
    const atCapacity = zone.at_capacity;
    const statusColor = atCapacity ? "text-amber-300" : "text-emerald-300";
    
    // Clear persistent outside zone error if it was set
    if (statusMessageState.outsideZoneError) {
      debugLog(`[GEO AUTH] [UI] Clearing persistent outside zone error - now in zone ${zone.code}`);
      statusMessageState.outsideZoneError = null;
      // Only clear to Idle if not showing a disconnect error
      // Check if disconnectReason is an error (not normal/null/undefined)
      const isErrorDisconnect = state.disconnectReason && 
        state.disconnectReason !== "normal" && 
        state.disconnectReason !== null;
      if (!isErrorDisconnect) {
        setDynamicStatus("—", STATUS_COLORS.idle); // Clear the dynamic status bar
      } else {
        debugLog(`[GEO AUTH] [UI] Preserving disconnect error status (reason: ${state.disconnectReason})`);
      }
    }
    
    locationDisplay.textContent = zone.code;
    locationDisplay.className = `font-medium ${statusColor}`;
    
    updateSlotsDisplay(zone);
    
    debugLog(`[GEO AUTH] [UI] Zone status: in zone ${zone.code}, slots ${zone.slots_available}/${zone.slots_max}, at_capacity=${atCapacity}`);
    return;
  }
  
  // Handle success but outside zone
  if (zoneData.success && !zoneData.in_zone) {
    const nearest = zoneData.nearest_zone;
    const distText = `Outside zone (${nearest.distance_km}km to ${nearest.code})`;
    
    // Set persistent outside zone error - blocks all other dynamic status messages
    statusMessageState.outsideZoneError = distText;
    debugLog(`[GEO AUTH] [UI] Set persistent outside zone error: "${distText}"`);
    
    // Show error in dynamic status bar (red) - this overrides "Select external antenna" message
    setDynamicStatus(distText, STATUS_COLORS.error);
    
    // Log as error
    debugError(`[GEO AUTH] ${distText}`);
    
    locationDisplay.textContent = "—";
    locationDisplay.className = "font-medium text-slate-400";
    
    updateSlotsDisplay(null);
    
    debugLog(`[GEO AUTH] [UI] Zone status: outside zone, nearest is ${nearest.code} at ${nearest.distance_km}km`);
    return;
  }
  
  // Handle error states
  if (!zoneData.success) {
    const reason = zoneData.reason || "unknown";
    let statusText = "Zone check failed";
    let dynamicStatusText = null;  // For persistent errors in dynamic status bar
    
    if (reason === "gps_stale") {
      statusText = "GPS: stale";
    } else if (reason === "gps_inaccurate") {
      statusText = "GPS: inaccurate";
    } else if (reason === "outofdate") {
      // App version outdated - show persistent error in dynamic status bar
      statusText = "";  // Clear location display
      dynamicStatusText = zoneData.message || "App version outdated, please update";
      
      // Set persistent error - blocks all other dynamic status messages
      statusMessageState.outsideZoneError = dynamicStatusText;
      debugLog(`[GEO AUTH] Set persistent outofdate error: "${dynamicStatusText}"`);
      
      // Show error in dynamic status bar (red)
      setDynamicStatus(dynamicStatusText, STATUS_COLORS.error);
      
      // Disable Connect button - can't use app with outdated version
      setConnectButtonDisabled(true);
      
      // Clear current zone to stop slot refresh timer from running
      state.currentZone = null;
      
      // Log as error (single consolidated message)
      debugError(`[GEO AUTH] ${dynamicStatusText}`);
    }
    
    locationDisplay.textContent = statusText || "Unknown";
    locationDisplay.className = "font-medium text-red-400";
    
    updateSlotsDisplay(null);
    
    // Only log if not already logged above (outofdate case)
    if (reason !== "outofdate") {
      debugError(`[GEO AUTH] [UI] Zone check error: reason=${reason}, message=${zoneData.message}`);
    }
    return;
  }
}

/**
 * Update slots display in settings panel
 * @param {Object|null} zone - Zone object with slots_available and slots_max, or null for N/A
 */
function updateSlotsDisplay(zone) {
  if (!zone) {
    slotsDisplay.textContent = "N/A";
    slotsDisplay.className = "font-medium text-slate-400";
    debugLog(`[UI] Slots display: N/A`);
    return;
  }
  
  const { slots_available, slots_max, at_capacity, code } = zone;
  
  if (at_capacity || slots_available === 0) {
    slotsDisplay.textContent = `Full (0/${slots_max})`;
    slotsDisplay.className = "font-medium text-amber-300";
    
    // Update location display to amber (slots full)
    locationDisplay.className = "font-medium text-amber-300";
    
    // Show warning in dynamic status bar (yellow, not blocking - user can still connect for RX)
    const warnMsg = `No TX wardriving slots for ${code}. RX only.`;
    setDynamicStatus(warnMsg, STATUS_COLORS.warning);
    debugLog(`[GEO AUTH] ${warnMsg}`);
    
    debugLog(`[UI] Slots display: Full (0/${slots_max})`);
  } else {
    slotsDisplay.textContent = `${slots_available} available`;
    slotsDisplay.className = "font-medium text-emerald-300";
    
    // Update location display to green (slots available)
    locationDisplay.className = "font-medium text-emerald-300";
    
    debugLog(`[UI] Slots display: ${slots_available} available (${slots_available}/${slots_max})`);
    
    // Re-check connect button state now that slots are available
    // Note: updateConnectButtonState() will set the appropriate status message
    // based on both zone status AND antenna selection
    updateConnectButtonState();
  }
}

/**
 * Start/restart the 30s slot refresh timer (disconnected mode)
 * Called on initial zone check success, after disconnect, and after connection failure
 */
function startSlotRefreshTimer() {
  // Clear any existing timer
  if (state.slotRefreshTimerId) {
    clearInterval(state.slotRefreshTimerId);
  }
  
  state.slotRefreshTimerId = setInterval(async () => {
    const mode = state.connection ? "connected" : "disconnected";
    debugLog(`[GEO AUTH] [SLOT REFRESH] 30s timer triggered (${mode} mode)`);
    // Continue checking even while connected to keep slot display current
    // Re-check zone to refresh slots or detect zone re-entry
    const coords = await getValidGpsForZoneCheck();
    if (coords) {
      const result = await checkZoneStatus(coords);
      if (result.success && result.in_zone && result.zone) {
        // In zone (or returned to zone) - update slots display
        const wasOutside = !state.currentZone;
        state.currentZone = result.zone;
        state.lastZoneCheckCoords = { lat: coords.lat, lon: coords.lon };
        updateZoneStatusUI(result);
        updateMapOnZoneCheck(coords);  // Update map and GPS overlay
        if (wasOutside) {
          debugLog(`[GEO AUTH] [SLOT REFRESH] ✅ Returned to zone: ${result.zone.name}, slots: ${result.zone.slots_available}/${result.zone.slots_max}`);
        } else {
          debugLog(`[GEO AUTH] [SLOT REFRESH] Updated slots: ${result.zone.slots_available}/${result.zone.slots_max}`);
        }
      } else if (result.success && !result.in_zone) {
        // Outside zone - update UI to show outside zone status
        state.currentZone = null;
        state.lastZoneCheckCoords = { lat: coords.lat, lon: coords.lon };
        updateZoneStatusUI(result);
        updateMapOnZoneCheck(coords);
        debugLog(`[GEO AUTH] [SLOT REFRESH] Outside zone, nearest: ${result.nearest_zone?.name} at ${result.nearest_zone?.distance_km}km`);
      } else if (result && !result.success) {
        // Handle error states (outofdate, etc.) - this will disable button and clear currentZone
        state.currentZone = null;
        updateZoneStatusUI(result);
        debugLog(`[GEO AUTH] [SLOT REFRESH] Zone check failed: ${result.reason || 'unknown'}`);
      }
    }
  }, 30000); // 30 seconds
  debugLog("[GEO AUTH] Started 30s slot refresh timer");
}

/**
 * Perform zone check on app launch
 * - Disables Connect button initially
 * - Shows "Checking zone..." status
 * - Gets GPS and performs zone check
 * - Updates UI and enables Connect if in valid zone
 * - Starts 30s slot refresh timer
 * - Centers map on checked location
 */
async function performAppLaunchZoneCheck() {
  debugLog("[GEO AUTH] [INIT] Performing app launch zone check");
  
  // Disable Connect button initially
  setConnectButtonDisabled(true);
  debugLog("[GEO AUTH] [INIT] Connect button disabled during zone check");
  
  // Show "Checking zone..." in location display
  locationDisplay.textContent = "Checking...";
  locationDisplay.className = "font-medium text-slate-400";
  debugLog("[GEO AUTH] [INIT] Location display set to 'Checking...'");
  
  try {
    // Get valid GPS coordinates
    debugLog("[GEO AUTH] [INIT] Getting valid GPS coordinates for zone check");
    const coords = await getValidGpsForZoneCheck();
    
    if (!coords) {
      debugWarn("[GEO AUTH] [INIT] Failed to get valid GPS coordinates after retries");
      updateZoneStatusUI(null, "gps_unavailable");
      // Connect button remains disabled
      return;
    }
    
    debugLog(`[GEO AUTH] [INIT] Valid GPS acquired: ${coords.lat.toFixed(6)}, ${coords.lon.toFixed(6)}`);
    
    // Perform zone check
    debugLog("[GEO AUTH] [INIT] Calling checkZoneStatus()");
    const result = await checkZoneStatus(coords);
    
    // Store result in state based on response
    if (result.success && result.in_zone && result.zone) {
      // User is inside a valid zone
      state.currentZone = result.zone;
      state.lastZoneCheckCoords = { lat: coords.lat, lon: coords.lon };
      debugLog(`[GEO AUTH] [INIT] ✅ Zone check successful: ${result.zone.name} (${result.zone.code})`);
      debugLog(`[GEO AUTH] [INIT] In zone: ${result.in_zone}, At capacity: ${result.zone.at_capacity}`);
    } else if (result.success && !result.in_zone) {
      // User is outside all zones - this is a valid response, not a failure
      state.currentZone = null;
      state.lastZoneCheckCoords = { lat: coords.lat, lon: coords.lon };
      const nearest = result.nearest_zone;
      debugLog(`[GEO AUTH] [INIT] ⚠️ Outside all zones, nearest: ${nearest.name} (${nearest.code}) at ${nearest.distance_km}km`);
    } else {
      // Actual failure (API error, network error, etc.)
      state.currentZone = null;
      state.lastZoneCheckCoords = null;
      debugWarn(`[GEO AUTH] [INIT] Zone check failed: ${result.error || "Unknown error"}`);
    }
    
    // Update UI with result
    updateZoneStatusUI(result, null);
    
    // Update map and GPS overlay with zone check coordinates
    updateMapOnZoneCheck(coords);
    
    // Enable Connect button only if in valid zone AND external antenna selected
    if (result.success && result.in_zone) {
      updateConnectButtonState();  // Checks both zone and antenna
      debugLog("[GEO AUTH] [INIT] ✅ Zone check passed, updateConnectButtonState() called");
      
      // Start 30s slot refresh timer (disconnected mode)
      startSlotRefreshTimer();
    } else {
      setConnectButtonDisabled(true);
      debugLog("[GEO AUTH] [INIT] ❌ Connect button remains disabled (not in valid zone or check failed)");
    }
    
  } catch (err) {
    debugError(`[GEO AUTH] [INIT] Exception during app launch zone check: ${err.message}`);
    updateZoneStatusUI(null, "error");
    setConnectButtonDisabled(true);
  }
}

/**
 * Handle zone recheck when GPS moves >= 100m from last zone check
 * Called from GPS watch callback ONLY when disconnected
 * Updates zone status display for user awareness
 * @param {Object} newCoords - Current GPS coordinates {lat, lon}
 */
async function handleZoneCheckOnMove(newCoords) {
  // Skip if no previous zone check or check already in progress
  if (!state.lastZoneCheckCoords || state.zoneCheckInProgress) {
    return;
  }
  
  // Calculate distance from last zone check location
  const distance = calculateHaversineDistance(
    state.lastZoneCheckCoords.lat,
    state.lastZoneCheckCoords.lon,
    newCoords.lat,
    newCoords.lon
  );
  
  debugLog(`[GEO AUTH] [GPS MOVEMENT] Distance from last zone check: ${distance.toFixed(1)}m (threshold: ${ZONE_CHECK_DISTANCE_M}m)`);
  
  // Trigger zone check if moved >= 100m
  if (distance >= ZONE_CHECK_DISTANCE_M) {
    debugLog(`[GEO AUTH] [GPS MOVEMENT] ⚠️ Moved ${distance.toFixed(1)}m - triggering zone recheck (disconnected mode)`);
    
    state.zoneCheckInProgress = true;
    
    try {
      // Perform zone check with current coordinates
      const result = await checkZoneStatus(newCoords);
      
      // Update state
      if (result.success && result.zone) {
        state.currentZone = result.zone;
        state.lastZoneCheckCoords = { lat: newCoords.lat, lon: newCoords.lon };
        debugLog(`[GEO AUTH] [GPS MOVEMENT] ✅ Zone recheck successful: ${result.zone.name} (${result.zone.code})`);
      } else {
        state.currentZone = null;
        state.lastZoneCheckCoords = null;
        debugWarn(`[GEO AUTH] [GPS MOVEMENT] Zone recheck failed: ${result.error || "Unknown error"}`);
      }
      
      // Update UI with new zone status
      updateZoneStatusUI(result, null);
      
      // Update map and GPS overlay with new coordinates
      updateMapOnZoneCheck(newCoords);
      
    } catch (err) {
      debugError(`[GEO AUTH] [GPS MOVEMENT] Exception during zone recheck: ${err.message}`);
    } finally {
      state.zoneCheckInProgress = false;
    }
  }
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

/**
 * Parse firmware version from device model string
 * @param {string} model - Device model string (e.g., "Elecrow ThinkNode-M1 v1.11.0-6d32193")
 * @returns {{major: number, minor: number, patch: number}|null} Parsed version or null if unparseable/nightly
 */
function parseFirmwareVersion(model) {
  if (!model) return null;
  const match = model.match(/v(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    debugLog(`[BLE] Firmware version not found in model string (likely nightly build)`);
    return null;
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}

/**
 * Check if firmware version supports noisefloor collection (requires 1.11.0+)
 * @param {{major: number, minor: number, patch: number}|null} version - Parsed firmware version
 * @returns {boolean} True if noisefloor is supported
 */
function firmwareSupportsNoisefloor(version) {
  // Null version means nightly build - assume supported (bleeding edge)
  if (version === null) return true;
  // Version 2.x.x or higher always supported
  if (version.major > 1) return true;
  // Version 1.11.0+ supported
  if (version.major === 1 && version.minor >= 11) return true;
  return false;
}

/**
 * Start periodic noise floor updates (5 second interval)
 * Only called if feature is supported by firmware
 */
function startNoiseFloorUpdates() {
  // Clear any existing timer
  stopNoiseFloorUpdates();
  
  // Start periodic updates every 5 seconds
  state.noiseFloorUpdateTimer = setInterval(async () => {
    if (!state.connection) {
      debugLog("[BLE] No connection, stopping noise floor updates");
      stopNoiseFloorUpdates();
      return;
    }
    
    try {
      // 5 second timeout as safety fallback
      const stats = await state.connection.getRadioStats(5000);
      if (stats && typeof stats.noiseFloor !== 'undefined') {
        state.lastNoiseFloor = stats.noiseFloor;
        debugLog(`[BLE] Noise floor updated: ${state.lastNoiseFloor}`);
        // Update connection bar
        if (state.connection) {
          setConnStatus("Connected", STATUS_COLORS.success);
        }
      }
    } catch (e) {
      // Silently ignore periodic update failures - keep showing last known value
      debugLog(`[BLE] Noise floor update failed: ${e && e.message ? e.message : String(e)}`);
    }
  }, 5000);
  
  debugLog("[BLE] Noise floor update timer started (5s interval)");
}

/**
 * Stop periodic noise floor updates
 */
function stopNoiseFloorUpdates() {
  if (state.noiseFloorUpdateTimer) {
    clearInterval(state.noiseFloorUpdateTimer);
    state.noiseFloorUpdateTimer = null;
    debugLog("[BLE] Noise floor update timer stopped");
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
      updateDistanceUi(); 
      
      // Update distance when GPS position changes
      // NEW: Check RX batches for distance trigger when GPS position updates
      if (state.rxTracking. isWardriving && state.rxBatchBuffer.size > 0) {
        checkAllRxBatchesForDistanceTrigger({ lat: pos.coords. latitude, lon: pos.coords. longitude });
      }
      
      // Check if GPS movement triggers zone recheck (100m threshold)
      // Only monitor while disconnected - zone validation while connected happens via /wardrive posts
      if (!state.connection) {
        handleZoneCheckOnMove({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      }
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
 * NOTE: This function is ONLY for hashtag channels. The "Public" channel (without hashtag)
 * uses a fixed key defined in PUBLIC_CHANNEL_FIXED_KEY constant.
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

/**
 * Get channel key for any channel (handles both Public and hashtag channels)
 * Provides a unified interface for retrieving channel keys regardless of type
 * @param {string} channelName - Channel name (e.g., "Public", "#wardriving", "#testing")
 * @returns {Promise<Uint8Array>} The 16-byte channel key
 */
async function getChannelKey(channelName) {
  if (channelName === 'Public') {
    debugLog(`[CHANNEL] Using fixed key for Public channel`);
    return PUBLIC_CHANNEL_FIXED_KEY;
  } else {
    return await deriveChannelKey(channelName);
  }
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

// ---- Device Model Parsing Functions ----

/**
 * Parse device model string by removing build suffix (e.g., "nightly-e31c46f")
 * @param {string} rawModel - Raw manufacturer model string from deviceQuery
 * @returns {string} Cleaned model string without build suffix
 */
function parseDeviceModel(rawModel) {
  if (!rawModel || rawModel === "-") return "";
  
  // Strip null characters (\u0000) that may be present in firmware strings
  const sanitizedModel = rawModel.replace(/\u0000/g, '');
  
  // Strip build suffix like "nightly-e31c46f", "stable-a1b2c3d", etc.
  // Match pattern: word-hexstring at end of string
  const cleanedModel = sanitizedModel.replace(/(nightly|stable|beta|alpha|dev)-[a-f0-9]{7,}$/i, '').trim();
  
  debugLog(`[DEVICE MODEL] Parsed model: "${rawModel.substring(0, 50)}..." -> "${cleanedModel}"`);
  return cleanedModel;
}

/**
 * Find device configuration in DEVICE_MODELS database
 * @param {string} modelString - Cleaned model string (without build suffix)
 * @returns {Object|null} Device config object with {manufacturer, shortName, power, txPower} or null if not found
 */
function findDeviceConfig(modelString) {
  if (!modelString || !DEVICE_MODELS || DEVICE_MODELS.length === 0) {
    return null;
  }
  
  // Try exact match first
  let device = DEVICE_MODELS.find(d => d.manufacturer === modelString);
  if (device) {
    debugLog(`[DEVICE MODEL] Exact match found: "${device.manufacturer}"`);
    return device;
  }
  
  // Try partial match (model string contains manufacturer string or vice versa)
  device = DEVICE_MODELS.find(d => 
    modelString.includes(d.manufacturer) || d.manufacturer.includes(modelString)
  );
  
  if (device) {
    debugLog(`[DEVICE MODEL] Partial match found: "${device.manufacturer}"`);
    return device;
  }
  
  debugLog(`[DEVICE MODEL] No match found for: "${modelString}"`);
  return null;
}

function getCurrentPowerSetting() {
  const checkedPower = document.querySelector('input[name="power"]:checked');
  return checkedPower ? checkedPower.value : "";
}

function getExternalAntennaSetting() {
  const checkedAntenna = document.querySelector('input[name="externalAntenna"]:checked');
  return checkedAntenna ? checkedAntenna.value : "";
}

/**
 * Get carpeater ignore settings from UI
 * @returns {{enabled: boolean, repeaterId: string|null}} Settings object
 */
function getCarpeaterIgnoreSettings() {
  const enabled = document.getElementById('carpeaterFilterEnabled')?.checked || false;
  const idInput = document.getElementById('carpeaterIdInput')?.value?.trim()?.toLowerCase() || '';
  
  // Validate hex format (2 chars, 00-FF)
  const isValidHex = /^[0-9a-f]{2}$/.test(idInput);
  
  return {
    enabled: enabled && isValidHex,
    repeaterId: (enabled && isValidHex) ? idInput : null
  };
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
  // Use state.deviceName which is set during connect from selfInfo.name
  if (state.deviceName && state.deviceName !== "[No device]") {
    return state.deviceName;
  }
  return MESHMAPPER_DEFAULT_WHO;
}

// ---- Geo-Auth Zone Checking ----

/**
 * Get valid GPS coordinates for zone checking with retry logic
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} retryDelayMs - Delay between retries in milliseconds (default: 5000)
 * @returns {Promise<Object|null>} GPS object {lat, lon, accuracy_m, timestamp} or null if failed
 */
async function getValidGpsForZoneCheck(maxRetries = 3, retryDelayMs = 5000) {
  debugLog(`[GPS] [GEO AUTH] Getting valid GPS for zone check (max retries: ${maxRetries})`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      debugLog(`[GPS] [GEO AUTH] GPS acquisition attempt ${attempt}/${maxRetries}`);
      
      const position = await getCurrentPosition();
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const accuracy_m = position.coords.accuracy;
      const timestamp = Math.floor(position.timestamp / 1000); // Convert to Unix seconds
      
      // Validate freshness (< 60 seconds old)
      const ageMs = Date.now() - position.timestamp;
      if (ageMs > 60000) {
        debugWarn(`[GPS] [GEO AUTH] GPS too stale: ${ageMs}ms old (max 60000ms)`);
        if (attempt < maxRetries) {
          debugLog(`[GPS] [GEO AUTH] Retrying in ${retryDelayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          continue;
        }
        return null;
      }
      
      // Validate accuracy (< 50 meters)
      if (accuracy_m > 50) {
        debugWarn(`[GPS] [GEO AUTH] GPS too inaccurate: ${accuracy_m}m (max 50m)`);
        if (attempt < maxRetries) {
          debugLog(`[GPS] [GEO AUTH] Retrying in ${retryDelayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          continue;
        }
        return null;
      }
      
      debugLog(`[GPS] [GEO AUTH] Valid GPS acquired: lat=${lat.toFixed(6)}, lon=${lng.toFixed(6)}, accuracy=${accuracy_m.toFixed(1)}m, age=${ageMs}ms`);
      return { lat, lon: lng, accuracy_m, timestamp };
      
    } catch (error) {
      debugError(`[GPS] [GEO AUTH] GPS acquisition failed (attempt ${attempt}/${maxRetries}): ${error.message}`);
      if (attempt < maxRetries) {
        debugLog(`[GPS] [GEO AUTH] Retrying in ${retryDelayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  
  debugError(`[GPS] [GEO AUTH] GPS acquisition failed after ${maxRetries} attempts`);
  return null;
}

/**
 * Check zone status via geo-auth API
 * @param {Object} coords - GPS coordinates object from getValidGpsForZoneCheck()
 * @param {number} coords.lat - Latitude
 * @param {number} coords.lon - Longitude
 * @param {number} coords.accuracy_m - GPS accuracy in meters
 * @param {number} coords.timestamp - Unix timestamp in seconds
 * @returns {Promise<Object|null>} Zone status response or null on error
 */
async function checkZoneStatus(coords) {
  const { lat, lon, accuracy_m, timestamp } = coords;
  debugLog(`[GEO AUTH] Checking zone status: lat=${lat.toFixed(6)}, lon=${lon.toFixed(6)}, accuracy=${accuracy_m.toFixed(1)}m, timestamp=${timestamp}`);
  
  try {
    // API expects lng, so convert lon to lng for the payload
    // Include app version for version checking
    const payload = { lat, lng: lon, accuracy_m, ver: APP_VERSION, timestamp };
    
    debugLog(`[GEO AUTH] Sending POST to ${GEO_AUTH_STATUS_URL}`);
    
    const response = await fetch(GEO_AUTH_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      debugError(`[GEO AUTH] Zone status API returned error status ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    debugLog(`[GEO AUTH] Zone status response:`, data);
    
    // Log detailed response based on result
    if (data.success && data.in_zone) {
      debugLog(`[GEO AUTH] ✅ In zone: ${data.zone.name} (${data.zone.code}), slots: ${data.zone.slots_available}/${data.zone.slots_max}, at_capacity: ${data.zone.at_capacity}`);
    } else if (data.success && !data.in_zone) {
      debugLog(`[GEO AUTH] ⚠️ Outside all zones, nearest: ${data.nearest_zone.name} (${data.nearest_zone.code}) at ${data.nearest_zone.distance_km}km`);
    } else if (!data.success) {
      // Only log non-outofdate failures here (outofdate logged in updateZoneStatusUI)
      if (data.reason !== "outofdate") {
        debugError(`[GEO AUTH] ❌ Zone check failed: reason=${data.reason}, message=${data.message}`);
      }
    }
    
    return data;
    
  } catch (error) {
    debugError(`[GEO AUTH] Network error during zone check: ${error.message}`);
    return null;
  }
}

/**
 * Request authentication with MeshMapper geo-auth API
 * Handles both connect (acquire session) and disconnect (release session)
 * @param {string} reason - Either "connect" (acquire session) or "disconnect" (release session)
 * @returns {Promise<boolean>} True if allowed to continue, false otherwise
 */
async function requestAuth(reason) {
  // Validate public key exists
  if (!state.devicePublicKey) {
    debugError("[AUTH] requestAuth called but no public key stored");
    return reason === "connect" ? false : true; // Fail closed on connect, allow disconnect
  }

  // Set status for connect requests
  if (reason === "connect") {
    setDynamicStatus("Authenticating to MeshMapper", STATUS_COLORS.info);
  }

  try {
    // Build base payload
    const payload = {
      key: MESHMAPPER_API_KEY,
      public_key: state.devicePublicKey,
      reason: reason
    };

    // For connect: add device metadata and GPS coords
    if (reason === "connect") {
      // Acquire fresh GPS for auth
      debugLog("[AUTH] Acquiring fresh GPS for auth request");
      const coords = await getValidGpsForZoneCheck();
      
      if (!coords) {
        debugError("[AUTH] Failed to acquire GPS for auth");
        state.disconnectReason = "gps_unavailable";
        return false;
      }
      
      // Add device metadata (bound to session at auth time)
      payload.who = getDeviceIdentifier();
      payload.ver = APP_VERSION;
      payload.power = getCurrentPowerSetting();
      payload.iata = state.currentZone?.code || WARDIVE_IATA_CODE;
      
      // Get short model name from database, or sanitized raw model if unknown
      const parsedModel = parseDeviceModel(state.deviceModel);
      const deviceConfig = findDeviceConfig(parsedModel);
      payload.model = deviceConfig?.shortName || parsedModel || "Unknown";
      
      // Add GPS coords (use lng for API, internally we use lon)
      payload.coords = {
        lat: coords.lat,
        lng: coords.lon,  // Convert lon → lng for API
        accuracy_m: coords.accuracy_m,
        timestamp: coords.timestamp
      };
      
      debugLog(`[AUTH] Connect request: public_key=${state.devicePublicKey.substring(0, 16)}..., who=${payload.who}, iata=${payload.iata}`);
    } else {
      // For disconnect: add session_id
      payload.session_id = state.wardriveSessionId;
      debugLog(`[AUTH] Disconnect request: public_key=${state.devicePublicKey.substring(0, 16)}..., session_id=${payload.session_id}`);
    }

    const response = await fetch(GEO_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    // Parse JSON body (even on error responses - server returns error codes in body)
    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      debugError(`[AUTH] Failed to parse response JSON: ${parseError.message}`);
      if (reason === "connect") {
        state.disconnectReason = "app_down";
        return false;
      }
      return true; // Allow disconnect to proceed
    }

    // Handle HTTP-level errors with known error codes in body
    if (!response.ok) {
      const serverMsg = data?.message || 'No message';
      
      // Check if server returned a known error code
      if (data && data.reason && REASON_MESSAGES[data.reason]) {
        debugLog(`[AUTH] Known error code: ${data.reason} - ${data.message || REASON_MESSAGES[data.reason]}`);
        // Don't add error log entry - the specific error will be shown in disconnect UI
        if (reason === "connect") {
          state.disconnectReason = data.reason;
          return false;
        }
        return true; // Allow disconnect to proceed
      }
      
      // Unknown error - log to error log and fail closed for connect
      addErrorLogEntry(`API returned error status ${response.status}: ${serverMsg}`, "AUTH");
      debugError(`[AUTH] API returned error status ${response.status}: ${serverMsg}`);
      if (reason === "connect") {
        addErrorLogEntry(`Auth failed: ${data?.reason || 'unknown'} - ${serverMsg}`, "AUTH");
        debugError(`[AUTH] Failing closed (denying connection) due to unknown API error: ${data?.reason || 'unknown'}`);
        state.disconnectReason = "app_down";
        return false;
      }
      return true; // Always allow disconnect to proceed
    }
    debugLog(`[AUTH] Response: success=${data.success}, tx_allowed=${data.tx_allowed}, rx_allowed=${data.rx_allowed}, session_id=${data.session_id || 'none'}, reason=${data.reason || 'none'}`);

    // Handle connect response
    if (reason === "connect") {
      // Check for full denial
      if (data.success === false) {
        debugLog(`[AUTH] Connect denied: ${data.reason} - ${data.message || ''}`);
        state.disconnectReason = data.reason || "auth_denied";
        return false;
      }
      
      // Success - store session info
      if (!data.session_id) {
        debugError("[AUTH] Auth returned success=true but session_id is missing");
        state.disconnectReason = "session_id_error";
        return false;
      }
      
      // Store session data
      state.wardriveSessionId = data.session_id;
      state.txAllowed = data.tx_allowed === true;
      state.rxAllowed = data.rx_allowed === true;
      state.sessionExpiresAt = data.expires_at || null;
      
      debugLog(`[AUTH] Session acquired: id=${state.wardriveSessionId}, tx=${state.txAllowed}, rx=${state.rxAllowed}, expires=${state.sessionExpiresAt}`);
      
      // Schedule heartbeat to keep session alive
      if (state.sessionExpiresAt) {
        scheduleHeartbeat(state.sessionExpiresAt);
      }
      
      // Check for RX-only scenario (zone_full)
      if (!state.txAllowed && state.rxAllowed) {
        debugLog(`[AUTH] RX-only mode: TX slots full, reason=${data.reason}`);
        // Don't set disconnectReason - this is a partial success
      }
      
      // Check for debug_mode flag (optional field)
      if (data.debug_mode === 1) {
        state.debugMode = true;
        debugLog(`[AUTH] 🐛 DEBUG MODE ENABLED by API`);
      } else {
        state.debugMode = false;
      }
      
      return true; // Success (full or RX-only)
    }
    
    // Handle disconnect response
    if (reason === "disconnect") {
      // Clear session state regardless of server response
      debugLog(`[AUTH] Clearing session state on disconnect`);
      state.wardriveSessionId = null;
      state.txAllowed = false;
      state.rxAllowed = false;
      state.sessionExpiresAt = null;
      state.debugMode = false;
      
      if (data.success === true && data.disconnected === true) {
        debugLog(`[AUTH] Disconnect confirmed by server`);
      } else if (data.success === false) {
        debugWarn(`[AUTH] Server reported disconnect error: ${data.reason} - ${data.message || ''}`);
        // Don't fail - we still clean up locally
      }
      
      return true; // Always return true for disconnect
    }

  } catch (error) {
    debugError(`[AUTH] Request failed: ${error.message}`);
    
    // Fail closed on network errors for connect
    if (reason === "connect") {
      debugError("[AUTH] Failing closed (denying connection) due to network error");
      state.disconnectReason = "app_down";
      return false;
    }
    
    // For disconnect, clear state even on error
    state.wardriveSessionId = null;
    state.txAllowed = false;
    state.rxAllowed = false;
    state.sessionExpiresAt = null;
    state.debugMode = false;
    
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
 * Queue a TX wardrive entry for batch submission
 * Called after RX listening window completes with final heard_repeats data
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} accuracy - GPS accuracy in meters
 * @param {string} heardRepeats - Heard repeats string (e.g., "4e(1.75),b7(-0.75)" or "None")
 * @param {number|null} noisefloor - Noisefloor value captured at ping time
 * @param {number} timestamp - Unix timestamp captured at ping time
 */
function queueTxEntry(lat, lon, accuracy, heardRepeats, noisefloor, timestamp) {
  debugLog(`[WARDRIVE QUEUE] queueTxEntry called: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, heard_repeats="${heardRepeats}", noisefloor=${noisefloor}, timestamp=${timestamp}`);
  
  // Build entry-only payload (wrapper added by submitWardriveData)
  const entry = {
    type: "TX",
    lat,
    lon,
    noisefloor,
    heard_repeats: heardRepeats,
    timestamp
  };
  
  // Add debug data if debug mode is enabled and repeater data is available
  if (state.debugMode && state.tempTxRepeaterData && state.tempTxRepeaterData.length > 0) {
    debugLog(`[WARDRIVE QUEUE] 🐛 Debug mode active - building debug_data array for TX`);
    
    const debugDataArray = [];
    
    for (const repeater of state.tempTxRepeaterData) {
      if (repeater.metadata) {
        const heardByte = repeater.repeaterId;  // First byte of path
        const debugData = buildDebugData(repeater.metadata, heardByte, repeater.repeaterId);
        debugDataArray.push(debugData);
        debugLog(`[WARDRIVE QUEUE] 🐛 Added debug data for TX repeater: ${repeater.repeaterId}`);
      }
    }
    
    if (debugDataArray.length > 0) {
      entry.debug_data = debugDataArray;
      debugLog(`[WARDRIVE QUEUE] 🐛 TX entry includes ${debugDataArray.length} debug_data entries`);
    }
    
    // Clear temp data after use
    state.tempTxRepeaterData = null;
  }
  
  // Queue entry for batch submission
  queueWardriveEntry(entry);
  debugLog(`[WARDRIVE QUEUE] TX entry queued: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, heard_repeats="${heardRepeats}"`);
  
  // Update map after queueing
  setTimeout(() => {
    const shouldRefreshMap = accuracy && accuracy < GPS_ACCURACY_THRESHOLD_M;
    
    if (shouldRefreshMap) {
      debugLog(`[UI] Refreshing coverage map (accuracy ${accuracy}m within threshold)`);
      scheduleCoverageRefresh(lat, lon);
    } else {
      debugLog(`[UI] Skipping map refresh (accuracy ${accuracy}m exceeds threshold)`);
    }
    
    // Unlock ping controls now that entry is queued
    unlockPingControls("after TX entry queued");
    
    // NOTE: Auto ping scheduling is handled in the RX listening window completion callback (line ~4939)
    // Do NOT schedule here - that would create duplicate timers causing rapid-fire pings
    debugLog("[TX/RX AUTO] TX entry queued, map refresh timer complete");
  }, MAP_REFRESH_DELAY_MS);
}

// ---- Wardrive Batch Queue System ----

/**
 * Queue a wardrive entry for batch submission
 * Entry must include 'type' field ("TX" or "RX")
 * @param {Object} entry - The wardrive entry with type, lat, lon, noisefloor, heard_repeats, timestamp, debug_data?
 */
function queueWardriveEntry(entry) {
  debugLog(`[WARDRIVE QUEUE] Queueing ${entry.type} entry`);
  
  wardriveQueue.messages.push(entry);
  debugLog(`[WARDRIVE QUEUE] Queue size: ${wardriveQueue.messages.length}/${API_BATCH_MAX_SIZE}`);
  
  // Start periodic flush timer if this is the first entry
  if (wardriveQueue.messages.length === 1 && !wardriveQueue.flushTimerId) {
    startWardriveFlushTimer();
  }
  
  // If TX type: start/reset 3-second flush timer
  if (entry.type === "TX") {
    scheduleWardriveFlush();
  }
  
  // If queue reaches max size: flush immediately
  if (wardriveQueue.messages.length >= API_BATCH_MAX_SIZE) {
    debugLog(`[WARDRIVE QUEUE] Queue reached max size (${API_BATCH_MAX_SIZE}), flushing immediately`);
    submitWardriveData();
  }
  
  // Queue depth is logged above for debugging - no need to show in dynamic status bar
}

/**
 * Schedule flush 3 seconds after TX ping
 * Resets timer if called again (coalesces rapid TX pings)
 */
function scheduleWardriveFlush() {
  debugLog(`[WARDRIVE QUEUE] Scheduling TX flush in ${API_TX_FLUSH_DELAY_MS}ms`);
  
  // Clear existing TX flush timer if present
  if (wardriveQueue.txFlushTimerId) {
    clearTimeout(wardriveQueue.txFlushTimerId);
    debugLog(`[WARDRIVE QUEUE] Cleared previous TX flush timer`);
  }
  
  // Schedule new TX flush
  wardriveQueue.txFlushTimerId = setTimeout(() => {
    debugLog(`[WARDRIVE QUEUE] TX flush timer fired`);
    submitWardriveData();
  }, API_TX_FLUSH_DELAY_MS);
}

/**
 * Start the 30-second periodic flush timer
 */
function startWardriveFlushTimer() {
  debugLog(`[WARDRIVE QUEUE] Starting periodic flush timer (${API_BATCH_FLUSH_INTERVAL_MS}ms)`);
  
  // Clear existing timer if present
  if (wardriveQueue.flushTimerId) {
    clearInterval(wardriveQueue.flushTimerId);
  }
  
  // Start periodic flush timer
  wardriveQueue.flushTimerId = setInterval(() => {
    if (wardriveQueue.messages.length > 0) {
      debugLog(`[WARDRIVE QUEUE] Periodic flush timer fired, flushing ${wardriveQueue.messages.length} messages`);
      submitWardriveData();
    }
  }, API_BATCH_FLUSH_INTERVAL_MS);
}

/**
 * Stop all flush timers (periodic and TX)
 */
function stopWardriveTimers() {
  debugLog(`[WARDRIVE QUEUE] Stopping all flush timers`);
  
  if (wardriveQueue.flushTimerId) {
    clearInterval(wardriveQueue.flushTimerId);
    wardriveQueue.flushTimerId = null;
    debugLog(`[WARDRIVE QUEUE] Periodic flush timer stopped`);
  }
  
  if (wardriveQueue.txFlushTimerId) {
    clearTimeout(wardriveQueue.txFlushTimerId);
    wardriveQueue.txFlushTimerId = null;
    debugLog(`[WARDRIVE QUEUE] TX flush timer stopped`);
  }
}

/**
 * Submit all queued wardrive entries to the API
 * Wraps entries with key/session_id and posts to WARDRIVE_ENDPOINT
 * Prevents concurrent submissions with isProcessing flag
 * Single retry on network failure
 * @returns {Promise<void>}
 */
async function submitWardriveData() {
  // Prevent concurrent submissions
  if (wardriveQueue.isProcessing) {
    debugWarn(`[WARDRIVE QUEUE] Submission already in progress, skipping`);
    return;
  }
  
  // Nothing to submit
  if (wardriveQueue.messages.length === 0) {
    debugLog(`[WARDRIVE QUEUE] Queue is empty, nothing to submit`);
    return;
  }
  
  // Validate session_id exists
  if (!state.wardriveSessionId) {
    debugError("[WARDRIVE QUEUE] Cannot submit: no session_id available");
    setDynamicStatus("Missing session ID", STATUS_COLORS.error);
    handleWardriveApiError("session_id_missing", "Cannot submit: no session_id");
    return;
  }
  
  // Lock processing
  wardriveQueue.isProcessing = true;
  debugLog(`[WARDRIVE QUEUE] Starting submission of ${wardriveQueue.messages.length} entries`);
  
  // Clear TX flush timer when submitting
  if (wardriveQueue.txFlushTimerId) {
    clearTimeout(wardriveQueue.txFlushTimerId);
    wardriveQueue.txFlushTimerId = null;
  }
  
  // Take all entries from queue
  const entries = [...wardriveQueue.messages];
  wardriveQueue.messages = [];
  
  // Count TX and RX entries for logging
  const txCount = entries.filter(e => e.type === "TX").length;
  const rxCount = entries.filter(e => e.type === "RX").length;
  debugLog(`[WARDRIVE QUEUE] Batch composition: ${txCount} TX, ${rxCount} RX`);
  
  // Build wrapper payload
  const payload = {
    key: MESHMAPPER_API_KEY,
    session_id: state.wardriveSessionId,
    data: entries
  };
  
  debugLog(`[WARDRIVE QUEUE] POST to ${WARDRIVE_ENDPOINT} with ${entries.length} entries`);
  
  // Attempt submission with single retry
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(WARDRIVE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      
      debugLog(`[WARDRIVE QUEUE] Response status: ${response.status} (attempt ${attempt})`);
      
      // Parse response
      const data = await response.json();
      debugLog(`[WARDRIVE QUEUE] Response data: ${JSON.stringify(data)}`);
      
      // Check for success
      if (data.success === true) {
        debugLog(`[WARDRIVE QUEUE] Submission successful: ${txCount} TX, ${rxCount} RX`);
        
        // Schedule heartbeat if expires_at is provided
        if (data.expires_at) {
          scheduleHeartbeat(data.expires_at);
        }
        
        // Clear status after successful post
        if (state.connection && !state.txRxAutoRunning) {
          setDynamicStatus("Idle");
        }
        
        // Success - exit retry loop
        wardriveQueue.isProcessing = false;
        return;
      }
      
      // Handle error response
      if (data.success === false) {
        debugError(`[WARDRIVE QUEUE] API error: ${data.reason || 'unknown'} - ${data.message || ''}`);
        handleWardriveApiError(data.reason, data.message);
        wardriveQueue.isProcessing = false;
        return;
      }
      
      // Unexpected response format
      debugError(`[WARDRIVE QUEUE] Unexpected response format: ${JSON.stringify(data)}`);
      lastError = new Error("Unexpected response format");
      
    } catch (error) {
      debugError(`[WARDRIVE QUEUE] Submission failed (attempt ${attempt}): ${error.message}`);
      lastError = error;
      
      // If first attempt failed, wait before retry
      if (attempt === 1) {
        debugLog(`[WARDRIVE QUEUE] Retrying in ${WARDRIVE_RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, WARDRIVE_RETRY_DELAY_MS));
      }
    }
  }
  
  // Both attempts failed
  debugError(`[WARDRIVE QUEUE] Submission failed after 2 attempts: ${lastError?.message}`);
  setDynamicStatus("Error: API submission failed", STATUS_COLORS.error);
  
  // Re-queue entries for next attempt (unless queue is full)
  if (wardriveQueue.messages.length + entries.length <= API_BATCH_MAX_SIZE) {
    wardriveQueue.messages.unshift(...entries);
    debugLog(`[WARDRIVE QUEUE] Re-queued ${entries.length} entries for next attempt`);
  } else {
    debugWarn(`[WARDRIVE QUEUE] Cannot re-queue entries, queue would exceed max size. ${entries.length} entries lost.`);
  }
  
  wardriveQueue.isProcessing = false;
}

/**
 * Get queue status for debugging
 * @returns {Object} Queue status object
 */
function getWardriveQueueStatus() {
  return {
    queueSize: wardriveQueue.messages.length,
    isProcessing: wardriveQueue.isProcessing,
    hasPeriodicTimer: wardriveQueue.flushTimerId !== null,
    hasTxTimer: wardriveQueue.txFlushTimerId !== null
  };
}

// ---- Heartbeat System ----

/**
 * Schedule heartbeat to fire before session expires
 * @param {number} expiresAt - Unix timestamp when session expires
 */
function scheduleHeartbeat(expiresAt) {
  // Cancel any existing heartbeat timer
  cancelHeartbeat();
  
  // Calculate when to send heartbeat (5 minutes before expiry)
  const now = Math.floor(Date.now() / 1000);
  const msUntilExpiry = (expiresAt - now) * 1000;
  const msUntilHeartbeat = msUntilExpiry - HEARTBEAT_BUFFER_MS;
  
  if (msUntilHeartbeat <= 0) {
    // Session is about to expire or already expired - send heartbeat immediately
    debugWarn(`[HEARTBEAT] Session expires in ${Math.floor(msUntilExpiry / 1000)}s, sending heartbeat immediately`);
    sendHeartbeat();
    return;
  }
  
  debugLog(`[HEARTBEAT] Scheduling heartbeat in ${Math.floor(msUntilHeartbeat / 1000)}s (session expires in ${Math.floor(msUntilExpiry / 1000)}s)`);
  
  state.heartbeatTimerId = setTimeout(() => {
    debugLog(`[HEARTBEAT] Heartbeat timer fired`);
    sendHeartbeat();
  }, msUntilHeartbeat);
}

/**
 * Cancel any scheduled heartbeat
 */
function cancelHeartbeat() {
  if (state.heartbeatTimerId) {
    clearTimeout(state.heartbeatTimerId);
    state.heartbeatTimerId = null;
    debugLog(`[HEARTBEAT] Heartbeat timer cancelled`);
  }
}

/**
 * Send heartbeat to keep session alive
 * Uses current GPS position for heartbeat coords
 * Single retry on network failure
 */
async function sendHeartbeat() {
  // Validate we have a session
  if (!state.wardriveSessionId) {
    debugWarn(`[HEARTBEAT] Cannot send heartbeat: no session_id`);
    return;
  }
  
  // Get current GPS position for heartbeat
  const currentCoords = state.lastFix;
  const coords = currentCoords ? {
    lat: currentCoords.coords.latitude,
    lon: currentCoords.coords.longitude,
    timestamp: Math.floor(Date.now() / 1000)
  } : null;
  
  // Build heartbeat payload
  const payload = {
    key: MESHMAPPER_API_KEY,
    session_id: state.wardriveSessionId,
    heartbeat: true,
    coords
  };
  
  debugLog(`[HEARTBEAT] Sending heartbeat: session_id=${state.wardriveSessionId}, coords=${coords ? `${coords.lat.toFixed(5)},${coords.lon.toFixed(5)}` : 'null'}`);
  
  // Attempt heartbeat with single retry
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(WARDRIVE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      
      debugLog(`[HEARTBEAT] Response status: ${response.status} (attempt ${attempt})`);
      
      // Parse response
      const data = await response.json();
      debugLog(`[HEARTBEAT] Response data: ${JSON.stringify(data)}`);
      
      // Check for success
      if (data.success === true) {
        debugLog(`[HEARTBEAT] Heartbeat successful`);
        
        // Schedule next heartbeat if expires_at is provided
        if (data.expires_at) {
          scheduleHeartbeat(data.expires_at);
        }
        
        return; // Success - exit
      }
      
      // Handle error response
      if (data.success === false) {
        debugError(`[HEARTBEAT] Heartbeat failed: ${data.reason || 'unknown'} - ${data.message || ''}`);
        handleWardriveApiError(data.reason, data.message);
        return;
      }
      
      // Unexpected response format
      debugError(`[HEARTBEAT] Unexpected response format: ${JSON.stringify(data)}`);
      lastError = new Error("Unexpected response format");
      
    } catch (error) {
      debugError(`[HEARTBEAT] Heartbeat failed (attempt ${attempt}): ${error.message}`);
      lastError = error;
      
      // If first attempt failed, wait before retry
      if (attempt === 1) {
        debugLog(`[HEARTBEAT] Retrying in ${WARDRIVE_RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, WARDRIVE_RETRY_DELAY_MS));
      }
    }
  }
  
  // Both attempts failed
  debugError(`[HEARTBEAT] Heartbeat failed after 2 attempts: ${lastError?.message}`);
  // Don't disconnect on heartbeat failure - the next data submission will also schedule a heartbeat
  // Just log the error and let the session expire naturally if needed
}

// ---- Wardrive API Error Handler ----

/**
 * Centralized error handler for wardrive API errors
 * Handles session expiry, revocation, and other error conditions
 * @param {string} reason - Error reason code from API
 * @param {string} message - Human-readable error message
 */
function handleWardriveApiError(reason, message) {
  debugError(`[WARDRIVE API] Error: reason=${reason}, message=${message}`);
  
  switch (reason) {
    case "session_expired":
    case "session_invalid":
    case "session_revoked":
    case "bad_session":
      // Session is no longer valid - disconnect immediately
      // Error message will be shown by BLE disconnect handler using REASON_MESSAGES
      debugError(`[WARDRIVE API] Session error (${reason}): triggering disconnect`);
      state.disconnectReason = reason;
      disconnect().catch(err => debugError(`[BLE] Disconnect after ${reason} failed: ${err.message}`));
      break;
      
    case "invalid_key":
    case "unauthorized":
    case "bad_key":
      // API key issue - disconnect immediately
      debugError(`[WARDRIVE API] Authorization error (${reason}): triggering disconnect`);
      state.disconnectReason = reason;
      disconnect().catch(err => debugError(`[BLE] Disconnect after ${reason} failed: ${err.message}`));
      break;
      
    case "session_id_missing":
      // Missing session - disconnect immediately
      debugError(`[WARDRIVE API] Missing session_id: triggering disconnect`);
      state.disconnectReason = "session_id_error";
      disconnect().catch(err => debugError(`[BLE] Disconnect after missing session_id failed: ${err.message}`));
      break;
    
    case "outside_zone":
      // User has moved outside their assigned zone - disconnect immediately
      debugError(`[WARDRIVE API] Outside zone: triggering disconnect`);
      state.disconnectReason = reason;
      disconnect().catch(err => debugError(`[BLE] Disconnect after ${reason} failed: ${err.message}`));
      break;
    
    case "zone_full":
      // Zone capacity changed during active session - disconnect immediately
      debugError(`[WARDRIVE API] Zone full during wardrive: triggering disconnect`);
      state.disconnectReason = reason;
      disconnect().catch(err => debugError(`[BLE] Disconnect after ${reason} failed: ${err.message}`));
      break;
      
    case "rate_limited":
      // Rate limited - show warning but don't disconnect
      debugWarn(`[WARDRIVE API] Rate limited: ${message}`);
      setDynamicStatus("Rate limited - slow down", STATUS_COLORS.warning);
      break;
      
    default:
      // Unknown error - log to error log but don't disconnect
      debugError(`[WARDRIVE API] Unknown error: ${reason} - ${message}`);
      setDynamicStatus(`API error: ${message || reason}`, STATUS_COLORS.error);
      break;
  }
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
  
  // Dump entire raw packet
  const rawHex = Array.from(data. raw).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  debugLog(`[RX PARSE] RAW Packet: ${rawHex}`);
  
  // Extract header byte from raw[0]
  const header = data.raw[0];
  const routeType = header & 0x03;
  
  // Calculate offset for Path Length based on route type
  let pathLengthOffset = 1;
  if (routeType === 0x00 || routeType === 0x03) {  // TransportFlood or TransportDirect
    pathLengthOffset = 5;  // Skip 4-byte transport codes
  }
  
  // Extract path length from calculated offset
  const pathLength = data.raw[pathLengthOffset];
  
  // Path data starts after path length byte
  const pathDataOffset = pathLengthOffset + 1;
  const pathBytes = Array.from(data.raw.slice(pathDataOffset, pathDataOffset + pathLength));
  
  // Derive first and last hops
  const firstHop = pathBytes. length > 0 ? pathBytes[0] : null;
  const lastHop = pathBytes.length > 0 ? pathBytes[pathLength - 1] : null;
  
  // Extract encrypted payload after path data
  const encryptedPayload = data.raw.slice(pathDataOffset + pathLength);
  
  debugLog(`[RX PARSE] Parsed metadata: header=0x${header.toString(16).padStart(2, '0')}, pathLength=${pathLength}, firstHop=${firstHop ?  '0x' + firstHop. toString(16).padStart(2, '0') : 'null'}, lastHop=${lastHop ? '0x' + lastHop.toString(16).padStart(2, '0') : 'null'}`);
  
  return {
    raw: data.raw,
    header:  header,
    pathLength: pathLength,
    pathBytes: pathBytes,
    firstHop: firstHop,
    lastHop: lastHop,
    snr: data.lastSnr,
    rssi: data.lastRssi,
    encryptedPayload: encryptedPayload
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
 * Check if a string is printable ASCII (basic ASCII only, no extended chars)
 * @param {string} str - String to check
 * @returns {boolean} True if all characters are printable ASCII (32-126)
 */
function isStrictAscii(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 32 || code > 126) {
      return false;
    }
  }
  return true;
}

/**
 * Calculate ratio of printable characters in a string
 * @param {string} str - String to analyze
 * @returns {number} Ratio of printable chars (0.0 to 1.0)
 */
function getPrintableRatio(str) {
  if (str.length === 0) return 0;
  let printableCount = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Printable: ASCII 32-126 or common whitespace (9=tab, 10=newline, 13=CR)
    if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) {
      printableCount++;
    }
  }
  return printableCount / str.length;
}

/**
 * Parse and validate ADVERT packet name field
 * @param {Uint8Array} payload - Encrypted payload from metadata
 * @returns {Object} {valid: boolean, name: string, reason: string}
 */
function parseAdvertName(payload) {
  try {
    // ADVERT structure: [32 bytes pubkey][4 bytes timestamp][64 bytes signature][appData...]
    // appData structure: [1 byte flags][optional 8 bytes lat/lon if flag set][name if flag set]
    const PUBKEY_SIZE = 32;
    const TIMESTAMP_SIZE = 4;
    const SIGNATURE_SIZE = 64;
    const APP_DATA_OFFSET = PUBKEY_SIZE + TIMESTAMP_SIZE + SIGNATURE_SIZE; // 100
    
    if (payload.length <= APP_DATA_OFFSET) {
      return { valid: false, name: '', reason: 'payload too short for appData' };
    }
    
    // Read flags byte from appData
    const flags = payload[APP_DATA_OFFSET];
    debugLog(`[RX FILTER] ADVERT flags: 0x${flags.toString(16).padStart(2, '0')}`);
    
    // Flag masks (from advert.js)
    const ADV_LATLON_MASK = 0x10;
    const ADV_NAME_MASK = 0x80;
    
    // Check if name is present
    if (!(flags & ADV_NAME_MASK)) {
      return { valid: false, name: '', reason: 'no name in advert' };
    }
    
    // Calculate name offset: skip flags byte and optional lat/lon
    let nameOffset = APP_DATA_OFFSET + 1; // +1 for flags byte (offset 101)
    if (flags & ADV_LATLON_MASK) {
      nameOffset += 8; // Skip 4 bytes lat + 4 bytes lon (offset 109)
      debugLog(`[RX FILTER] ADVERT has lat/lon, skipping 8 bytes`);
    }
    
    if (payload.length <= nameOffset) {
      return { valid: false, name: '', reason: 'payload too short for name' };
    }
    
    const nameBytes = payload.slice(nameOffset);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const name = decoder.decode(nameBytes).replace(/\0+$/, '').trim();
    
    debugLog(`[RX FILTER] ADVERT name extracted: "${name}" (${name.length} chars)`);
    
    if (name.length === 0) {
      return { valid: false, name: '', reason: 'name empty' };
    }
    
    // Check if name is printable
    const printableRatio = getPrintableRatio(name);
    debugLog(`[RX FILTER] ADVERT name printable ratio: ${(printableRatio * 100).toFixed(1)}%`);
    
    if (printableRatio < 0.9) {
      return { valid: false, name: name, reason: 'name not printable' };
    }
    
    // Check strict ASCII (no extended characters)
    if (!isStrictAscii(name)) {
      return { valid: false, name: name, reason: 'name contains non-ASCII chars' };
    }
    
    return { valid: true, name: name, reason: 'kept' };
    
  } catch (error) {
    debugError(`[RX FILTER] Error parsing ADVERT name: ${error.message}`);
    return { valid: false, name: '', reason: 'parse error' };
  }
}

/**
 * Validate RX packet for wardriving logging
 * @param {Object} metadata - Parsed metadata from parseRxPacketMetadata()
 * @returns {Promise<Object>} {valid: boolean, reason: string, channelName?: string, plaintext?: string}
 */
async function validateRxPacket(metadata) {
  try {
    // Log raw packet for debugging
    const rawHex = Array.from(metadata.raw).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    debugLog(`[RX FILTER] ========== VALIDATING PACKET ==========`);
    debugLog(`[RX FILTER] Raw packet (${metadata.raw.length} bytes): ${rawHex}`);
    debugLog(`[RX FILTER] Header: 0x${metadata.header.toString(16).padStart(2, '0')} | PathLength: ${metadata.pathLength} | SNR: ${metadata.snr}`);
    
    // VALIDATION 1: Check path length
    if (metadata.pathLength > MAX_RX_PATH_LENGTH) {
      debugLog(`[RX FILTER] ❌ DROPPED: pathLen>${MAX_RX_PATH_LENGTH} (${metadata.pathLength} hops)`);
      return { valid: false, reason: `pathLen>${MAX_RX_PATH_LENGTH}` };
    }
    debugLog(`[RX FILTER] ✓ Path length OK (${metadata.pathLength} ≤ ${MAX_RX_PATH_LENGTH})`);
    
    // VALIDATION 2: Check RSSI (Carpeater filter - drop extremely strong signals from OTHER repeaters)
    // Note: User-specified carpeater is already filtered earlier in handleTxLogging/handleRxLogging
    if (metadata.rssi >= MAX_RX_RSSI_THRESHOLD) {
      debugLog(`[RX FILTER] ❌ DROPPED: RSSI too strong (${metadata.rssi} ≥ ${MAX_RX_RSSI_THRESHOLD}) - possible carpeater (RSSI failsafe)`);
      return { valid: false, reason: 'carpeater-rssi' };
    }
    debugLog(`[RX FILTER] ✓ RSSI OK (${metadata.rssi} < ${MAX_RX_RSSI_THRESHOLD})`);
    
    // VALIDATION 3: Check packet type (only ADVERT and GRP_TXT)
    if (metadata.header === CHANNEL_GROUP_TEXT_HEADER) {
      debugLog(`[RX FILTER] Packet type: GRP_TXT (0x15)`);
      
      // GRP_TXT validation
      if (metadata.encryptedPayload.length < 3) {
        debugLog(`[RX FILTER] ❌ DROPPED: GRP_TXT payload too short (${metadata.encryptedPayload.length} bytes)`);
        return { valid: false, reason: 'payload too short' };
      }
      
      const channelHash = metadata.encryptedPayload[0];
      debugLog(`[RX FILTER] Channel hash: 0x${channelHash.toString(16).padStart(2, '0')}`);
      
      // Check if channel is in allowed list
      const channelInfo = RX_CHANNEL_MAP.get(channelHash);
      if (!channelInfo) {
        debugLog(`[RX FILTER] ❌ DROPPED: Unknown channel hash 0x${channelHash.toString(16).padStart(2, '0')}`);
        return { valid: false, reason: 'unknown channel hash' };
      }
      
      debugLog(`[RX FILTER] ✓ Channel matched: ${channelInfo.name}`);
      
      // Decrypt message
      const plaintext = await decryptGroupTextPayload(metadata.encryptedPayload, channelInfo.key);
      if (!plaintext) {
        debugLog(`[RX FILTER] ❌ DROPPED: Decryption failed`);
        return { valid: false, reason: 'decrypt failed' };
      }
      
      debugLog(`[RX FILTER] Decrypted message (${plaintext.length} chars): "${plaintext.substring(0, 60)}${plaintext.length > 60 ? '...' : ''}"}`);
      
      // Check printable ratio
      const printableRatio = getPrintableRatio(plaintext);
      debugLog(`[RX FILTER] Printable ratio: ${(printableRatio * 100).toFixed(1)}% (threshold: ${(RX_PRINTABLE_THRESHOLD * 100).toFixed(1)}%)`);
      
      if (printableRatio < RX_PRINTABLE_THRESHOLD) {
        debugLog(`[RX FILTER] ❌ DROPPED: plaintext not printable`);
        return { valid: false, reason: 'plaintext not printable' };
      }
      
      debugLog(`[RX FILTER] ✅ KEPT: GRP_TXT passed all validations`);
      return { valid: true, reason: 'kept', channelName: channelInfo.name, plaintext: plaintext };
      
    } else if (metadata.header === ADVERT_HEADER) {
      debugLog(`[RX FILTER] Packet type: ADVERT (0x11)`);
      
      // ADVERT validation
      const nameResult = parseAdvertName(metadata.encryptedPayload);
      
      if (!nameResult.valid) {
        debugLog(`[RX FILTER] ❌ DROPPED: ${nameResult.reason}`);
        return { valid: false, reason: nameResult.reason };
      }
      
      debugLog(`[RX FILTER] ✅ KEPT: ADVERT passed all validations (name="${nameResult.name}")`);
      return { valid: true, reason: 'kept' };
      
    } else {
      // Unsupported packet type
      debugLog(`[RX FILTER] ❌ DROPPED: unsupported ptype (header=0x${metadata.header.toString(16).padStart(2, '0')})`);
      return { valid: false, reason: 'unsupported ptype' };
    }
    
  } catch (error) {
    debugError(`[RX FILTER] ❌ Validation error: ${error.message}`);
    return { valid: false, reason: 'validation error' };
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
    
    // VALIDATION STEP 1.5: Check RSSI (Carpeater RSSI failsafe - drop extremely strong signals)
    if (metadata.rssi >= MAX_RX_RSSI_THRESHOLD) {
      debugLog(`[TX LOG] ❌ DROPPED: RSSI too strong (${metadata.rssi} ≥ ${MAX_RX_RSSI_THRESHOLD}) - possible carpeater (RSSI failsafe)`);
      rxLogState.dropCount++;
      rxLogState.carpeaterRssiDropCount++;
      updateCarpeaterErrorLog();
      updateRxLogSummary();
      return false; // Mark as handled (dropped)
    }
    debugLog(`[TX LOG] ✓ RSSI OK (${metadata.rssi} < ${MAX_RX_RSSI_THRESHOLD})`);
    
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
    
    // Check if this repeater is the user-specified carpeater to ignore
    const carpeaterSettings = getCarpeaterIgnoreSettings();
    if (carpeaterSettings.enabled && pathHex === carpeaterSettings.repeaterId) {
      rxLogState.dropCount++;
      rxLogState.carpeaterIgnoreDropCount++;
      updateRxLogSummary();
      debugLog(`[PING] ❌ Dropped: Repeater ${pathHex} is user-specified carpeater (ignore)`);
      return;
    }
    
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
    // NOTE: This is NOT a drop - direct packets are valid, just not useful for wardriving.
    if (metadata.pathLength === 0) {
      debugLog(`[RX LOG] Ignoring: no path (direct transmission, not via repeater)`);
      return;
    }
    
    // Get current GPS location (must have GPS before further validation)
    if (!state.lastFix) {
      rxLogState.dropCount++;
      updateRxLogSummary();
      debugLog(`[RX LOG] No GPS fix available, skipping entry`);
      return;
    }
    
    // PACKET FILTER: Validate packet before logging
    const validation = await validateRxPacket(metadata);
    if (!validation.valid) {
      rxLogState.dropCount++;
      
      // Special handling for RSSI failsafe carpeater drops (not user-specified drops)
      if (validation.reason === 'carpeater-rssi') {
        rxLogState.carpeaterRssiDropCount++;
        updateCarpeaterErrorLog();
      }
      
      updateRxLogSummary();
      const rawHex = Array.from(metadata.raw).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      debugLog(`[RX LOG] ❌ Packet dropped: ${validation.reason}`);
      debugLog(`[RX LOG] Dropped packet hex: ${rawHex}`);
      return;
    }
    
    // Extract LAST hop from path (the repeater that directly delivered to us)
    const lastHopId = metadata.lastHop;
    const repeaterId = lastHopId.toString(16).padStart(2, '0');
    
    // Check if this repeater is the user-specified carpeater to ignore
    const carpeaterSettings = getCarpeaterIgnoreSettings();
    if (carpeaterSettings.enabled && repeaterId === carpeaterSettings.repeaterId) {
      rxLogState.dropCount++;
      rxLogState.carpeaterIgnoreDropCount++;
      updateRxLogSummary();
      debugLog(`[RX LOG] ❌ Dropped: Repeater ${repeaterId} is user-specified carpeater (ignore)`);
      return;
    }
    
    debugLog(`[RX LOG] Packet heard via last hop: ${repeaterId}, SNR=${metadata.snr}, path_length=${metadata.pathLength}`);
    debugLog(`[RX LOG] ✅ Packet validated and passed filter`);
    
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
      firstLocation: { lat: currentLocation.lat, lon: currentLocation.lon },
      bestObservation: {
        snr,
        rssi,
        pathLength,
        header,
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        noisefloor: state.lastNoiseFloor ?? null,
        timestamp: Math.floor(Date.now() / 1000),
        metadata: metadata  // Store full metadata for debug mode
      },
      timeoutId: null  // Timer ID for 30-second timeout flush
    };
    state.rxBatchBuffer.set(repeaterId, buffer);
    debugLog(`[RX BATCH] First observation for repeater ${repeaterId}: SNR=${snr}, noisefloor=${buffer.bestObservation.noisefloor}`);
    
    // Start 30-second timeout timer for this repeater
    buffer.timeoutId = setTimeout(() => {
      debugLog(`[RX BATCH] 30s timeout triggered for repeater ${repeaterId}`);
      flushRepeater(repeaterId);
    }, RX_BATCH_TIMEOUT_MS);
    debugLog(`[RX BATCH] Started 30s timeout timer for repeater ${repeaterId}`);
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
        noisefloor: state.lastNoiseFloor ?? null,
        timestamp: Math.floor(Date.now() / 1000),
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
    buffer.firstLocation.lon
  );
  
  debugLog(`[RX BATCH] Distance check for repeater ${repeaterId}: ${distance.toFixed(2)}m from first observation (threshold=${RX_BATCH_DISTANCE_M}m)`);
  
  if (distance >= RX_BATCH_DISTANCE_M) {
    debugLog(`[RX BATCH] Distance threshold met for repeater ${repeaterId}, flushing`);
    flushRepeater(repeaterId);
  }
}

/**
 * Check all active RX batches for distance threshold on GPS position update
 * Called from GPS watch callback when position changes
 * @param {Object} currentLocation - Current GPS location {lat, lon}
 */
function checkAllRxBatchesForDistanceTrigger(currentLocation) {
  if (state.rxBatchBuffer.size === 0) {
    return; // No active batches to check
  }
  
  debugLog(`[RX BATCH] GPS position updated, checking ${state.rxBatchBuffer. size} active batches for distance trigger`);
  
  const repeatersToFlush = [];
  
  // Check each active batch
  for (const [repeaterId, buffer] of state.rxBatchBuffer. entries()) {
    const distance = calculateHaversineDistance(
      currentLocation.lat,
      currentLocation.lon,
      buffer.firstLocation.lat,
      buffer.firstLocation.lon
    );
    
    debugLog(`[RX BATCH] Distance check for repeater ${repeaterId}:  ${distance.toFixed(2)}m from first observation (threshold=${RX_BATCH_DISTANCE_M}m)`);
    
    if (distance >= RX_BATCH_DISTANCE_M) {
      debugLog(`[RX BATCH] Distance threshold met for repeater ${repeaterId}, marking for flush`);
      repeatersToFlush.push(repeaterId);
    }
  }
  
  // Flush all repeaters that met the distance threshold
  for (const repeaterId of repeatersToFlush) {
    flushRepeater(repeaterId);
  }
  
  if (repeatersToFlush.length > 0) {
    debugLog(`[RX BATCH] Flushed ${repeatersToFlush.length} repeater(s) due to GPS movement`);
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
  
  // Clear timeout timer if it exists
  if (buffer.timeoutId) {
    clearTimeout(buffer.timeoutId);
    buffer.timeoutId = null;
    debugLog(`[RX BATCH] Cleared timeout timer for repeater ${repeaterId}`);
  }
  
  const best = buffer.bestObservation;
  
  // Build API entry using BEST observation's location
  const entry = {
    repeater_id: repeaterId,
    location: { lat: best.lat, lon: best.lon },  // Location of BEST SNR packet
    snr: best.snr,
    rssi: best.rssi,
    pathLength: best.pathLength,
    header: best.header,
    noisefloor: best.noisefloor,  // Noisefloor captured at observation time
    timestamp: best.timestamp,
    metadata: best.metadata  // For debug mode
  };
  
  debugLog(`[RX BATCH] Posting repeater ${repeaterId}: snr=${best.snr}, location=${best.lat.toFixed(5)},${best.lon.toFixed(5)}`);
  
  // Queue for API posting
  queueRxEntry(entry);
  
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
function queueRxEntry(entry) {
  // Validate session_id exists
  if (!state.wardriveSessionId) {
    debugWarn(`[RX BATCH API] Cannot queue: no session_id available`);
    return;
  }
  
  // Format heard_repeats as "repeater_id(snr)" - e.g., "4e(12.0)"
  // Use absolute value and format with one decimal place
  const heardRepeats = `${entry.repeater_id}(${Math.abs(entry.snr).toFixed(1)})`;
  
  // Build entry-only payload (wrapper added by submitWardriveData)
  const rxEntry = {
    type: "RX",
    lat: entry.location.lat,
    lon: entry.location.lon,
    noisefloor: entry.noisefloor ?? null,
    heard_repeats: heardRepeats,
    timestamp: entry.timestamp
  };
  
  // Add debug data if debug mode is enabled
  if (state.debugMode && entry.metadata) {
    debugLog(`[RX BATCH API] 🐛 Debug mode active - adding debug_data for RX`);
    
    // For RX, parsed_heard is the LAST byte of path
    const lastHopId = entry.metadata.lastHop;
    const heardByte = lastHopId.toString(16).padStart(2, '0').toUpperCase();
    
    const debugData = buildDebugData(entry.metadata, heardByte, entry.repeater_id);
    rxEntry.debug_data = debugData;
    
    debugLog(`[RX BATCH API] 🐛 RX entry includes debug_data for repeater ${entry.repeater_id}`);
  }
  
  // Queue entry for batch submission
  queueWardriveEntry(rxEntry);
  debugLog(`[RX BATCH API] RX entry queued: repeater=${entry.repeater_id}, snr=${entry.snr.toFixed(1)}, location=${entry.location.lat.toFixed(5)},${entry.location.lon.toFixed(5)}`);
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
  txLogCount.textContent = `Pings: ${count}`;
  
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
  rxLogCount.textContent = `Handled: ${count}  Drop: ${rxLogState.dropCount}`;
  
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
    errorLogCount.textContent = 'Events: 0';
    errorLogLastTime.textContent = 'No errors';
    errorLogLastTime.classList.add('hidden');
    if (errorLogLastError) {
      errorLogLastError.textContent = '—';
    }
    debugLog('[ERROR LOG] Summary updated: no entries');
    return;
  }
  
  const lastEntry = errorLogState.entries[errorLogState.entries.length - 1];
  errorLogCount.textContent = `Events: ${count}`;
  
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

/**
 * Update or add carpeater error log entry with current drop count
 * This creates a persistent error entry that updates in place rather than creating multiple entries
 */
function updateCarpeaterErrorLog() {
  const message = `Possible Carpeater Detected, Dropped ${rxLogState.carpeaterRssiDropCount} packet${rxLogState.carpeaterRssiDropCount !== 1 ? 's' : ''}`;
  const source = 'RX FILTER';
  
  // Find existing carpeater entry by checking if message starts with "Possible Carpeater Detected"
  const existingIndex = errorLogState.entries.findIndex(entry => 
    entry.source === source && entry.message.startsWith('Possible Carpeater Detected')
  );
  
  if (existingIndex !== -1) {
    // Update existing entry
    errorLogState.entries[existingIndex].message = message;
    errorLogState.entries[existingIndex].timestamp = new Date().toISOString();
    debugLog(`[ERROR LOG] Updated carpeater entry: ${rxLogState.carpeaterDropCount} drops`);
    
    // Full re-render to update the displayed message
    renderErrorLogEntries(true);
    updateErrorLogSummary();
  } else {
    // Create new entry (first carpeater detection)
    addErrorLogEntry(message, source);
  }
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
  
  // Early guard: prevent concurrent ping execution (critical for preventing BLE GATT errors)
  if (state.pingInProgress) {
    debugLog("[PING] Ping already in progress, ignoring duplicate call");
    return;
  }
  state.pingInProgress = true;
  
  try {
    // Check cooldown only for manual pings
    if (manual && isInCooldown()) {
      const remainingSec = getRemainingCooldownSeconds();
      debugLog(`[PING] Manual ping blocked by cooldown (${remainingSec}s remaining)`);
      setDynamicStatus(`Wait ${remainingSec}s before sending another ping`, STATUS_COLORS.warning);
      state.pingInProgress = false;
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
    // Refresh radio stats (noise floor) before attempting ping so UI shows fresh value
    if (state.connection && state.lastNoiseFloor !== null) {
      // Only attempt refresh if firmware supports it (detected on connect)
      debugLog("[PING] Refreshing radio stats before ping");
      try {
        // Don't pass timeout - avoids library timeout bug
        const stats = await state.connection.getRadioStats(null);
        debugLog(`[PING] getRadioStats returned: ${JSON.stringify(stats)}`);
        if (stats && typeof stats.noiseFloor !== 'undefined') {
          state.lastNoiseFloor = stats.noiseFloor;
          debugLog(`[PING] Radio stats refreshed before ping: noiseFloor=${state.lastNoiseFloor}`);
        } else {
          debugWarn(`[PING] Radio stats response missing noiseFloor field: ${JSON.stringify(stats)}`);
        }
      } catch (e) {
        // Silently skip on error - firmware might not support it
        debugLog(`[PING] getRadioStats skipped: ${e && e.message ? e.message : String(e)}`);
      }
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
      state.pingInProgress = false;
      return;
    }
    
    const { lat, lon, accuracy } = coords;

    // VALIDATION: Distance check (must be ≥ 25m from last successful ping)
    // Note: Zone validation happens server-side via /wardrive endpoint (Phase 4.4)
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
      
      state.pingInProgress = false;
      return;
    }
    debugLog("[PING] Distance validation passed");

    // Both validations passed - execute ping operation (Mesh + API)
    debugLog("[PING] All validations passed, executing ping operation");
    
    // pingInProgress already set at function start - just update UI controls
    updateControlsForCooldown();
    debugLog("[PING] Ping controls locked (pingInProgress=true)");
    
    const payload = buildPayload(lat, lon);
    debugLog(`[PING] Sending ping to channel: "${payload}"`);

    const ch = await ensureChannel();
    
    // Capture GPS coordinates at ping time - these will be used for API post after 10s delay
    state.capturedPingCoords = { 
      lat, 
      lon, 
      accuracy, 
      noisefloor: state.lastNoiseFloor ?? null,
      timestamp: Math.floor(Date.now() / 1000)
    };
    debugLog(`[PING] GPS coordinates captured at ping time: lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)}, accuracy=${accuracy}m, noisefloor=${state.capturedPingCoords.noisefloor}, timestamp=${state.capturedPingCoords.timestamp}`);
    
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
          // Always schedule a fresh auto ping from the full interval
          // (whether this was a manual or auto ping, the timer restarts)
          debugLog("[TX/RX AUTO] Scheduling next auto ping after ping completion");
          // Clear any paused timer state since we're restarting fresh
          state.pausedAutoTimerRemainingMs = null;
          scheduleNextAutoPing();
        } else {
          debugLog("[UI] Setting dynamic status to Idle (manual mode)");
          setDynamicStatus("Idle");
        }
      }
      
      // Unlock ping controls immediately (don't wait for API)
      unlockPingControls("after RX listening window completion");
      
      // Queue TX entry for batch submission (uses captured coordinates, not current GPS position)
      if (capturedCoords) {
        const { lat: apiLat, lon: apiLon, accuracy: apiAccuracy, noisefloor: apiNoisefloor, timestamp: apiTimestamp } = capturedCoords;
        debugLog(`[WARDRIVE QUEUE] Queueing TX entry: lat=${apiLat.toFixed(5)}, lon=${apiLon.toFixed(5)}, accuracy=${apiAccuracy}m, noisefloor=${apiNoisefloor}, timestamp=${apiTimestamp}`);
        
        // Queue TX entry (will be submitted with next batch)
        queueTxEntry(apiLat, apiLon, apiAccuracy, heardRepeatsStr, apiNoisefloor, apiTimestamp);
      } else {
        // This should never happen as coordinates are always captured before ping
        debugError(`[WARDRIVE QUEUE] CRITICAL: No captured ping coordinates available for API post - this indicates a logic error`);
        debugError(`[WARDRIVE QUEUE] Skipping TX entry queue to avoid posting incorrect coordinates`);
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
  
  // Unlock wardrive settings after auto mode stops
  unlockWardriveSettings();
  debugLog("[TX/RX AUTO] Wardrive settings unlocked after auto mode stop");
  
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
  acquireWakeLock().catch((e) => debugWarn("[RX AUTO] Wake lock failed (non-critical):", e?.message || String(e)));
  
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
  
  // Clear any existing timer to prevent accumulation (CRITICAL: prevents duplicate timers)
  if (state.autoTimerId) {
    debugLog(`[TX/RX AUTO] Clearing existing timer (id=${state.autoTimerId}) before scheduling new one`);
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  
  const intervalMs = getSelectedIntervalMs();
  debugLog(`[TX/RX AUTO] Scheduling next auto ping in ${intervalMs}ms`);
  
  // Start countdown immediately (skipReason may be set if ping was skipped)
  startAutoCountdown(intervalMs);
  
  // Schedule the next ping
  state.autoTimerId = setTimeout(() => {
    debugLog(`[TX/RX AUTO] Auto ping timer fired (id=${state.autoTimerId})`);
    
    // Double-check guards before sending ping
    if (!state.txRxAutoRunning) {
      debugLog("[TX/RX AUTO] Auto mode no longer running, ignoring timer");
      return;
    }
    if (state.pingInProgress) {
      debugLog("[TX/RX AUTO] Ping already in progress, ignoring timer");
      return;
    }
    
    // Clear skip reason before next attempt
    state.skipReason = null;
    debugLog("[TX/RX AUTO] Sending auto ping");
    sendPing(false).catch((e) => debugError("[TX/RX AUTO] Scheduled auto ping error:", e?.message || String(e)));
  }, intervalMs);
  
  debugLog(`[TX/RX AUTO] New timer scheduled (id=${state.autoTimerId})`);
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
  
  // Lock wardrive settings during auto mode
  lockWardriveSettings();
  debugLog("[TX/RX AUTO] Wardrive settings locked during auto mode");
  
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
  acquireWakeLock().catch((e) => debugWarn("[TX/RX AUTO] Wake lock failed (non-critical):", e?.message || String(e)));

  // Send first ping immediately
  debugLog("[TX/RX AUTO] Sending initial auto ping");
  sendPing(false).catch((e) => debugError("[TX/RX AUTO] Initial auto ping error:", e?.message || String(e)));
}

// ---- Device Auto-Power Configuration ----

/**
 * Automatically configure radio power based on detected device model
 * Called after deviceQuery() in connect() flow
 * Updates power radio selection and label based on device database lookup
 */
async function autoSetPowerLevel() {
  debugLog("[DEVICE MODEL] Starting auto-power configuration");
  
  // Get power label status element for updating
  const powerLabelStatus = document.getElementById("powerLabelStatus");
  
  if (!state.deviceModel || state.deviceModel === "-") {
    debugLog("[DEVICE MODEL] No device model available, skipping auto-power");
    return;
  }
  
  // Parse device model (strip build suffix)
  const cleanedModel = parseDeviceModel(state.deviceModel);
  
  // Look up device in database
  const deviceConfig = findDeviceConfig(cleanedModel);
  
  if (deviceConfig) {
    // Known device - auto-configure power
    debugLog(`[DEVICE MODEL] Known device found: ${deviceConfig.shortName}`);
    debugLog(`[DEVICE MODEL] Auto-configuring power to ${deviceConfig.power.toFixed(1)}w`);
    
    // Select the matching power radio button
    // Format power value to match HTML format exactly (e.g., 1.0 → "1.0w", 0.3 → "0.3w")
    // Use toFixed(1) to ensure one decimal place
    const powerValue = `${deviceConfig.power.toFixed(1)}w`;
    debugLog(`[DEVICE MODEL] Looking for power radio with value: ${powerValue}`);
    const powerRadio = document.querySelector(`input[name="power"][value="${powerValue}"]`);
    
    if (powerRadio) {
      powerRadio.checked = true;
      state.autoPowerSet = true;
      
      // Show auto-configured power display, hide manual selection and placeholder
      const powerPlaceholder = document.getElementById("powerPlaceholder");
      const powerAutoDisplay = document.getElementById("powerAutoDisplay");
      const powerManualSelection = document.getElementById("powerManualSelection");
      const powerAutoValue = document.getElementById("powerAutoValue");
      
      if (powerPlaceholder) {
        powerPlaceholder.style.display = "none";
      }
      if (powerAutoDisplay) {
        powerAutoDisplay.classList.remove("hidden");
        powerAutoDisplay.style.display = "flex";
      }
      if (powerManualSelection) {
        powerManualSelection.classList.add("hidden");
        powerManualSelection.style.display = "none";
      }
      if (powerAutoValue) {
        powerAutoValue.textContent = powerValue;
      }
      
      // Update label to show "⚡ Auto"
      if (powerLabelStatus) {
        powerLabelStatus.textContent = "⚡ Auto";
        powerLabelStatus.className = "text-emerald-400";
      }
      
      // Show status message
      setDynamicStatus(`Auto-configured: ${deviceConfig.shortName} at ${deviceConfig.power}w`, STATUS_COLORS.success);
      
      // Update controls to enable ping buttons now that power is selected
      updateControlsForCooldown();
      
      debugLog(`[DEVICE MODEL] ✅ Auto-power configuration complete: ${powerValue}`);
    } else {
      debugError(`[DEVICE MODEL] Power radio button not found for value: ${powerValue}`);
      debugLog(`[DEVICE MODEL] Available power buttons:`);
      document.querySelectorAll('input[name="power"]').forEach(radio => {
        debugLog(`[DEVICE MODEL]   - ${radio.value}`);
      });
      state.autoPowerSet = false;
    }
    
    // Update device model display to show short name
    if (deviceModelEl) {
      deviceModelEl.textContent = deviceConfig.shortName;
    }
    
  } else {
    // Unknown device - log to error log and require manual selection
    debugLog(`[DEVICE MODEL] Unknown device: ${state.deviceModel}`);
    addErrorLogEntry(`Unrecognized hardware model: ${state.deviceModel}`, "DEVICE MODEL");
    state.autoPowerSet = false;
    
    // Hide auto-configured power display and placeholder, show manual selection
    const powerPlaceholder = document.getElementById("powerPlaceholder");
    const powerAutoDisplay = document.getElementById("powerAutoDisplay");
    const powerManualSelection = document.getElementById("powerManualSelection");
    
    if (powerPlaceholder) {
      powerPlaceholder.style.display = "none";
    }
    if (powerAutoDisplay) {
      powerAutoDisplay.classList.add("hidden");
      powerAutoDisplay.style.display = "none";
    }
    if (powerManualSelection) {
      powerManualSelection.classList.remove("hidden");
      powerManualSelection.style.display = "flex";
    }
    
    // Update label to show "⚠️ Required"
    if (powerLabelStatus) {
      powerLabelStatus.textContent = "⚠️ Required";
      powerLabelStatus.className = "text-amber-400";
    }
    
    // Update device model display to show "Unknown"
    if (deviceModelEl) {
      deviceModelEl.textContent = "Unknown";
    }
    
    // Don't show status message here - will be shown after connection completes
    
    debugLog("[DEVICE MODEL] Auto-power skipped, user must select power manually");
  }
}

// ---- BLE connect / disconnect ----
async function connect() {
  debugLog("[BLE] connect() called");
  if (!("bluetooth" in navigator)) {
    debugError("[BLE] Web Bluetooth not supported");
    alert("Web Bluetooth not supported in this browser.");
    return;
  }
  setConnectButtonDisabled(true);
  
  // CLEAR all logs immediately on connect (new session)
  txLogState.entries = [];
  renderTxLogEntries(true);
  updateTxLogSummary();
  
  rxLogState.entries = [];
  rxLogState.dropCount = 0;
  rxLogState.carpeaterIgnoreDropCount = 0;
  rxLogState.carpeaterRssiDropCount = 0;
  renderRxLogEntries(true);
  updateRxLogSummary();
  
  errorLogState.entries = [];
  renderErrorLogEntries(true);
  updateErrorLogSummary();
  
  debugLog("[BLE] All logs cleared on connect start (new session)");
  
  // Clear any previous disconnect reason so error status doesn't persist
  state.disconnectReason = null;
  
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
      setConnectButtonDisabled(false);
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
      
      // Store device name from selfInfo
      state.deviceName = selfInfo?.name || "[No device]";
      debugLog(`[BLE] Device name stored: ${state.deviceName}`);
      
      // Get device model from deviceQuery (contains manufacturerModel)
      debugLog("[BLE] Requesting device info via deviceQuery");
      try {
        const deviceInfo = await conn.deviceQuery(1);
        debugLog(`[BLE] deviceQuery response received: firmwareVer=${deviceInfo?.firmwareVer}, model=${deviceInfo?.manufacturerModel}`);
        state.deviceModel = deviceInfo?.manufacturerModel || "-";
        debugLog(`[BLE] Device model stored: ${state.deviceModel}`);
        // Parse firmware version for feature detection
        state.firmwareVersion = parseFirmwareVersion(state.deviceModel);
        debugLog(`[BLE] Parsed firmware version: ${state.firmwareVersion ? `v${state.firmwareVersion.major}.${state.firmwareVersion.minor}.${state.firmwareVersion.patch}` : 'null (nightly/unparseable)'}`);
        // Don't update deviceModelEl here - autoSetPowerLevel() will set it to shortName or "Unknown"
      } catch (e) {
        debugError(`[BLE] deviceQuery failed: ${e && e.message ? e.message : e}`);
        state.deviceModel = "-";
        state.firmwareVersion = null;
        if (deviceModelEl) deviceModelEl.textContent = "-";
      }
      
      // Auto-configure radio power based on device model
      await autoSetPowerLevel();
      
      // Check if firmware supports noisefloor before requesting
      if (firmwareSupportsNoisefloor(state.firmwareVersion)) {
        // Immediately attempt to read radio stats (noise floor) on connect
        debugLog("[BLE] Requesting radio stats on connect");
        try {
          // 5 second timeout as safety fallback
          const stats = await conn.getRadioStats(5000);
          debugLog(`[BLE] getRadioStats returned: ${JSON.stringify(stats)}`);
          if (stats && typeof stats.noiseFloor !== 'undefined') {
            state.lastNoiseFloor = stats.noiseFloor;
            debugLog(`[BLE] Radio stats acquired on connect: noiseFloor=${state.lastNoiseFloor}`);
          } else {
            debugWarn(`[BLE] Radio stats response missing noiseFloor field: ${JSON.stringify(stats)}`);
            state.lastNoiseFloor = null;
          }
        } catch (e) {
          // Timeout likely means firmware doesn't support GetStats command yet
          if (e && e.message && e.message.includes('timeout')) {
            debugLog(`[BLE] getRadioStats not supported by companion firmware (timeout)`);
          } else {
            debugWarn(`[BLE] getRadioStats failed on connect: ${e && e.message ? e.message : String(e)}`);
          }
          state.lastNoiseFloor = null; // Show '-' instead of 'ERR' for unsupported feature
        }
        
        // Start periodic noise floor updates if feature is supported
        if (state.lastNoiseFloor !== null) {
          startNoiseFloorUpdates();
          debugLog("[BLE] Started periodic noise floor updates (5s interval)");
        } else {
          debugLog("[BLE] Noise floor updates not started (feature unsupported by firmware)");
        }
      } else {
        // Firmware too old for noisefloor
        const versionStr = state.firmwareVersion ? `v${state.firmwareVersion.major}.${state.firmwareVersion.minor}.${state.firmwareVersion.patch}` : 'unknown';
        debugLog(`[BLE] Skipping noisefloor - firmware ${versionStr} does not support it (requires 1.11.0+)`);
        state.lastNoiseFloor = null;
        addErrorLogEntry(`Noisefloor requires firmware 1.11.0+ (detected: ${versionStr})`, "Firmware Version");
      }
      
      updateAutoButton();
      try { 
        await conn.syncDeviceTime?.(); 
        debugLog("[BLE] Device time synced");
      } catch { 
        debugLog("[BLE] Device time sync not available or failed");
      }
      try {
        // Request auth immediately after time sync, before channel setup and GPS init
        // Note: requestAuth acquires fresh GPS internally
        const allowed = await requestAuth("connect");
        if (!allowed) {
          debugWarn("[AUTH] Auth request denied, disconnecting");
          // disconnectReason already set by requestAuth()
          // Status message will be set by disconnected event handler based on disconnectReason
          // Disconnect after a brief delay to ensure "Acquiring wardriving slot" is visible
          setTimeout(() => {
            disconnect().catch(err => debugError(`[BLE] Disconnect after auth denial failed: ${err.message}`));
          }, 1500);
          return;
        }
        
        // Auth passed - check if full access or RX-only
        if (state.txAllowed && state.rxAllowed) {
          setDynamicStatus("Acquired wardriving slot", STATUS_COLORS.success);
          debugLog("[AUTH] Full access granted (TX + RX)");
        } else if (state.rxAllowed) {
          setDynamicStatus("TX slots full - RX only", STATUS_COLORS.warning);
          debugLog("[AUTH] RX-only access granted (TX slots full)");
        }
        debugLog(`[AUTH] Session acquired: tx=${state.txAllowed}, rx=${state.rxAllowed}`);
        
        // Proceed with channel setup and GPS initialization
        await ensureChannel();
        
        // Start unified RX listening after channel setup
        startUnifiedRxListening();
        debugLog("[BLE] Unified RX listener started on connect");
        
        // GPS initialization (primeGpsOnce for watch mode)
        // Note: Fresh GPS was already acquired by requestAuth, this starts continuous watching
        debugLog("[BLE] Starting GPS watch mode");
        await primeGpsOnce();
        
        // Connection complete - show status based on TX+RX vs RX-only
        if (state.txAllowed && state.rxAllowed) {
          setConnStatus("Connected", STATUS_COLORS.success);
        } else if (state.rxAllowed) {
          setConnStatus("Connected (RX Only)", STATUS_COLORS.warning);
        }
        
        // If device is unknown and power not selected, show warning message
        if (!state.autoPowerSet && !getCurrentPowerSetting()) {
          setDynamicStatus("Unknown device - select power manually", STATUS_COLORS.warning, true);
          debugLog("[BLE] Connection complete - showing unknown device warning");
        } else {
          setDynamicStatus("Idle"); // Clear dynamic status to em dash
        }
        
        // Note: Settings are NOT locked on connect - only when auto mode starts
        // This allows users to change power after connection if device was unknown
        
        // Immediate zone check after connect to update slot display
        debugLog("[GEO AUTH] Performing zone check after successful connect");
        const coords = await getValidGpsForZoneCheck();
        if (coords) {
          const result = await checkZoneStatus(coords);
          if (result.success && result.zone) {
            state.currentZone = result.zone;
            state.lastZoneCheckCoords = { lat: coords.lat, lon: coords.lon };
            updateZoneStatusUI(result);
            debugLog(`[GEO AUTH] Post-connect zone check: ${result.zone.name}, slots: ${result.zone.slots_available}/${result.zone.slots_max}`);
          }
        }
        
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
      
      // Guard against duplicate disconnect events - if connection is already null, skip
      if (state.connection === null) {
        debugLog("[BLE] Ignoring duplicate disconnect event (connection already null)");
        return;
      }
      
      // Always set connection bar to "Disconnected"
      setConnStatus("Disconnected", STATUS_COLORS.error);
      
      // Set dynamic status based on disconnect reason (WITHOUT "Disconnected:" prefix)
      // First check if reason has a mapped message in REASON_MESSAGES (for API reason codes)
      if (state.disconnectReason && REASON_MESSAGES[state.disconnectReason]) {
        debugLog(`[BLE] Branch: known reason code (${state.disconnectReason})`);
        const errorMsg = REASON_MESSAGES[state.disconnectReason];
        addErrorLogEntry(errorMsg, "CONNECTION");
        setDynamicStatus(errorMsg, STATUS_COLORS.error, true);
        debugLog(`[BLE] Setting terminal status for reason: ${state.disconnectReason}`);
      } else if (state.disconnectReason === "capacity_full") {
        debugLog("[BLE] Branch: capacity_full");
        addErrorLogEntry("MeshMapper server at capacity - too many active connections", "CONNECTION");
        setDynamicStatus("MeshMapper at capacity", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for capacity full");
      } else if (state.disconnectReason === "app_down") {
        debugLog("[BLE] Branch: app_down");
        addErrorLogEntry("MeshMapper server unavailable - check service status", "CONNECTION");
        setDynamicStatus("MeshMapper unavailable", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for app down");
      } else if (state.disconnectReason === "slot_revoked") {
        debugLog("[BLE] Branch: slot_revoked");
        addErrorLogEntry("Wardriving slot revoked by server - exceeded limits or policy violation", "CONNECTION");
        setDynamicStatus("MeshMapper slot revoked", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for slot revocation");
      } else if (state.disconnectReason === "session_id_error") {
        debugLog("[BLE] Branch: session_id_error");
        addErrorLogEntry("Session ID error - failed to establish valid wardrive session", "CONNECTION");
        setDynamicStatus("Session error - reconnect", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for session_id error");
      } else if (state.disconnectReason === "public_key_error") {
        debugLog("[BLE] Branch: public_key_error");
        addErrorLogEntry("Device public key error - invalid or missing key from companion", "CONNECTION");
        setDynamicStatus("Device key error - reconnect", STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for public key error");
      } else if (state.disconnectReason === "zone_disabled") {
        debugLog("[GEO AUTH] Branch: zone_disabled");
        addErrorLogEntry("Zone disabled - wardriving not allowed in this area", "CONNECTION");
        setDynamicStatus("Zone disabled", STATUS_COLORS.error, true);
        debugLog("[GEO AUTH] Setting terminal status for zone disabled");
      } else if (state.disconnectReason === "outside_zone") {
        debugLog("[GEO AUTH] Branch: outside_zone");
        addErrorLogEntry("Outside zone - moved outside wardriving zone boundary", "CONNECTION");
        setDynamicStatus("Outside zone", STATUS_COLORS.error, true);
        debugLog("[GEO AUTH] Setting terminal status for outside zone");
      } else if (state.disconnectReason === "at_capacity") {
        debugLog("[GEO AUTH] Branch: at_capacity");
        addErrorLogEntry("Zone at capacity - too many active wardrivers in this zone", "CONNECTION");
        setDynamicStatus("Zone at capacity", STATUS_COLORS.error, true);
        debugLog("[GEO AUTH] Setting terminal status for zone at capacity");
      } else if (state.disconnectReason === "gps_unavailable") {
        debugLog("[GEO AUTH] Branch: gps_unavailable");
        addErrorLogEntry("GPS unavailable - could not acquire valid GPS coordinates for zone check", "CONNECTION");
        setDynamicStatus("GPS unavailable", STATUS_COLORS.error, true);
        debugLog("[GEO AUTH] Setting terminal status for GPS unavailable");
      } else if (state.disconnectReason === "zone_check_failed") {
        debugLog("[GEO AUTH] Branch: zone_check_failed");
        addErrorLogEntry("Zone check failed - unable to verify wardriving zone", "CONNECTION");
        setDynamicStatus("Zone check failed", STATUS_COLORS.error, true);
        debugLog("[GEO AUTH] Setting terminal status for zone check failed");
      } else if (state.disconnectReason === "channel_setup_error") {
        debugLog("[BLE] Branch: channel_setup_error");
        const errorMsg = state.channelSetupErrorMessage || "Channel setup failed";
        addErrorLogEntry(`#wardriving channel setup failed - ${errorMsg}`, "CONNECTION");
        setDynamicStatus(errorMsg, STATUS_COLORS.error, true);
        debugLog("[BLE] Setting terminal status for channel setup error");
        state.channelSetupErrorMessage = null; // Clear after use (also cleared in cleanup as safety net)
      } else if (state.disconnectReason === "ble_disconnect_error") {
        debugLog("[BLE] Branch: ble_disconnect_error");
        const errorMsg = state.bleDisconnectErrorMessage || "BLE disconnect failed";
        addErrorLogEntry(`BLE connection error - ${errorMsg}`, "CONNECTION");
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
        const errorMsg = `Connection not allowed: ${state.disconnectReason}`;
        addErrorLogEntry(`Connection not allowed by server: ${state.disconnectReason}`, "CONNECTION");
        setDynamicStatus(errorMsg, STATUS_COLORS.error, true);
      }
      
      setConnectButton(false);
      if (deviceModelEl) deviceModelEl.textContent = "-";
      
      // Stop periodic noise floor updates
      stopNoiseFloorUpdates();
      
      debugLog("[BLE] Clearing device model and noise floor on disconnect");
      state.deviceModel = null;
      state.deviceName = null;
      state.lastNoiseFloor = null;
      state.connection = null;
      state.channel = null;
      state.devicePublicKey = null; // Clear public key
      state.wardriveSessionId = null; // Clear wardrive session ID
      state.txAllowed = false; // Clear TX permission
      state.rxAllowed = false; // Clear RX permission
      state.sessionExpiresAt = null; // Clear session expiration
      state.debugMode = false; // Clear debug mode
      state.tempTxRepeaterData = null; // Clear temp TX data
      // NOTE: state.disconnectReason is NOT cleared here - it's cleared in connect() 
      // so error status persists until user starts a new connection
      state.channelSetupErrorMessage = null; // Clear error message
      state.bleDisconnectErrorMessage = null; // Clear error message
      state.autoPowerSet = false; // Reset auto-power flag
      
      // Show placeholder, hide both power displays and clear label
      const powerPlaceholder = document.getElementById("powerPlaceholder");
      const powerAutoDisplay = document.getElementById("powerAutoDisplay");
      const powerManualSelection = document.getElementById("powerManualSelection");
      const powerLabelStatus = document.getElementById("powerLabelStatus");
      
      if (powerPlaceholder) {
        powerPlaceholder.style.display = "flex";
      }
      if (powerAutoDisplay) {
        powerAutoDisplay.classList.add("hidden");
        powerAutoDisplay.style.display = "none";
      }
      if (powerManualSelection) {
        powerManualSelection.classList.add("hidden");
        powerManualSelection.style.display = "none";
      }
      if (powerLabelStatus) {
        powerLabelStatus.textContent = "";
        powerLabelStatus.className = "";
      }
      
      // Uncheck all power radio buttons
      const powerInputs = document.querySelectorAll('input[name="power"]');
      powerInputs.forEach(input => {
        input.checked = false;
      });
      
      // Unlock wardrive settings after disconnect
      unlockWardriveSettings();
      
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
      
      // Clear wardrive queue messages (timers already stopped in cleanupAllTimers)
      wardriveQueue.messages = [];
      debugLog(`[WARDRIVE QUEUE] Queue cleared on disconnect`);
      
      // Clean up all timers
      cleanupAllTimers();
      
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
    updateConnectButtonState();  // Re-check zone and antenna requirements
    
    // Restart slot refresh timer since connection failed
    startSlotRefreshTimer();
  }
}
async function disconnect() {
  debugLog("[BLE] disconnect() called");
  if (!state.connection) {
    debugLog("[BLE] No connection to disconnect");
    return;
  }

  setConnectButtonDisabled(true);
  
  // Set disconnectReason to "normal" if not already set (for user-initiated disconnects)
  if (state.disconnectReason === null || state.disconnectReason === undefined) {
    state.disconnectReason = "normal";
  }
  
  // Set connection bar to "Disconnecting" - will remain until cleanup completes
  setConnStatus("Disconnecting", STATUS_COLORS.info);
  setDynamicStatus("Idle"); // Clear dynamic status

  // 1. CRITICAL: Wait for pending background API posts (session_id still valid)
  if (state.pendingApiPosts.length > 0) {
    debugLog(`[BLE] Waiting for ${state.pendingApiPosts.length} pending background API posts to complete`);
    await Promise.allSettled(state.pendingApiPosts);
    state.pendingApiPosts = [];
    debugLog(`[BLE] All pending background API posts completed`);
  }

  // 2. Flush wardrive queue (session_id still valid)
  if (wardriveQueue.messages.length > 0) {
    debugLog(`[BLE] Flushing ${wardriveQueue.messages.length} queued messages before disconnect`);
    await submitWardriveData();
  }
  stopWardriveTimers();

  // 3. THEN release session via auth API if we have a public key
  if (state.devicePublicKey && state.wardriveSessionId) {
    try {
      debugLog("[AUTH] Releasing session via /auth disconnect");
      await requestAuth("disconnect");
    } catch (e) {
      debugWarn(`[AUTH] Failed to release session: ${e.message}`);
      // Don't fail disconnect if auth release fails
    }
  }

  // 4. Delete the wardriving channel before disconnecting
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
    
    // Restart 30s slot refresh timer
    startSlotRefreshTimer();
    
    // Immediate zone check after disconnect to update slot display
    debugLog("[GEO AUTH] Performing zone check after disconnect");
    const coords = await getValidGpsForZoneCheck();
    if (coords) {
      const result = await checkZoneStatus(coords);
      if (result.success && result.zone) {
        state.currentZone = result.zone;
        state.lastZoneCheckCoords = { lat: coords.lat, lon: coords.lon };
        updateZoneStatusUI(result);
        debugLog(`[GEO AUTH] Post-disconnect zone check: ${result.zone.name}, slots: ${result.zone.slots_available}/${result.zone.slots_max}`);
      } else if (result.success && !result.in_zone) {
        state.currentZone = null;
        state.lastZoneCheckCoords = { lat: coords.lat, lon: coords.lon };
        updateZoneStatusUI(result);
        debugLog(`[GEO AUTH] Post-disconnect zone check: outside zone, nearest: ${result.nearest_zone?.name}`);
      }
    }
    
  } catch (e) {
    debugError(`[BLE] BLE disconnect failed: ${e.message}`, e);
    state.disconnectReason = "ble_disconnect_error"; // Mark specific disconnect reason
    state.bleDisconnectErrorMessage = e.message || "Disconnect failed"; // Store error message
  } finally {
    updateConnectButtonState();  // Re-check zone and antenna requirements
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
 * Update Connect button state based on external antenna selection AND zone status
 * Connect requires: external antenna selected AND in valid zone (no persistent error)
 */
function updateConnectButtonState() {
  const externalAntennaSelected = getExternalAntennaSetting() !== "";
  const isConnected = !!state.connection;
  const hasZoneError = !!statusMessageState.outsideZoneError;
  const inValidZone = !!state.currentZone;
  
  if (!isConnected) {
    // Enable Connect only if: antenna selected AND in valid zone AND no persistent error
    const canConnect = externalAntennaSelected && inValidZone && !hasZoneError;
    setConnectButtonDisabled(!canConnect);
    
    // Update dynamic status based on what's blocking connection
    // Priority: zone error > antenna not selected > ready
    if (hasZoneError) {
      // Zone error already shown as persistent message, don't override
      debugLog("[UI] Connect blocked by zone error (persistent message already shown)");
    } else if (!externalAntennaSelected) {
      debugLog("[UI] External antenna not selected - showing message in status bar");
      setDynamicStatus("Select external antenna to connect", STATUS_COLORS.warning);
    } else if (!inValidZone) {
      debugLog("[UI] Not in valid zone - waiting for zone check");
      // Don't show message here, zone check will update status
    } else {
      debugLog("[UI] External antenna selected and in valid zone - ready to connect");
      // Only set Idle if not showing a disconnect error
      const isErrorDisconnect = state.disconnectReason && 
        state.disconnectReason !== "normal" && 
        state.disconnectReason !== null;
      if (!isErrorDisconnect) {
        setDynamicStatus("Idle", STATUS_COLORS.idle);
      } else {
        debugLog(`[UI] Preserving disconnect error status (reason: ${state.disconnectReason})`);
      }
    }
  }
}

/**
 * Lock wardrive settings (Radio Power and External Antenna) after connection
 */
function lockWardriveSettings() {
  debugLog("[UI] Locking wardrive settings (power and external antenna)");
  
  // Lock all radio power inputs and labels
  const powerInputs = document.querySelectorAll('input[name="power"]');
  powerInputs.forEach(input => {
    input.disabled = true;
    const label = input.closest("label");
    if (label) {
      label.classList.add("cursor-not-allowed", "pointer-events-none");
      label.style.opacity = "0.5";
    }
  });
  
  // Lock Override button
  const powerOverrideBtn = document.getElementById("powerOverrideBtn");
  if (powerOverrideBtn) {
    powerOverrideBtn.disabled = true;
    powerOverrideBtn.classList.add("cursor-not-allowed", "pointer-events-none");
    powerOverrideBtn.style.opacity = "0.5";
  }
  
  // Lock all external antenna inputs and labels
  const antennaInputs = document.querySelectorAll('input[name="externalAntenna"]');
  antennaInputs.forEach(input => {
    input.disabled = true;
    const label = input.closest("label");
    if (label) {
      label.classList.add("cursor-not-allowed", "pointer-events-none");
      label.style.opacity = "0.5";
    }
  });
}

/**
 * Unlock wardrive settings (Radio Power and External Antenna) after disconnect
 */
function unlockWardriveSettings() {
  debugLog("[UI] Unlocking wardrive settings (power and external antenna)");
  
  // Unlock all radio power inputs and labels
  const powerInputs = document.querySelectorAll('input[name="power"]');
  powerInputs.forEach(input => {
    input.disabled = false;
    const label = input.closest("label");
    if (label) {
      label.classList.remove("cursor-not-allowed", "pointer-events-none");
      label.style.opacity = "";
    }
  });
  
  // Unlock Override button
  const powerOverrideBtn = document.getElementById("powerOverrideBtn");
  if (powerOverrideBtn) {
    powerOverrideBtn.disabled = false;
    powerOverrideBtn.classList.remove("cursor-not-allowed", "pointer-events-none");
    powerOverrideBtn.style.opacity = "";
  }
  
  // Unlock all external antenna inputs and labels
  const antennaInputs = document.querySelectorAll('input[name="externalAntenna"]');
  antennaInputs.forEach(input => {
    input.disabled = false;
    const label = input.closest("label");
    if (label) {
      label.classList.remove("cursor-not-allowed", "pointer-events-none");
      label.style.opacity = "";
    }
  });
}

// ---- Bind UI & init ----
export async function onLoad() {
  debugLog("[INIT] wardrive.js onLoad() called - initializing");
  
  // Initialize double-buffered iframe references (in case module loaded before DOM)
  if (!coverageFrameA) coverageFrameA = document.getElementById("coverageFrameA");
  if (!coverageFrameB) coverageFrameB = document.getElementById("coverageFrameB");
  if (coverageFrameA && !activeFrame) activeFrame = coverageFrameA;
  debugLog(`[INIT] Coverage iframes: A=${!!coverageFrameA}, B=${!!coverageFrameB}, active=${activeFrame?.id || 'none'}`);
  
  setConnStatus("Disconnected", STATUS_COLORS.error);
  enableControls(false);
  updateAutoButton();
  
  // Load device models database
  try {
    debugLog("[INIT] Loading device models database from device-models.json");
    const response = await fetch('content/device-models.json');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    DEVICE_MODELS = data.devices || [];
    debugLog(`[INIT] ✅ Loaded ${DEVICE_MODELS.length} device models from database`);
  } catch (e) {
    debugError(`[INIT] Failed to load device-models.json: ${e.message}`);
    DEVICE_MODELS = []; // Ensure it's an empty array on failure
  }
  
  // Disable RX Auto button (backend API not ready)
  rxAutoBtn.disabled = true;
  rxAutoBtn.title = "RX Auto temporarily disabled - backend API not ready";
  debugLog("[INIT] RX Auto button disabled - backend API not ready");
  
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
    sendPing(true).catch((e) => debugError("[PING] Manual ping error:", e?.message || String(e)));
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

  // Add event listeners to radio power options
  const powerRadios = document.querySelectorAll('input[name="power"]');
  let previousPowerValue = null; // Track previous selection for revert on cancel
  
  // Add event listener to Override button
  const powerOverrideBtn = document.getElementById("powerOverrideBtn");
  if (powerOverrideBtn) {
    powerOverrideBtn.addEventListener("click", () => {
      debugLog("[UI] Override button clicked");
      
      // Show custom confirmation modal
      const modal = document.getElementById("overrideModal");
      if (modal) {
        modal.classList.remove("hidden");
        debugLog("[UI] Override modal opened");
      } else {
        debugError("[UI] overrideModal element not found in DOM!");
      }
    });
  } else {
    debugError("[UI] powerOverrideBtn element not found!");
  }
  
  // Add event listeners to modal buttons
  const overrideModalConfirm = document.getElementById("overrideModalConfirm");
  const overrideModalCancel = document.getElementById("overrideModalCancel");
  const overrideModal = document.getElementById("overrideModal");
  
  if (overrideModalConfirm && overrideModal) {
    overrideModalConfirm.addEventListener("click", () => {
      debugLog("[UI] Override confirmed via custom modal");
      
      // Hide modal
      overrideModal.classList.add("hidden");
      
      // Hide auto display, show manual selection
      const powerAutoDisplay = document.getElementById("powerAutoDisplay");
      const powerManualSelection = document.getElementById("powerManualSelection");
      const powerLabelStatus = document.getElementById("powerLabelStatus");
      
      if (powerAutoDisplay) {
        powerAutoDisplay.classList.add("hidden");
        powerAutoDisplay.style.display = "none";
      }
      if (powerManualSelection) {
        powerManualSelection.classList.remove("hidden");
        powerManualSelection.style.display = "flex";
      }
      
      // Update state and label
      state.autoPowerSet = false;
      if (powerLabelStatus) {
        powerLabelStatus.textContent = "⚙️ Manual";
        powerLabelStatus.className = "text-slate-400";
      }
      
      debugLog("[UI] Power override confirmed, switched to manual selection");
    });
  }
  
  if (overrideModalCancel && overrideModal) {
    overrideModalCancel.addEventListener("click", () => {
      debugLog("[UI] Override canceled via custom modal");
      overrideModal.classList.add("hidden");
    });
  }
  
  // Close modal when clicking backdrop
  if (overrideModal) {
    overrideModal.addEventListener("click", (e) => {
      if (e.target === overrideModal) {
        debugLog("[UI] Override modal closed via backdrop click");
        overrideModal.classList.add("hidden");
      }
    });
  }
  
  powerRadios.forEach(radio => {
    radio.addEventListener("change", (e) => {
      const newValue = getCurrentPowerSetting();
      debugLog(`[UI] Radio power changed to: ${newValue}`);
      
      const powerLabelStatus = document.getElementById("powerLabelStatus");
      
      // If user is selecting after Override button was clicked (autoPowerSet is false after override)
      // Update label to show "⚙️ Manual"
      if (!state.autoPowerSet && state.connection) {
        if (powerLabelStatus) {
          // Check if this was an unknown device (label is "⚠️ Required")
          const wasUnknown = powerLabelStatus.textContent === "⚠️ Required";
          
          if (wasUnknown) {
            // Clear the "Required" warning for unknown device
            powerLabelStatus.textContent = "⚙️ Manual";
            powerLabelStatus.className = "text-slate-400";
            setDynamicStatus("Idle");
            debugLog("[UI] Cleared unknown device status after manual power selection");
          } else {
            // This was an override, show Manual indicator
            powerLabelStatus.textContent = "⚙️ Manual";
            powerLabelStatus.className = "text-slate-400";
            debugLog("[UI] Manual power selection after override");
          }
        }
      }
      
      // Store current value as previous for next change
      previousPowerValue = newValue;
      
      // Update controls to enable/disable ping buttons based on power selection
      updateControlsForCooldown();
      updateConnectButtonState();
    });
  });

  // Add event listeners to external antenna options to update Connect button state
  const antennaRadios = document.querySelectorAll('input[name="externalAntenna"]');
  antennaRadios.forEach(radio => {
    radio.addEventListener("change", () => {
      debugLog(`[UI] External antenna changed to: ${getExternalAntennaSetting()}`);
      updateConnectButtonState();
    });
  });

  // Carpeater filter checkbox event listener
  const carpeaterCheckbox = document.getElementById('carpeaterFilterEnabled');
  const carpeaterInput = document.getElementById('carpeaterIdInput');
  
  if (carpeaterCheckbox && carpeaterInput) {
    // Load saved settings from localStorage
    const savedEnabled = localStorage.getItem('carpeaterFilterEnabled') === 'true';
    const savedId = localStorage.getItem('carpeaterRepeaterId') || '';
    
    carpeaterCheckbox.checked = savedEnabled;
    carpeaterInput.value = savedId;
    carpeaterInput.disabled = !savedEnabled; // Enable/disable input based on checkbox
    
    // Update checkmark visibility on load
    const checkmarkSvg = document.querySelector('.checkmark-svg');
    if (checkmarkSvg) {
      checkmarkSvg.style.opacity = savedEnabled ? '1' : '0';
    }
    
    // Checkbox toggle event
    carpeaterCheckbox.addEventListener('change', (e) => {
      const isEnabled = e.target.checked;
      carpeaterInput.disabled = !isEnabled;
      localStorage.setItem('carpeaterFilterEnabled', isEnabled);
      debugLog(`[SETTINGS] Carpeater filter ${isEnabled ? 'enabled' : 'disabled'}`);
      
      // Update checkmark visibility
      if (checkmarkSvg) {
        checkmarkSvg.style.opacity = isEnabled ? '1' : '0';
      }
      
      // Focus input when enabled
      if (isEnabled) {
        carpeaterInput.focus();
      }
    });
    
    // Input validation and save event
    carpeaterInput.addEventListener('input', (e) => {
      const value = e.target.value.toLowerCase();
      const isValid = /^[0-9a-f]{0,2}$/.test(value);
      
      if (isValid) {
        e.target.value = value;
        if (value.length === 2) {
          localStorage.setItem('carpeaterRepeaterId', value);
          debugLog(`[SETTINGS] Carpeater repeater ID set to: ${value}`);
        }
      } else {
        e.target.value = value.slice(0, -1); // Remove invalid character
      }
    });
  }

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

  // Reusable function to setup info modals
  function setupInfoModal(buttonId, modalId, modalName) {
    const button = document.getElementById(buttonId);
    const modal = document.getElementById(modalId);
    
    if (button && modal) {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        debugLog(`[UI] ${modalName} info link clicked - opening modal`);
        modal.classList.remove('hidden');
      });
      
      const modalCloseButtons = modal.querySelectorAll('[data-modal-close]');
      modalCloseButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          debugLog(`[UI] ${modalName} modal close button clicked`);
          modal.classList.add('hidden');
        });
      });
      
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          debugLog(`[UI] ${modalName} modal closed via backdrop click`);
          modal.classList.add('hidden');
        }
      });
    }
  }

  // Setup all info modals
  setupInfoModal('intervalInfoLink', 'intervalModal', 'Auto Ping Interval');
  setupInfoModal('antennaInfoLink', 'antennaModal', 'External Antenna');
  setupInfoModal('powerInfoLink', 'powerModal', 'Radio Power');
  setupInfoModal('carpeaterInfoLink', 'carpeaterModal', 'Carpeater');


  // Prompt location permission early (optional)
  debugLog("[GPS] Requesting initial location permission");
  try { 
    await getCurrentPosition(); 
    debugLog("[GPS] Initial location permission granted");
  } catch (e) { 
    debugLog(`[GPS] Initial location permission not granted: ${e.message}`);
  }
  
  // Perform app launch zone check
  await performAppLaunchZoneCheck();
  
  debugLog("[INIT] wardrive.js initialization complete");
}
