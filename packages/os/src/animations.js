// Animations — how windows arrive and leave.
//
// A motion preset is NOT a CSS string. It is a small closed record of numbers
// (opacity, scale, offset, rotation, blur) that we compile into keyframes here.
// That is deliberate: the OS document is writable by an agent, and an agent that
// can write raw CSS into the parent frame can do rather more than animate a
// window. Numbers in, stylesheet out — the expressive range stays wide and the
// injection surface stays closed.

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

/** The shape of one end of a transition. Every field is optional. */
export function cleanKeyframe(k) {
  const out = {};
  if (k == null || typeof k !== "object") return out;
  if (k.opacity != null) out.opacity = clamp(k.opacity, 0, 1, 1);
  if (k.scale != null) out.scale = clamp(k.scale, 0.1, 3, 1);
  if (k.scaleX != null) out.scaleX = clamp(k.scaleX, 0.1, 3, 1);
  if (k.scaleY != null) out.scaleY = clamp(k.scaleY, 0.1, 3, 1);
  if (k.x != null) out.x = clamp(k.x, -2000, 2000, 0);
  if (k.y != null) out.y = clamp(k.y, -2000, 2000, 0);
  if (k.rotate != null) out.rotate = clamp(k.rotate, -180, 180, 0);
  if (k.blur != null) out.blur = clamp(k.blur, 0, 40, 0);
  return out;
}

const EASINGS = {
  spring: "cubic-bezier(.16,1.02,.3,1)",
  smooth: "cubic-bezier(.4,0,.2,1)",
  snap: "cubic-bezier(.2,.9,.2,1)",
  linear: "linear",
  ease: "ease",
  "ease-out": "ease-out",
  "ease-in": "ease-in",
};

export const BUILTIN_ANIMATIONS = {
  spring: {
    name: "Spring", duration: 260, easing: "spring",
    open: { from: { opacity: 0, scale: 0.92, y: 10 }, to: {} },
    close: { from: {}, to: { opacity: 0, scale: 0.94, y: 6 } },
  },
  fade: {
    name: "Fade", duration: 180, easing: "smooth",
    open: { from: { opacity: 0 }, to: {} },
    close: { from: {}, to: { opacity: 0 } },
  },
  genie: {
    name: "Genie", duration: 320, easing: "smooth",
    open: { from: { opacity: 0, scaleX: 0.3, scaleY: 0.05, y: 180 }, to: {} },
    close: { from: {}, to: { opacity: 0, scaleX: 0.3, scaleY: 0.05, y: 180 } },
  },
  pop: {
    name: "Pop", duration: 200, easing: "snap",
    open: { from: { opacity: 0, scale: 0.8 }, to: {} },
    close: { from: {}, to: { opacity: 0, scale: 0.86 } },
  },
  blur: {
    name: "Blur In", duration: 280, easing: "smooth",
    open: { from: { opacity: 0, blur: 14, scale: 1.02 }, to: {} },
    close: { from: {}, to: { opacity: 0, blur: 10 } },
  },
  slide: {
    name: "Slide Up", duration: 240, easing: "spring",
    open: { from: { opacity: 0, y: 40 }, to: {} },
    close: { from: {}, to: { opacity: 0, y: 30 } },
  },
  none: {
    name: "Instant", duration: 0, easing: "linear",
    open: { from: {}, to: {} }, close: { from: {}, to: {} },
  },
};

export const DEFAULT_ANIMATION = "spring";

/** Sanitize a whole custom preset: numbers clamped, easing from the closed set. */
export function cleanAnimation(a) {
  if (a == null || typeof a !== "object") return null;
  return {
    name: String(a.name ?? "Custom").slice(0, 48),
    duration: clamp(a.duration, 0, 2000, 240),
    easing: EASINGS[a.easing] ? a.easing : "smooth",
    open: { from: cleanKeyframe(a.open?.from), to: cleanKeyframe(a.open?.to) },
    close: { from: cleanKeyframe(a.close?.from), to: cleanKeyframe(a.close?.to) },
  };
}

function frameCss(k) {
  const tf = [];
  if (k.x != null || k.y != null) tf.push(`translate3d(${k.x ?? 0}px, ${k.y ?? 0}px, 0)`);
  if (k.scale != null) tf.push(`scale(${k.scale})`);
  if (k.scaleX != null || k.scaleY != null) tf.push(`scale(${k.scaleX ?? 1}, ${k.scaleY ?? 1})`);
  if (k.rotate != null) tf.push(`rotate(${k.rotate}deg)`);
  const decls = [];
  if (k.opacity != null) decls.push(`opacity: ${k.opacity}`);
  if (tf.length) decls.push(`transform: ${tf.join(" ")}`);
  if (k.blur != null) decls.push(`filter: blur(${k.blur}px)`);
  if (!decls.some((d) => d.startsWith("transform"))) decls.push("transform: none");
  if (!decls.some((d) => d.startsWith("filter"))) decls.push("filter: none");
  return decls.join("; ");
}

/** Resolve the active preset: a custom one by key, else a built-in, else Spring. */
export function resolveAnimation(doc) {
  const key = doc?.animation?.preset ?? DEFAULT_ANIMATION;
  const custom = doc?.animation?.custom?.[key];
  const preset = custom ? cleanAnimation(custom) : BUILTIN_ANIMATIONS[key];
  return { key, ...(preset ?? BUILTIN_ANIMATIONS[DEFAULT_ANIMATION]) };
}

export function listAnimations(doc) {
  const out = Object.entries(BUILTIN_ANIMATIONS).map(([key, a]) => ({ key, name: a.name, builtin: true, duration: a.duration }));
  for (const [key, a] of Object.entries(doc?.animation?.custom ?? {})) {
    out.push({ key, name: a.name ?? key, builtin: false, duration: a.duration ?? 240 });
  }
  return out;
}

/** Compile the active preset into the keyframes + custom properties the shell uses. */
export function animationCss(anim) {
  const ease = EASINGS[anim.easing] ?? EASINGS.smooth;
  return [
    "@keyframes os-open {",
    `  from { ${frameCss(anim.open.from)} }`,
    `  to { ${frameCss(anim.open.to)} }`,
    "}",
    "@keyframes os-close {",
    `  from { ${frameCss(anim.close.from)} }`,
    `  to { ${frameCss(anim.close.to)} }`,
    "}",
    ":root {",
    `  --os-anim-duration: ${anim.duration}ms;`,
    `  --os-anim-easing: ${ease};`,
    "}",
    "",
  ].join("\n");
}
