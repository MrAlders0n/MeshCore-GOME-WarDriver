
// Minimal wardrive: connect to MeshCore Companion via BLE
// and send GPS coords to #wardrive every 30 seconds.

import { WebBleConnection } from "/content/mc/index.js"; // your MeshCore BLE client
// If you don’t have /content/mc/index.js in your tree, point this import
// to the package/file that exposes WebBleConnection for the Companion.

const $ = (id) => document.getElementById(id);

const statusEl      = $("status");
const deviceInfoEl  = $("deviceInfo");
const channelInfoEl = $("channelInfo");
const connectBtn    = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const lastPingEl    = $("lastPing");

const WARDRIVE_CHANNEL_NAME = "#wardrive";
const PING_INTERVAL_MS = 30 * 1000;

const state = {
  connection: null,
  wardriveChannel: null,
  timerId: null,
  lastPos: null,
};

function setStatus(text, color = "text-slate-300") {
  statusEl.textContent = text;
  statusEl.className = `font-semibold ${color}`;
}

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

async function ensureWardriveChannel() {
  if (!state.connection) throw new Error("Not connected");

  if (state.wardriveChannel) return state.wardriveChannel;

  // Try find existing channel by name
  let ch = await state.connection.findChannelByName(WARDRIVE_CHANNEL_NAME);
  if (!ch) {
    // If not found, create one in a free slot.
    const channels = await state.connection.getChannels();
    let freeIdx = channels.findIndex(c => !c.name || c.name === "");
    if (freeIdx < 0) throw new Error("No free channel slots available");

    // Derived fixed key for wardrive channel (use consistent key if network expects one).
    // If your network uses a different keying approach, replace this with your key derivation.
    const wardriveKey = new Uint8Array([
      0x40, 0x76, 0xC3, 0x15, 0xC1, 0xEF, 0x38, 0x5F,
      0xA9, 0x3F, 0x06, 0x60, 0x27, 0x32, 0x0F, 0xE5
    ]);

    await state.connection.setChannel(freeIdx, WARDRIVE_CHANNEL_NAME, wardriveKey);
    ch = { channelIdx: freeIdx, name: WARDRIVE_CHANNEL_NAME };
  }

  state.wardriveChannel = ch;
  channelInfoEl.textContent = `${WARDRIVE_CHANNEL_NAME} (CH:${ch.channelIdx})`;
  return ch;
}

async function sendWardrivePing(auto = true) {
  try {
    const pos = await getCurrentPosition();
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    state.lastPos = [lat, lon];

    // Simple text payload: "lat lon"
    const text = `${lat.toFixed(5)} ${lon.toFixed(5)}`;

    const ch = await ensureWardriveChannel();
    await state.connection.sendChannelTextMessage(ch.channelIdx, text);

    setStatus(auto ? "Auto ping sent" : "Ping sent", "text-emerald-300");
    lastPingEl.textContent = `${new Date().toLocaleString()} — ${text}`;
  } catch (e) {
    console.error("Ping failed:", e);
    setStatus("Ping failed", "text-red-300");
  }
}

function startAutoPing() {
  stopAutoPing();
  state.timerId = setInterval(() => sendWardrivePing(true).catch(console.error), PING_INTERVAL_MS);
}

function stopAutoPing() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}

async function connect() {
  if (!("bluetooth" in navigator)) {
    alert("Web Bluetooth not supported in this browser.");
    return;
  }
  connectBtn.disabled = true;
  setStatus("Connecting…", "text-sky-300");

  try {
    const connection = await WebBleConnection.open();
    state.connection = connection;

    connection.on("connected", async () => {
      setStatus("Connected", "text-emerald-300");
      disconnectBtn.disabled = false;
      connectBtn.disabled = false;
      connectBtn.textContent = "Reconnect";

      try { await connection.syncDeviceTime?.(); } catch { /* optional */ }

      const selfInfo = await connection.getSelfInfo();
      deviceInfoEl.textContent = selfInfo?.name || "[No device]";

      await ensureWardriveChannel();

      // Send one immediately, then every 30s
      await sendWardrivePing(false);
      startAutoPing();
    });

    connection.on("disconnected", () => {
      setStatus("Disconnected", "text-red-300");
      deviceInfoEl.textContent = "—";
      channelInfoEl.textContent = WARDRIVE_CHANNEL_NAME;
      stopAutoPing();
      state.connection = null;
      state.wardriveChannel = null;
      disconnectBtn.disabled = true;
      connectBtn.textContent = "Connect via BLE";
    });

  } catch (e) {
    console.error("BLE connect failed:", e);
    setStatus("Failed to connect", "text-red-300");
    connectBtn.disabled = false;
  }
}

async function disconnect() {
  if (!state.connection) return;
  try { await state.connection.close(); } catch (e) { console.warn("Close error", e); }
}

export async function onLoad() {
  // Wire buttons
  connectBtn.addEventListener("click", () => connect().catch(console.error));
  disconnectBtn.addEventListener("click", () => disconnect().catch(console.error));

  // Initial UI
   setStatus("Disconnected", "text-red-300");
  disconnectBtn.disabled = true;

  // Request geolocation upfront (browser may prompt)
  try { await getCurrentPosition(); } catch { /* prompt appears on first call */ }
