// presets.js — multi-viewport stage presets and scale math for Studio.
//
// The Studio stage renders a real machine, not a mockup pane. Viewport presets
// define the target canvas size (desktop, tablet, phone, or fit to pane).
// When a preset is chosen, the screen canvas maintains fixed target dimensions
// and is scaled via CSS transform to fit the stage viewport without prematurely
// collapsing into the phone/compact layout on desktop or tablet viewports.

export const DEVICES = Object.freeze([
  { id: "desktop", name: "Desktop", w: 1440, h: 900 },
  { id: "tablet", name: "Tablet", w: 1024, h: 768 },
  { id: "phone", name: "Phone", w: 375, h: 667 },
  { id: "fit", name: "Fit", w: null, h: null },
]);

export function deviceOf(id) {
  return DEVICES.find((d) => d.id === id) ?? DEVICES[0];
}

/**
 * Calculate scaled stage geometry for a given device and container pane size.
 *
 * @param {object} opts
 * @param {number} opts.paneWidth  Width of the stage viewport container
 * @param {number} opts.paneHeight Height of the stage viewport container
 * @param {object} opts.device     Selected device preset { id, name, w, h }
 * @param {number} [opts.pad=28]   Padding to reserve around the scaled canvas
 */
export function computeStageLayout({ paneWidth, paneHeight, device, pad = 28 }) {
  const dev = typeof device === "string" ? deviceOf(device) : (device ?? DEVICES[0]);
  if (!dev.w || !dev.h) {
    return {
      device: dev,
      staged: false,
      scale: 1,
      width: null,
      height: null,
      transform: "",
    };
  }

  const availW = Math.max(10, paneWidth - pad);
  const availH = Math.max(10, paneHeight - pad);
  const scale = Math.min(1, Math.min(availW / dev.w, availH / dev.h));

  return {
    device: dev,
    staged: true,
    scale,
    width: dev.w,
    height: dev.h,
    transform: `translate(-50%, -50%) scale(${scale})`,
  };
}

/**
 * Format badge text for the Studio stage bar.
 */
export function formatStageBadge({ stageMode = "design", device, scale = 1, doc }) {
  const dev = typeof device === "string" ? deviceOf(device) : (device ?? DEVICES[0]);
  const size = dev.w
    ? `${dev.w}×${dev.h}${scale < 0.995 ? ` · ${Math.round(scale * 100)}%` : ""}`
    : "fit";
  const wmMode = doc?.wm?.mode ?? "floating";
  const ws = doc?.activeWorkspace ?? 1;
  const rev = doc?.rev ?? 0;
  return `${stageMode} · ${size} · ${wmMode} · ws ${ws} · r${rev}`;
}
