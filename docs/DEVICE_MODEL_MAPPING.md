# Device Model Mapping & Auto-Power Selection

## Overview

The MeshCore GOME WarDriver implements automatic power level selection based on detected device models. This feature ensures that users transmit at the correct power level for their specific hardware variant, particularly important for devices with Power Amplifiers (PAs) that require specific input power to avoid hardware damage.

**Key Changes (2026-01-06)**:
- Connection no longer requires pre-selecting power (auto-configured after deviceQuery)
- Settings lock moved from connection time to auto mode start
- Unknown devices require manual power selection (no default value)
- 2.0w power option added for 2W PA devices (33dBm output)

## Architecture

### Components

1. **Device Model Database** (`content/device-models.json`)
   - JSON file containing 32+ supported MeshCore device variants
   - Includes manufacturer strings, short names, recommended power settings (0.3w, 0.6w, 1.0w, 2.0w), and hardware notes
   - Generated from MeshCore firmware repository platformio.ini and Board.h files

2. **Device Model Parser** (`wardrive.js:parseDeviceModel()`)
   - Strips build suffixes (e.g., "nightly-e31c46f") from full manufacturer strings
   - Enables consistent matching regardless of firmware build version

3. **Device Lookup** (`wardrive.js:findDeviceConfig()`)
   - Searches database for exact or partial manufacturer string match
   - Returns device configuration with recommended power level or null if not found

4. **Auto-Power Configurator** (`wardrive.js:autoSetPowerLevel()`)
   - Called during connection flow after deviceQuery() succeeds
   - **If device found**: Automatically selects matching power radio button, shows "⚡ Auto" label, enables ping controls
   - **If device unknown**: Logs error, displays "Unknown device - select power manually" status, leaves ping controls disabled
   - Tracks auto-set state for override confirmation

5. **Model Display** 
   - Updates connection bar with `shortName` from database (e.g., "Ikoka Stick 1w")
   - Shows "Unknown" for unrecognized devices

## Data Flow

### Connection Workflow Integration

```
1. User clicks "Connect" (no power pre-selection required)
2. BLE GATT connection established
3. Protocol handshake complete
4. deviceQuery() called → Full manufacturer string retrieved
   Example: "Ikoka Stick-E22-30dBm (Xiao_nrf52)nightly-e31c46f"

5. **Device Model Auto-Power** (occurs after deviceQuery, before capacity check):
   a. Store full model in state.deviceModel
   b. Call autoSetPowerLevel():
      - Parse model string (strip build suffix)
      - Lookup in DEVICE_MODELS database
      
      **Known Device Path**:
      - Select power radio button (0.3w/0.6w/1.0w/2.0w)
      - Update label: "Radio Power ⚡ Auto"
      - Display shortName in connection bar
      - Show status: "Auto-configured: [shortName] at X.Xw"
      - Enable ping controls (updateControlsForCooldown)
      - Set state.autoPowerSet = true
      
      **Unknown Device Path**:
      - Leave power unselected
      - Display "Unknown" in connection bar
      - Log error: "Unknown device: [full model string]"
      - Show status: "Unknown device - select power manually" (persistent)
      - Ping controls remain disabled
      - Set state.autoPowerSet = false
   
6. Continue normal connection flow (capacity check, channel setup, GPS init)
7. Connection complete - settings remain UNLOCKED until auto mode starts
```

### Settings Lock Behavior (NEW)

**Previous Behavior**: Settings locked on connection completion
**New Behavior**: Settings lock only during auto mode

| State | Power Changeable? | Override Confirmation? |
|-------|-------------------|------------------------|
| Disconnected | ✅ Yes | No |
| Connected (idle) | ✅ Yes | ✅ Yes (if auto-set) |
| Auto Mode Running | ❌ No (locked) | N/A (disabled) |
| After Auto Stop | ✅ Yes | ✅ Yes (if auto-set) |

**Lock Timing**:
- `lockWardriveSettings()` called in `startAutoPing()` before enabling RX wardriving
- `unlockWardriveSettings()` called in `stopAutoPing()` after releasing wake lock
- `unlockWardriveSettings()` called in `disconnect()` cleanup

