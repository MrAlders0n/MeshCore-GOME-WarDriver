# MeshCore GOME WarDriver

[![Version](https://img.shields.io/badge/version-1.8.0-blue.svg)](https://github.com/MrAlders0n/MeshCore-GOME-WarDriver/releases/tag/v1.8.0)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS-orange.svg)](#platform-support)

A browser-based Progressive Web App for wardriving with MeshCore devices. Connect via Bluetooth, send GPS pings, and build coverage maps for the Ottawa (YOW) mesh network.

**Live at**: [wardrive.ottawamesh.ca](https://wardrive.ottawamesh.ca)

---

## 🚀 Quick Start

### Before you start

- Make sure you have the **wardriving channel** set on your companion.
- Take a **backup of your companion** (this webapp is beyond experimental).

### Android

1. Disconnect the **MeshCore** app and close it
2. Open **Google Chrome**
3. Go to https://wardrive.ottawamesh.ca/
4. **Connect** your device
5. Pick **interval** and **power**
6. Send a ping or start **auto ping**
7. Move around and watch it track

### iOS

1. Disconnect the **MeshCore** app and close it
2. Install **Bluefy** (Web BLE browser): https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055
3. Open https://wardrive.ottawamesh.ca/ in **Bluefy**
4. **Connect** your device
5. Pick **interval** and **power**
6. Send a ping or start **auto ping**
7. Move around and watch it track

> ⚠️ **Note (iOS)**: You must use **Bluefy**. Other iOS browsers (including Safari) do not support Web Bluetooth (BLE).

---

## ✨ Features

### 🗺️ Live Coverage Map
- **Embedded MeshMapper** integration
- **API POST** to MeshMapper to enable failed ping blocks
- **Auto-refresh** after each ping (30-second delay)
- **Interactive view** of coverage zones and repeaters

### 📍 GPS Tracking
- **High-accuracy positioning** for precise coverage mapping
- **Real-time location updates** with continuous GPS watch
- **Accuracy display** shows GPS precision in meters
- **Location age indicator** keeps you informed

### 🤖 Ping Modes
- **Manual Mode**: Send pings on demand
- **Auto Mode**: Continuous pinging at 15s, 30s, or 60s intervals
- **Wake Lock**: Keeps screen on during auto mode for GPS accuracy

### 📡 Power Configuration
Configure radio power for accurate coverage data:
- N/A (default)
- 0.3w, 0.6w, 1.0w

### 📊 Session Tracking
- Scrollable **ping history log**
- **Timestamps and coordinates** for every ping
- Track your wardriving session in real-time

---

## 📱 Platform Support

| Platform | Browser | Status |
|----------|---------|--------|
| **Android** | Chrome / Chromium | ✅ Fully Tested |
| **iOS** | Bluefy | ✅ Fully Tested |
| **iOS** | Safari | ❌ Not Supported |

### Android Requirements
- Chrome or Chromium-based browser
- Bluetooth and Location permissions enabled
- High-accuracy location mode recommended

### iOS Requirements
- [Bluefy browser](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055) (free)
- Bluetooth and Location permissions enabled
- Keep app in foreground with screen on

---

## 🗺️ Ottawa (YOW) Region

This application is configured for the **Ottawa Mesh** network:

- **Wardriving App**: [wardrive.ottawamesh.ca](https://wardrive.ottawamesh.ca)
- **Coverage Maps**: [yow.meshmapper.net](https://yow.meshmapper.net)
- **Community**: [ottawamesh.ca](https://ottawamesh.ca)

Pings are sent to the wardriving MeshCore channel to build community coverage maps.

---

## 🔧 Technical Stack

- **Web Bluetooth API** - BLE device communication
- **Geolocation API** - High-accuracy GPS tracking
- **Screen Wake Lock API** - Power management
- **Tailwind CSS** - Responsive UI design
- **PWA Ready** - Progressive Web App manifest
- **MeshMapper API Integration** - Automatic ping data posting for mesh network comparison

---

## 🔐 MeshMapper API Integration

This app automatically posts ping data to the YOW MeshMapper API to help compare if messages were received on the mesh.

---

## Debug Logging

A lightweight debugging system designed for development without impacting production performance.

### Features

- **Toggle Control** — Enable via URL parameter (`?debug=true`) or set the default directly in code
- **Consistent Logging API** — Use `debugLog()`, `debugWarn()`, and `debugError()` for uniform output
- **Production-Safe** — Disabled by default to keep the console clean in production environments

---

## 📋 Requirements

### MeshCore Device
- MeshCore device
- Wardriving channel configured on your device

### Browser
- **Android**: Chrome or Chromium-based browser
- **iOS**: Bluefy browser (Safari not supported)

### Permissions
- ✅ Bluetooth access
- ✅ High-accuracy location services
- ✅ Keep app in foreground during use

---

## 🛠️ Development

### Building Tailwind CSS

This project uses Tailwind CSS v4 to generate the styles. If you make changes to the HTML or need to rebuild the CSS:

```bash
# Install dependencies
npm install

# Build CSS once
npm run build:css

# Watch for changes and rebuild automatically
npm run watch:css
```

The CSS is generated from `content/tailwind-in.css` and outputs to `content/tailwind.css`.

---

## 🙏 Credits

This project is a fork and adaptation:

- **Original Project**: [kallanreed/mesh-map](https://github.com/kallanreed/mesh-map) by Kyle Reed
- **Modified By**: [MrAlders0n](https://github.com/MrAlders0n) for Ottawa Mesh
- **MeshMapper Backend**: Created by [@CSP-Tom](https://github.com/CSP-Tom) - The backend database and mapping software that receives pings and maps coverage live for the community at [MeshMapper.net](https://meshmapper.net)
- **Community**: Ottawa Mesh and all beta testers

---

## 🤝 Contributing

Found a bug? Have a feature request?

- **Issues**: [GitHub Issues](https://github.com/MrAlders0n/MeshCore-GOME-WarDriver/issues)
- **Community**: [Ottawa Mesh](https://ottawamesh.ca)

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) - see the LICENSE file for details.

---

## 🚗📡 Happy Wardriving!

Help build the Ottawa Mesh coverage maps and grow the MeshCore network!

**Visit [wardrive.ottawamesh.ca](https://wardrive.ottawamesh.ca) today and contribute to the community coverage database!**
