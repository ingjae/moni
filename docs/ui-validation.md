# v0.0.3 UI validation — 2026-10-16

Environment: Ubuntu 24.04, GNOME Shell 46.0 / Mutter 46.2. Tests ran in isolated nested Wayland sessions hosted by the existing X11 desktop. Extension settings and display modes were isolated from the user's installed v0.0.1 instance.

## Results

| Check | Result |
|---|---|
| 800×600, light and dark themes, text size 100%, 125%, 150%, 200% | Passed all eight combinations; menu fits the screen, details use normal theme text color, capture actions and Settings remain visible |
| 1024×768, text size 150% | Inspected capture editor, dashboard and panel |
| 1280×800, light and dark themes | Inspected baseline dashboard and scrolling to storage/robotics |
| 1280×1200, light and dark themes, final menu implementation | Passed geometry, text color, scroll section parent registration checks |
| 1920×1080, display scale 200%, light and dark themes | Passed menu geometry and text color checks |
| Screenshot selection → GTK editor | Actual captured PNG opened in the editor |
| Escape during selection | Capture returned to idle |
| Copy | Actual PNG clipboard content verified (91,985 bytes in the test) |
| Save | PNG file creation verified |
| Pin | Exported PNG, editor exit and visible pinned actor verified |
| Screen recording start/stop | Actual 550×350 VP8/WebM generated; GStreamer reported a playable, seekable 3.708-second recording; REC badge visible while recording and recording state cleared after stop |
| GTK editor rendering | All eight tools exercised; drawing tools individually change pixels, Unicode text renders, exports preserve source resolution, undo restores baseline output, coordinates clamp to image boundaries |
| Failure and crowded-panel regressions | Stop success/refusal/timeout, duplicate-stop prevention, CAN warning priority, smaller chip fitting and shortest rosbag ETA passed |
| Extension lifecycle | Repeated disable/enable and subsequent menu opening checked in the isolated session |

The initial isolated recording attempt encountered an unavailable PipeWire connection: failure was reported and no recording state was created. After connecting the isolated session to the local PipeWire socket, actual recording succeeded.

## Fixes found by these checks

- Informational rows inherited disabled text colors despite full opacity. Set their labels to the current menu theme foreground color.
- Long host/GPU names widened the menu beyond an 800-pixel display at 200% text size. Bound card header width and let titles ellipsize.
- Panel fitting waited for a sampling tick after theme or size changes. Refit before redraw when relevant geometry or the theme changes.
- A fully hidden panel became an empty target. Keep a small monitor icon available; hidden alerts color the icon.
- Keep the scrolling section registered with PopupMenu so parent routing, sensitivity and destruction still work.
- GJS Cairo has no `textPath` method. Use PangoCairo paths for text annotations, including Unicode.
- Calculate graph time labels from allocated graph width and sample intervals.

## Reproduction

Run `make test` for collector, recording/fitting regression, build and legacy syntax checks. Run `make test-ui` in a graphical session for the real GTK renderer test. For HiDPI validation, run the GTK test in a nested GNOME session configured with `MUTTER_DEBUG_DUMMY_MONITOR_SCALES=2`.

Screenshots and session logs from this run are local under `build/ui-validation/`; they are not published because they include host/interface information. The README screenshots predate these fixes.

## Coverage limits

This validates a real GNOME 46 nested compositor and GTK4, including both display scale factors available in the test backend (1 and 2). It does not establish native X11 capture behavior, fractional monitor scaling, multi-monitor behavior, GNOME 42–44 session compatibility, or Jetson hardware compatibility. Those require additional environments or hardware. Legacy collectors and generated syntax checks passed; hardware-specific claims remain unchanged.