### Override Confirmation Flow

When user changes power after auto-configuration (while connected but NOT in auto mode):

```
1. User clicks different power radio button
2. Event listener checks: state.autoPowerSet === true && !settingsLocked
3. Show confirm() dialog: "Are you sure you want to override the auto-configured power setting?"
4a. If CANCELED: Revert to previous radio selection
4b. If CONFIRMED: 
    - Set state.autoPowerSet = false
    - Clear "⚡ Auto" label (remove text and class)
    - Allow change to proceed
5. If unknown device (autoPowerSet === false): Clear "Unknown device" status → "Idle"
6. updateControlsForCooldown() to re-enable ping buttons
```

### Build Suffix Handling

**Problem**: MeshCore firmware appends git commit hash at build time
- Example: `"Ikoka Stick-E22-30dBm (Xiao_nrf52)nightly-e31c46f"`

**Solution**: `parseDeviceModel()` strips suffix using regex
- Pattern: `/(nightly|release|dev)-[a-f0-9]+$/i`
- Result: `"Ikoka Stick-E22-30dBm (Xiao_nrf52)"`

**Why This Matters**:
- Database contains clean base strings (without build suffixes)
- Matching works consistently across firmware versions
- UI displays clean short names without git hashes

## Device Model Database Format

### JSON Structure

```json
{
  "version": "1.0.0",
  "generated": "2026-01-04",
  "source": "MeshCore firmware repository",
  "devices": [
    {
      "manufacturer": "Ikoka Stick-E22-30dBm (Xiao_nrf52)",
      "shortName": "Ikoka Stick-E22-30dBm",
      "power": 1.0,
      "platform": "nrf52",
      "txPower": 20,
      "notes": "EBYTE E22-900M30S, 1W PA: 20dBm input → 30dBm output"
    }
  ],
  "powerMapping": { ... },
  "notes": [ ... ]
}
```

### Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `manufacturer` | string | Full manufacturer string (without build suffix) |
| `shortName` | string | Clean display name for UI |
| `power` | number | Wardrive.js radio power setting (0.05-2.0) |
| `platform` | string | Hardware platform (nrf52, esp32, stm32, rp2040) |
| `txPower` | number | Firmware LORA_TX_POWER value in dBm |
| `notes` | string | Hardware details, PA info, safety warnings |

### Power Level Mapping

| Wardrive Setting | Firmware dBm | Output Power | Use Case |
|------------------|--------------|--------------|----------|
| 0.3w | ≤24 dBm | Standard | Standard devices without PA |
| 0.6w | 10 dBm | 28 dBm | Heltec V4, Heltec Tracker V2 (firmware 10dBm, PA amplifies to 22dBm actual) |
| 1.0w | 20 dBm | 30 dBm | 1W PA modules (E22-900M30S): 20dBm input → 30dBm output |
| 2.0w | 9 dBm | 33 dBm | 2W PA modules (E22-900M33S): 9dBm input → 33dBm output |

### Critical Power Amplifier Cases

### Ikoka 33dBm Models (2W PA) - CRITICAL SAFETY

**Devices**: 
- Ikoka Stick-E22-33dBm (Ikoka Stick 2w)
- Ikoka Nano-E22-33dBm (Ikoka Nano 2w)

**Auto-configured**: Power 2.0w (9dBm firmware input)
- Radio module: EBYTE E22-900M33S
- PA amplification: 9dBm → 33dBm (2W output)
- **CRITICAL**: Higher input power causes hardware damage to PA amplifier
- Firmware safety limit enforced in platformio.ini

### Ikoka 30dBm Models (1W PA)

**Devices**:
- Ikoka Stick-E22-30dBm
- Ikoka Nano-E22-30dBm
- Ikoka Handheld E22 30dBm

**Recommended**: Power 1.0 (20dBm firmware input)
- Radio module: EBYTE E22-900M30S
- PA amplification: 20dBm → 30dBm (1W output)
- **Higher input causes distortion**
- Firmware comment: "limit txpower to 20dBm on E22-900M30S"

### Standard 22dBm Models

