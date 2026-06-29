# Ableton RC Bridge — Panel Design Spec v0.4

This document describes the structure and integration details of the new v0.4 Live Panel dialog.

## 1. File Structure
All panel frontend assets reside in the `static/panel/` directory:
- `static/panel/index.html`: Complete HTML skeleton for the three-tab UI and modals.
- `static/panel/style.css`: Clean, dark theme stylesheet conforming to Ableton's color palette.
- `static/panel/app.js`: Local layout switching, WS logic, state representation, and host event bridging.

## 2. Layout & Tabs
The interface is presented as a fixed tabbed panel layout inside Ableton's dialog container:
- **Tab 1: Connect**: Contains dual scannable QR cards (Performance & Mix) with offline placeholders, a connection status strip displaying active clients count, and a 4x3 grid of the 12 most common sensor channels displaying real-time values, sparklines, and active/inactive status.
- **Tab 2: Mappings**: A split panel mappings manager:
  - *Left Column*: Search-filtered list of all 30+ mappable controls grouped by category.
  - *Right Column*: Selected control details displaying active values, target parameters list (removable chips), a "Bind to..." button opening a parameter picker modal, and a range min/max selector.
- **Tab 3: Interfaces**: Shows primary LAN IP, hostname, connection mode parameters (port, protocol, cert fingerprint), and copy buttons for other available LAN addresses.

## 3. Host Integration (`src/extension.ts`)
To register and load the new panel:
1. Wire `showPanelDialog` to open the local server URL instead of rendering an inline data:URI:
   `const url = \`http://127.0.0.1:\${port}/static/panel/index.html\`;`
   `return await context.ui.showModalDialog(url, 720, 700);`
2. Add a `getServerInfo` command handler in the `commands` registry of `extension.ts` returning the server state:
   - `isRunning`, `port`, `httpsPort`, `useHttps`
   - `primaryIp`, `otherIps`
   - `phoneUrl`, `mixUrl`, `adminUrl`
   - `qrSrc`, `mixQrSrc`
   - `statusText`

## 4. WebSocket APIs Used
The panel communicates with the host server over WebSocket `ws://127.0.0.1:{port}/admin/ws` using:
- **Incoming events**: `client_update` messages (to render active state, packet count, and grid sparklines).
- **Outgoing requests**:
  - `getServerInfo`: Called on initialization and periodic poll to update server metrics and URLs.
  - `getTargets`: Called on load to cache all bindable device parameters.
  - `getMappings`: Fetches current control mappings array.
  - `setMapping`: Updates target mappings and outMin/outMax bounds.
  - `removeMapping`: Deletes mapping bound to a control.

## 5. UI Mechanics
- **Resize Handle**: Located at the bottom right. Dragging updates window dimensions and writes size to `localStorage["ableton-rc:panel-size"]` for persistence.
- **Sparklines**: Hand-rolled 120x16 SVG paths rendering rolling history buffers of 30 samples.
- **Responsiveness**: Elements collapse to name/value under 420px; tab headers collapse to symbols under 360px.
- **Compatibility**: Standard layout styles and plain RGBA selectors are used, guaranteeing rendering stability under Windows WebKit engines.
