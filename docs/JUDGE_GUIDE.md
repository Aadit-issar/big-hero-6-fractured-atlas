# Judge guide: the live Dimension + ATLAS demonstration

About five minutes. Both applications run locally in Chrome or Edge on a desktop with WebGL2. Nothing is pre-recorded: ATLAS only knows what the running Dimension reports.

Repositories: [Dimension](https://github.com/Aadit-issar/big-hero-6-fractured-dimension) · [ATLAS](https://github.com/Aadit-issar/big-hero-6-fractured-atlas)

## 0. One-time setup (PowerShell)

```powershell
git clone https://github.com/Aadit-issar/big-hero-6-fractured-dimension.git
git clone https://github.com/Aadit-issar/big-hero-6-fractured-atlas.git
```

Requires Node.js 20.19+ or 22.12+ (Node 24 was used during development) with the npm that ships with it.

## 1. Start the Dimension

Easiest, one command for both applications (installs, builds, serves, opens the Dimension):

```powershell
cd big-hero-6-fractured-atlas
powershell -ExecutionPolicy Bypass -File scripts\start-live-demo.ps1
```

This opens two PowerShell server windows (leave them open). Skip to step 3 if you use it.

Manual alternative, two terminals:

```powershell
# Terminal 1 - Dimension
cd big-hero-6-fractured-dimension
npm ci
npm run serve          # builds, then serves http://127.0.0.1:4183/

# Terminal 2 - ATLAS
cd big-hero-6-fractured-atlas
npm ci
npm run serve          # builds, then serves http://127.0.0.1:5184/
```

Open `http://127.0.0.1:4183/?quality=cinematic&view=baymax&atlas=http://127.0.0.1:5184/` in Chrome or Edge. The first load generates island terrain in web workers (a few seconds). Add `quality=performance` instead of `cinematic` on a slow GPU.

## 2. Start ATLAS (linked to that Dimension)

With the Dimension window focused, press **L**. ATLAS opens in a second window already linked to this Dimension session. (Allow pop-ups for `127.0.0.1` if the browser blocks it. Alternatively open `http://127.0.0.1:5184/` and click **Open Dimension and connect**.)

Important: the two windows are linked by the browser's `postMessage`, so one must open the other. Two separately opened tabs cannot find each other.

## 3. Verify the live connection

ATLAS shows a connected state with a session id; the Dimension HUD shows the ATLAS link. If ATLAS still shows "Connect to the running Dimension", see Troubleshooting in the README.

## 4. Move Baymax

Click the Dimension window, then fly: **W/A/S/D** move, **Space** up, **Ctrl** down, **Shift** boost, **click and drag** to look. Hold **W + Shift** for two seconds. Baymax in ATLAS's Tactical Map moves in step with the Dimension.

## 5. Scan

In ATLAS click **Scan**. Objects, islands and folds appear only as they are observed within Baymax's sensor range. (The Dimension shows a sonar pulse; **T** toggles the on-screen scan tags.)

## 6. Inspect discovered objects

In **Tactical map**, use the target list (search and category filters) or click objects on the map. Objects out of range remain as translucent *remembered* last-known records.

## 7. Select Abigail's capsule

Select **Abigail's Capsule** (one of the quick targets) in the target list. It is the flagship moving target.

## 8. Open Predictive Analysis

Click the **Predictive analysis** mode ("Where will it go?"). Keep Baymax within sensor range and keep scanning: a first forecast needs about 6 to 10 seconds of observation, and ATLAS states why it has none until then.

## 9. Observe the forecast

A history trail, the capsule now, and a translucent copy of the capsule at the forecast position with an uncertainty volume are drawn. The time scrubber previews future positions only. The list of frozen forecasts compares earlier predictions with what was later observed.

## 10. Open Route Planning

Click **Route planning** ("Where must Baymax go, and why?").

## 11. Select Baymax's speed

Drag the **Baymax speed** slider (4 to 42 m/s). The plan recomputes immediately from the same observations ("recomputed at N m/s").

## 12. Inspect the predicted interception

The map shows the planned route, the capsule's forecast path, an amber **PLANNED RENDEZVOUS** marker (or **AIM POINT** when only a limited lead is trusted) and a Baymax hologram at arrival. The panel gives the ETA and why this route was chosen.

## 13. Send the route to the Dimension

Click **Send to Baymax**. The Dimension acknowledges it; ATLAS shows the route state. (**Preview** replays the plan in ATLAS only; **Cancel** withdraws a sent route.)

## 14. Follow the visible 3D route

Switch to the Dimension window. A dashed route line, waypoint markers with distances and a rendezvous reticle appear in the 3D scene, plus a translucent projection of the capsule where ATLAS predicts it will be. Fly along the waypoints (Shift to boost; **V** toggles Baymax view and first-person). Close in, the HUD switches to a precise reticle with offsets.

## 15. Moving target and rendezvous

The capsule keeps moving while you fly. As new observations arrive ATLAS recalculates and sends revised routes, stating the reason ("New observations moved the predicted meeting point 3.6 m. Interception recalculated."). The Dimension decides the outcome from true positions: **arrived** when Baymax comes within the capture radius of the capsule's actual position (6.4 m), otherwise **missed**. A miss is a legitimate result: forecasts are local extrapolations with finite skill, and prediction does not magically beat a chase against this slow capsule (see `docs/ATLAS_LIVE_FINAL_ARCHITECTURE.md`, section 8).

Optional: in the target list select a **fold** (route to its entrance; where a fold leads is never inferred) or an **island** (hover point above it) and send that route instead.

## Stopping

Close the two PowerShell server windows (or press Ctrl+C in each).