**Most devices**: Power 2.0 (22dBm firmware)
- No PA amplifier
- Direct RF output from LoRa chip
- Safe to use maximum power

## Implementation Details

### State Management

```javascript
state = {
  deviceModel: null,        // Full manufacturer string from device
  autoPowerSet: false,      // Track if power was automatically configured
  // ... other state fields
}
```

### Global Variables

```javascript
DEVICE_MODELS = null;       // Array of device configs from JSON
deviceModelsLoaded = false; // Loading state flag
```

### Function Summary

#### `loadDeviceModels()` - Async
**When**: Called on page load in `onLoad()`
**Purpose**: Fetch and parse device-models.json
**Returns**: Boolean success/failure

#### `parseDeviceModel(fullModel)` - Sync
**Input**: Full manufacturer string (may include build suffix)
**Output**: Cleaned string for database matching
**Example**: 
- Input: `"Ikoka Stick-E22-30dBm (Xiao_nrf52)nightly-e31c46f"`
- Output: `"Ikoka Stick-E22-30dBm (Xiao_nrf52)"`

#### `findDeviceConfig(manufacturerString)` - Sync
**Input**: Manufacturer string from deviceQuery()
**Output**: Device config object or null
**Logic**:
1. Strip build suffix via parseDeviceModel()
2. Try exact match in DEVICE_MODELS array
3. Fall back to partial match (case-insensitive)
4. Return null if no match

#### `updateDeviceModelDisplay(manufacturerString)` - Sync
**Input**: Full manufacturer string
**Output**: None (updates UI)
**DOM Target**: `#deviceModel` in Settings panel
**Logic**:
- If device in database → show `shortName`
- If unknown → show full string as-is

#### `autoSetPowerLevel(manufacturerString)` - Sync
**Input**: Manufacturer string from deviceQuery()
**Output**: Boolean (true if power was auto-set)
**When**: Called during connection flow after deviceQuery()
**Logic**:
1. Look up device config
2. If unknown → return false (use manual selection)
3. Map config.power to select option value
4. Set powerSelect.value
5. Mark state.autoPowerSet = true
6. Return true

### Error Handling

**JSON Load Failure**:
- Logged as error with full stack trace
- DEVICE_MODELS set to empty array
- Connection continues without auto-power feature
- User must manually select power (existing behavior)

**Unknown Device**:
- Full manufacturer string shown in UI
- No auto-power selection
- User manually selects power (existing behavior)
- Logged as warning with device string

**Invalid Power Value**:
- Logged as warning
- Returns false (no auto-set)
- User manually selects power

## Database Maintenance

### Adding New Devices

1. **Locate firmware source**:
   - For devices with MANUFACTURER_STRING in platformio.ini:
     - File: `variants/{VARIANT_NAME}/platformio.ini`
     - Extract: `MANUFACTURER_STRING` and `LORA_TX_POWER`
   
   - For devices with hardcoded strings:
     - File: `variants/{VARIANT_NAME}/*Board.h`
     - Extract: `getManufacturerName()` return value
     - Check platformio.ini for `LORA_TX_POWER`

2. **Determine power mapping**:
   - Check for PA comments in platformio.ini
   - E22-900M33S (2W PA) → 9dBm → power: 0.05
   - E22-900M30S (1W PA) → 20dBm → power: 1.0
   - Standard modules → 22dBm → power: 2.0

3. **Add to device-models.json**:
   ```json
   {
     "manufacturer": "Full String (no build suffix)",
     "shortName": "Short Display Name",
     "power": 1.0,
     "platform": "nrf52",
     "txPower": 20,
     "notes": "Hardware details"
   }
   ```

4. **Test**:
   - Connect to device
   - Check DevTools console for `[DEVICE MODEL]` logs
   - Verify power auto-selection
   - Confirm Settings panel shows short name

### Updating Existing Devices

**When firmware changes**:
- Check if MANUFACTURER_STRING or LORA_TX_POWER changed
- Update device-models.json accordingly
- Test with device if available

**Version tracking**:
- Update `version` field in JSON (semantic versioning)
- Update `generated` field with current date

## Debug Logging

All device model operations log with `[DEVICE MODEL]` tag:

```javascript
debugLog("[DEVICE MODEL] Loading device models from device-models.json");
debugLog("[DEVICE MODEL] ✅ Loaded 32 device models");
debugLog("[DEVICE MODEL] Parsed model: \"Full String\" → \"Clean String\"");
debugLog("[DEVICE MODEL] ✅ Exact match found: \"Model Name\"");
debugLog("[DEVICE MODEL] ❌ No match found for: \"Unknown Model\"");
debugLog("[DEVICE MODEL] ✅ Auto-set power to 1.0 (20dBm firmware) for \"Device Name\"");
```

Enable debug mode: Add `?debug=true` to URL or set `DEBUG_ENABLED = true` in code.

## User Experience

### With Known Device

1. User connects → device detected
2. Settings panel shows clean short name
3. Power automatically set to recommended value
4. User can manually override if desired (selection works normally)
5. On disconnect → auto-power flag clears

### With Unknown Device

1. User connects → device detected
2. Settings panel shows full manufacturer string (with build suffix)
3. No auto-power selection
4. User must manually select power (existing behavior)
5. Warning logged in console for debugging

### Manual Override Behavior

**Current Implementation**:
- Auto-power only sets value during connection
- User can manually change power after connection
- Manual selection takes precedence for that session
- On reconnect → auto-power runs again (resets to recommended)

**Future Enhancement** (not implemented):
- Could track user preference in localStorage
- Could show "(auto)" indicator in UI when power is auto-set
- Could ask user confirmation before overriding manual selection

## Testing Checklist

### Connection Flow
- [ ] Load page → device-models.json fetched successfully
- [ ] Connect to known device → power auto-set
- [ ] Connect to unknown device → no auto-set, manual selection works
- [ ] Settings panel shows correct model display (short name or full string)
- [ ] Disconnect → state clears, autoPowerSet flag resets

### Power Selection
- [ ] 33dBm device → auto-selects 0.05
- [ ] 30dBm device → auto-selects 1.0
- [ ] 22dBm device → auto-selects 2.0
- [ ] Unknown device → no auto-select, manual works
- [ ] Manual override after auto-set → selection works

### Error Conditions
- [ ] JSON load failure → logged, feature disabled gracefully
- [ ] Invalid device config → logged, no crash
- [ ] Missing power select element → logged, no crash
- [ ] Malformed manufacturer string → parsed safely

### Debug Logging
- [ ] All operations log with [DEVICE MODEL] tag
- [ ] Success/failure states clearly indicated (✅/❌/⚠️)
- [ ] Full context in logs for troubleshooting

## Future Enhancements

1. **User Preference Persistence**:
   - Store manual power overrides in localStorage
   - Key by device public key or manufacturer string
   - Honor user preference on reconnect

2. **UI Power Indicator**:
   - Show "(auto)" badge when power is auto-set
   - Visual indicator for manual override
   - Tooltip explaining recommended vs custom power

3. **Database Version Check**:
   - Add API endpoint to check for database updates
   - Notify user if new devices are available
   - Auto-refresh database from server

4. **Device Alias Support**:
   - Allow users to set custom display names
   - Store aliases in localStorage
   - Show alias instead of manufacturer string

5. **Power Level Education**:
   - Add help text explaining PA amplifiers
   - Warning modal for dangerous power levels
   - Link to hardware documentation

## References

- MeshCore Firmware: https://github.com/meshcore-dev/MeshCore
- Ikoka Stick platformio.ini: `/variants/ikoka_stick_nrf/platformio.ini`
- Ikoka Nano platformio.ini: `/variants/ikoka_nano_nrf/platformio.ini`
- Board.h pattern: `/variants/*/[BoardName]Board.h`
- EBYTE E22 Datasheets: Various (check hardware specs)

## Changelog

### v1.0.0 (2026-01-04)
- Initial implementation of device model mapping
- Database created from MeshCore firmware repository
- Auto-power selection integrated into connection flow
- Support for 32+ device variants across 4 platforms
- Critical safety handling for PA amplifier models
