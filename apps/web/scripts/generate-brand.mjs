/**
 * OpenKit brand generator (DESIGN.md §8.2).
 *
 * Builds the golden-ratio mark, the Nunito SemiBold wordmark, and the loader
 * and standby motion described in DESIGN.md §8.2. The loader plays the intro
 * once, then the loading loop shifted so its cycle opens with the 0.95 s hold.
 * Standby keeps the bands still and runs that loop's star opacity only.
 * Letter outlines come from nunito-semibold-penkit.json; do not hand-edit SVGs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = 33;
const DRIFT = 0.8;
const PHI = (1 + Math.sqrt(5)) / 2;
const SPARK_V = 20;
const SPARK_H = 15.5;
const BIG_STAR_HOUR = 9.85;
const OPENINGS = [BIG_STAR_HOUR, 5.5, 1.5];
const GAP_DEGREES = [80, 105, 150];
const SPARK_HOURS = [BIG_STAR_HOUR, 8.2, 11.85];
const O_SIZE = 1.08;
const CAP = 60;
const NUNITO = { cap: 71.2, opGap: 12.8, left: -7.1, right: 298.1, desc: 18.7 };
const LETTERS = 'penKit';

const SPIN = [0.45, 0, 0.2, 1];
const POP = [0.2, 0.7, 0.3, 1];
const SETTLE = [0.4, 0, 0.6, 1];
const FADE = [0.4, 0, 1, 1];
const FADE_IN = [0.25, 0.1, 0.25, 1];
const HOLD = [0, 0, 1, 1];
const TURN = 1.2;
const STAGGER = 0.15;
const APPEAR = 0.6;
const LIGHT_AT = 1.4;
const LIGHT_STEP = 0.2;
const RISE = 0.25;
const GLOW = 0.2;
const FADE_OUT = 0.25;
const LOOP = 3.2;
const LOOP_SHIFT = 2.25;
const ON = { r: 0, s: 1, o: 1 };
const OFF = { r: -30, s: 0.3, o: 0 };
const OUT_STATE = { r: 0, s: 0.6, o: 0 };
const PEAK = { r: 0, s: 1.08, o: 1 };

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const font = JSON.parse(
  readFileSync(new URL('./nunito-semibold-penkit.json', import.meta.url), 'utf8')
);

/** Format a drawn coordinate to two decimals, without trailing zeros. */
function f(value) {
  const text = value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

function clock(hour) {
  return (hour - 3) * 30;
}

function ladder(step) {
  return 20 * PHI ** (step / 2);
}

function arcPoints(cx, cy, radius, a0, a1, count = 12) {
  const points = [];
  for (let i = 0; i <= count; i += 1) {
    const angle = a0 + ((a1 - a0) * i) / count;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return points;
}

/** Constant-width open band with round caps. th0/sweep are screen degrees, clockwise. */
function ribbon(th0, sweep, r0, r1, width, count = 360) {
  const start = (th0 * Math.PI) / 180;
  const turn = (sweep * Math.PI) / 180;
  const centre = [];
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const angle = start + turn * t;
    const radius = r0 + (r1 - r0) * t;
    centre.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  const left = [];
  const right = [];
  const tangents = [];
  for (let i = 0; i < centre.length; i += 1) {
    const [x, y] = centre[i];
    const before = centre[Math.max(i - 1, 0)];
    const after = centre[Math.min(i + 1, count)];
    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const length = Math.hypot(dx, dy);
    const nx = ((-dy / length) * width) / 2;
    const ny = ((dx / length) * width) / 2;
    left.push([x + nx, y + ny]);
    right.push([x - nx, y - ny]);
    tangents.push(Math.atan2(dy, dx));
  }
  const end = centre[centre.length - 1];
  const endAngle = tangents[tangents.length - 1];
  const startPoint = centre[0];
  const startAngle = tangents[0];
  return [
    ...left,
    ...arcPoints(end[0], end[1], width / 2, endAngle + Math.PI / 2, endAngle - Math.PI / 2),
    ...right.reverse(),
    ...arcPoints(
      startPoint[0],
      startPoint[1],
      width / 2,
      startAngle - Math.PI / 2,
      startAngle - (3 * Math.PI) / 2
    ),
  ];
}

function rotate(points, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return points.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

function orbit(widths, spacing) {
  const shapes = [];
  let edge = R;
  for (let i = 0; i < widths.length; i += 1) {
    const width = widths[i];
    const gap = spacing[i] ?? 0;
    const radius = edge - width / 2;
    shapes.push(
      ribbon(
        clock(OPENINGS[i]) + GAP_DEGREES[i] / 2,
        360 - GAP_DEGREES[i],
        radius,
        radius - DRIFT,
        width
      )
    );
    edge = radius - width / 2 - gap;
  }
  return shapes;
}

function sparkSegments(scale) {
  const tips = [
    [0, -SPARK_V * scale],
    [SPARK_H * scale, 0],
    [0, SPARK_V * scale],
    [-SPARK_H * scale, 0],
  ];
  return tips.map((tip, index) => {
    const next = tips[(index + 1) % 4];
    return [
      tip,
      [tip[0] * 0.3 + next[0] * 0.07, tip[1] * 0.3 + next[1] * 0.07],
      [next[0] * 0.3 + tip[0] * 0.07, next[1] * 0.3 + tip[1] * 0.07],
      next,
    ];
  });
}

function sparkPath() {
  const segments = sparkSegments(1);
  let d = `M${f(segments[0][0][0])},${f(segments[0][0][1])}`;
  for (const [, c0, c1, p1] of segments) {
    d += ` C${f(c0[0])},${f(c0[1])} ${f(c1[0])},${f(c1[1])} ${f(p1[0])},${f(p1[1])}`;
  }
  return `${d}Z`;
}

function sparkOutline(scale, count = 24) {
  const points = [];
  for (const [p0, c0, c1, p1] of sparkSegments(scale)) {
    for (let i = 0; i < count; i += 1) {
      const t = i / count;
      const a = (1 - t) ** 3;
      const b = 3 * t * (1 - t) ** 2;
      const c = 3 * t * t * (1 - t);
      const d = t ** 3;
      points.push([
        a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0],
        a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1],
      ]);
    }
  }
  return points;
}

function clearance(star, cx, cy, points, reach) {
  const reach2 = reach * reach;
  let best = Number.POSITIVE_INFINITY;
  for (const [x, y] of points) {
    if ((x - cx) ** 2 + (y - cy) ** 2 >= reach2) continue;
    for (const [sx, sy] of star) best = Math.min(best, Math.hypot(cx + sx - x, cy + sy - y));
  }
  return best;
}

function place(shapes, hour, gap, scale) {
  const angle = (clock(hour) * Math.PI) / 180;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const star = sparkOutline(scale);
  const points = shapes.flat();
  const reach = SPARK_V * scale + gap + 2;
  let distance = R + 60;
  while (distance > 0 && clearance(star, distance * ux, distance * uy, points, reach) > gap) {
    distance -= 1;
  }
  let lo = distance;
  let hi = distance + 1;
  for (let i = 0; i < 12; i += 1) {
    const mid = (lo + hi) / 2;
    if (clearance(star, mid * ux, mid * uy, points, reach) < gap) lo = mid;
    else hi = mid;
  }
  return [hi * ux, hi * uy];
}

function buildGolden() {
  const system = {
    radius: ladder(2),
    star: ladder(0),
    bands: [ladder(-4), ladder(-5), ladder(-6)],
    spacing: [ladder(-7), ladder(-7)],
    clear: [ladder(-7), ladder(-7), ladder(-5)],
    comps: [ladder(-4), ladder(-5)],
  };
  const k = R / system.radius;
  const bands = orbit(
    system.bands.map((width) => width * k),
    system.spacing.map((gap) => gap * k)
  );
  const sizes = [system.star, ...system.comps];
  const sparks = SPARK_HOURS.map((hour, index) => {
    const scale = (sizes[index] * k) / SPARK_V;
    const [x, y] = place(bands, hour, system.clear[index] * k, scale);
    return [x, y, scale];
  });
  return { bands, sparks };
}

function bbox(shapes, sparks) {
  const xs = shapes.flatMap((shape) => shape.map(([x]) => x));
  const ys = shapes.flatMap((shape) => shape.map(([, y]) => y));
  for (const [x, y, scale] of sparks) {
    xs.push(x - SPARK_H * scale, x + SPARK_H * scale);
    ys.push(y - SPARK_V * scale, y + SPARK_V * scale);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function squareViewBox(shapes, sparks, pad) {
  const [x0, y0, x1, y1] = bbox(shapes, sparks);
  const size = Math.max(x1 - x0, y1 - y0) * pad;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return [cx - size / 2, cy - size / 2, size, size];
}

function pathD(points) {
  const [head, ...rest] = points;
  return `M${f(head[0])},${f(head[1])}${rest.map(([x, y]) => ` L${f(x)},${f(y)}`).join('')}Z`;
}

function bandStart(band) {
  return (2 - band) * STAGGER;
}

function bandTrack(band, end) {
  const t0 = bandStart(band);
  return [
    [0, { r: 0 }, HOLD],
    [t0, { r: 0 }, SPIN],
    [t0 + TURN, { r: 360 }, HOLD],
    [end, { r: 360 }, HOLD],
  ];
}

function fadeTrack(band, end) {
  const t0 = bandStart(band);
  return [
    [0, { o: 0 }, HOLD],
    [t0, { o: 0 }, FADE_IN],
    [t0 + APPEAR, { o: 1 }, HOLD],
    [end, { o: 1 }, HOLD],
  ];
}

function sparkTrack(spark, loop, end) {
  const t0 = LIGHT_AT + spark * LIGHT_STEP;
  const head = loop
    ? [
        [0, ON, FADE],
        [FADE_OUT, OUT_STATE, HOLD],
        [FADE_OUT + 0.01, OFF, HOLD],
      ]
    : [[0, OFF, HOLD]];
  return [
    ...head,
    [t0, OFF, POP],
    [t0 + RISE, PEAK, SETTLE],
    [t0 + RISE + GLOW, ON, HOLD],
    [end, ON, HOLD],
  ];
}

function introEnd() {
  return LIGHT_AT + 2 * LIGHT_STEP + RISE + GLOW;
}

function tracks(kind) {
  if (kind === 'intro') {
    const end = introEnd();
    return {
      b: [0, 1, 2].map((band) => bandTrack(band, end)),
      f: [0, 1, 2].map((band) => fadeTrack(band, end)),
      s: [0, 1, 2].map((spark) => sparkTrack(spark, false, end)),
    };
  }
  return {
    b: [0, 1, 2].map((band) => bandTrack(band, LOOP)),
    s: [0, 1, 2].map((spark) => sparkTrack(spark, true, LOOP)),
  };
}

function sameValues(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

/**
 * Shift the loading loop so its 0 s keyframe lands at 0.95 s.
 * A rotation jump of 360° to 0° is inserted at that seam; it is invisible.
 */
function shiftLoopTrack(track) {
  const frames = [];
  for (let index = 0; index < track.length; index += 1) {
    const [time, values, ease] = track[index];
    if (time >= LOOP - 1e-9) continue;
    let shifted = time - LOOP_SHIFT;
    if (shifted < -1e-9) shifted += LOOP;
    if (Math.abs(shifted) < 1e-9) shifted = 0;
    frames.push({ time: shifted, values, ease, order: index });
  }
  const start = track[0][1];
  const end = track[track.length - 1][1];
  if (!sameValues(start, end)) {
    frames.push({ time: LOOP - LOOP_SHIFT - 0.001, values: end, ease: HOLD, order: -1 });
  }
  frames.sort((a, b) => a.time - b.time || a.order - b.order);
  const collapsed = [];
  for (const frame of frames) {
    const previous = collapsed[collapsed.length - 1];
    if (
      previous &&
      Math.abs(previous.time - frame.time) < 1e-9 &&
      sameValues(previous.values, frame.values)
    ) {
      previous.ease = frame.ease;
    } else collapsed.push({ ...frame, values: { ...frame.values } });
  }
  if (collapsed[0].time > 1e-9) {
    collapsed.unshift({ time: 0, values: valueAt(track, LOOP_SHIFT), ease: HOLD, order: -2 });
  }
  const opening = collapsed.find((frame) => frame.time < 1e-9);
  collapsed.push({ time: LOOP, values: { ...opening.values }, ease: HOLD, order: 999 });
  return collapsed.map((frame) => [frame.time, frame.values, frame.ease]);
}

function bezier(ease, x) {
  const [x1, y1, x2, y2] = ease;
  const coord = (p1, p2, s) => 3 * p1 * s * (1 - s) ** 2 + 3 * p2 * s * s * (1 - s) + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (coord(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return coord(y1, y2, (lo + hi) / 2);
}

function valueAt(track, time) {
  for (let i = 0; i < track.length - 1; i += 1) {
    const [t0, v0, ease] = track[i];
    const [t1, v1] = track[i + 1];
    if (t0 <= time && time <= t1) {
      const y = t1 > t0 ? bezier(ease, (time - t0) / (t1 - t0)) : 1;
      const values = {};
      for (const key of Object.keys(v0)) values[key] = v0[key] + (v1[key] - v0[key]) * y;
      return values;
    }
  }
  return { ...track[track.length - 1][1] };
}

function cssValue(values, calm) {
  const parts = [];
  if (!calm && (values.r !== undefined || values.s !== undefined)) {
    const transform = [];
    if (values.r !== undefined) transform.push(`rotate(${f(values.r)}deg)`);
    if (values.s !== undefined) transform.push(`scale(${f(values.s)})`);
    parts.push(`transform:${transform.join(' ')}`);
  }
  if (values.o !== undefined) parts.push(`opacity:${f(values.o)}`);
  return parts.join(';');
}

function keyframes(name, track, period, calm = false) {
  const rendered = [];
  for (const [time, values, ease] of track) {
    const pct = ((time / period) * 100).toFixed(3);
    const previous = rendered[rendered.length - 1];
    if (previous && previous.pct === pct) {
      if (!sameValues(previous.values, values)) {
        throw new Error(`${name} has conflicting keyframes at ${pct}%`);
      }
      previous.ease = ease;
      continue;
    }
    rendered.push({ pct, values, ease });
  }
  const frames = rendered
    .map(({ pct, values, ease }) => {
      const easing = ease.map((part) => f(part)).join(',');
      return `${pct}%{${cssValue(values, calm)};animation-timing-function:cubic-bezier(${easing})}`;
    })
    .join('');
  return `@keyframes ${name}{${frames}}`;
}

function animationTiming(period, loop, delay = 0) {
  const count = loop ? 'infinite' : '1';
  // A delayed animation with fill-mode both paints its first keyframe during the
  // delay and would hide the intro. Forwards applies only after the delay.
  const fill = delay > 0 ? 'forwards' : 'both';
  const wait = delay > 0 ? ` ${f(delay)}s` : '';
  return `${f(period)}s linear${wait} ${count} ${fill}`;
}

function motionBundle(kind, namePrefix) {
  const source = kind === 'loop' ? null : tracks(kind);
  const period = kind === 'intro' ? introEnd() : LOOP;
  const group = {};
  if (kind === 'loop') {
    const loading = tracks('loading');
    group.b = loading.b.map((track) => shiftLoopTrack(track));
    group.s = loading.s.map((track) => shiftLoopTrack(track));
  } else {
    Object.assign(group, source);
  }
  const frames = [];
  const parts = [];
  for (const [partKind, partTracks] of Object.entries(group)) {
    partTracks.forEach((track, index) => {
      const name = `${namePrefix}-${partKind}${index}`;
      frames.push(keyframes(name, track, period));
      let calm = 'animation:none';
      if (track[0][1].o !== undefined) {
        frames.push(keyframes(`${name}-calm`, track, period, true));
        calm = `animation:${name}-calm ${animationTiming(period, kind !== 'intro')}`;
      }
      parts.push({
        name,
        full: `animation:${name} ${animationTiming(period, kind !== 'intro')}`,
        calm,
        kind: partKind,
        index,
      });
    });
  }
  return { frames, parts, period };
}

function loaderCss(prefix) {
  const intro = motionBundle('intro', `${prefix}-intro`);
  const loop = motionBundle('loop', `${prefix}-loop`);
  const names = [...intro.parts, ...loop.parts].map((part) => `.${part.name}`);
  const rules = [
    `${names.join(',')}{transform-box:view-box;transform-origin:0 0}`,
    ...intro.frames,
    ...loop.frames,
  ];
  const fade = intro.parts.filter((part) => part.kind === 'f');
  const paired = intro.parts.filter((part) => part.kind !== 'f');
  for (const part of fade) rules.push(`.${part.name}{${part.full}}`);
  for (const part of paired) {
    const later = loop.parts.find((item) => item.kind === part.kind && item.index === part.index);
    const loopTiming = animationTiming(LOOP, true, LOOP_SHIFT);
    rules.push(
      `.${part.name}.${later.name}{animation:${part.name} ${animationTiming(intro.period, false)},${later.name} ${loopTiming}}`
    );
  }
  const calm = ['@media (prefers-reduced-motion:reduce){'];
  for (const part of paired.filter((item) => item.kind === 'b')) {
    const later = loop.parts.find((item) => item.kind === 'b' && item.index === part.index);
    calm.push(`.${part.name}.${later.name}{animation:none}`);
  }
  for (const part of fade) calm.push(`.${part.name}{${part.calm}}`);
  for (const part of paired.filter((item) => item.kind === 's')) {
    const later = loop.parts.find((item) => item.kind === 's' && item.index === part.index);
    calm.push(
      `.${part.name}.${later.name}{animation:${part.name}-calm ${animationTiming(intro.period, false)},${later.name}-calm ${animationTiming(LOOP, true, LOOP_SHIFT)}}`
    );
  }
  calm.push('}');
  rules.push(calm.join(''));
  return rules.join('');
}

function standbyCss(prefix) {
  const stars = tracks('loading').s.map((track, index) => ({
    name: `${prefix}-s${index}`,
    track: shiftLoopTrack(track),
  }));
  return [
    `${stars.map((star) => `.${star.name}`).join(',')}{transform-box:view-box;transform-origin:0 0}`,
    ...stars.map((star) => keyframes(star.name, star.track, LOOP, true)),
    ...stars.map((star) => `.${star.name}{animation:${star.name} ${animationTiming(LOOP, true)}}`),
  ].join('');
}

function prefixRefs(svg, prefix) {
  return svg
    .replaceAll('id="', `id="${prefix}-`)
    .replaceAll('url(#', `url(#${prefix}-`)
    .replaceAll('href="#', `href="#${prefix}-`);
}

function markDefs() {
  return (
    `<linearGradient id="vortex" x1="${f(-R)}" y1="${f(-R)}" x2="${f(R)}" y2="${f(R)}" gradientUnits="userSpaceOnUse">` +
    '<stop offset="0" stop-color="#FFD65E"/><stop offset="0.5" stop-color="#FFC233"/>' +
    '<stop offset="1" stop-color="#EE9F00"/></linearGradient>' +
    '<linearGradient id="sparkfill" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#FFD860"/><stop offset="1" stop-color="#F7B400"/></linearGradient>' +
    `<path id="S" d="${sparkPath()}"/>`
  );
}

function markBody(design, mode) {
  const bands = design.bands
    .map((shape, index) => {
      const path = `<path${bandClass(mode, index)} d="${pathD(shape)}"/>`;
      if (mode !== 'loader') return path;
      return `<g class="intro-f${index}">${path}</g>`;
    })
    .join('');
  const sparkCount = mode === 'small' ? 1 : mode === 'bands' ? 0 : 3;
  const sparks = design.sparks
    .slice(0, sparkCount)
    .map(
      ([x, y, scale], index) =>
        `<g transform="translate(${f(x)} ${f(y)}) scale(${f(scale)})"><use${sparkClass(mode, index)} href="#S"/></g>`
    )
    .join('');
  return (
    `<g fill="url(#vortex)">${bands}</g>` +
    `<g fill="url(#sparkfill)" stroke="url(#sparkfill)" stroke-width="0.9" stroke-linejoin="round">${sparks}</g>`
  );
}

function bandClass(mode, index) {
  if (mode === 'loader') return ` class="intro-b${index} loop-b${index}"`;
  return '';
}

function sparkClass(mode, index) {
  if (mode === 'loader') return ` class="intro-s${index} loop-s${index}"`;
  if (mode === 'standby') return ` class="star-s${index}"`;
  return '';
}

function renameMotionClasses(svg, prefix, mode) {
  if (mode === 'loader') {
    return svg
      .replaceAll('class="intro-', `class="${prefix}-intro-`)
      .replaceAll(' loop-', ` ${prefix}-loop-`);
  }
  if (mode === 'standby') return svg.replaceAll('class="star-', `class="${prefix}-`);
  return svg;
}

function svgDocument({ prefix, viewBox, label, style, defs, body, background }) {
  const [x, y, w, h] = viewBox;
  const painted = background
    ? `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${background}"/>${body}`
    : body;
  const xml =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}" height="${f(h)}" viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" role="img" aria-label="${label}">` +
    `${style}<defs>${defs}</defs>${painted}</svg>\n`;
  return prefixRefs(xml, prefix);
}

function markSvg(design, { prefix, label, pad, sparks, background, mode }) {
  const selected = sparks === 'big' ? [design.sparks[0]] : sparks === 'none' ? [] : design.sparks;
  const viewBox = squareViewBox(design.bands, selected, pad);
  const style =
    mode === 'loader'
      ? `<style>${loaderCss(prefix)}</style>`
      : mode === 'standby'
        ? `<style>${standbyCss(prefix)}</style>`
        : '';
  const body = renameMotionClasses(markBody(design, mode), prefix, mode);
  return svgDocument({
    prefix,
    viewBox,
    label,
    style,
    defs: markDefs(),
    body,
    background,
  });
}

function contourPath(contour) {
  const points = contour.map((point) => ({ ...point }));
  if (!points[0].on) {
    const last = points[points.length - 1];
    if (last.on) points.unshift(points.pop());
    else {
      points.unshift({
        x: (points[0].x + last.x) / 2,
        y: (points[0].y + last.y) / 2,
        on: true,
      });
    }
  }
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const next = points[i];
    if (next.on) {
      d += `L${f(next.x)} ${f(next.y)}`;
      continue;
    }
    const next2 = i + 1 < points.length ? points[i + 1] : points[0];
    if (next2.on) {
      d += `Q${f(next.x)} ${f(next.y)} ${f(next2.x)} ${f(next2.y)}`;
      if (i + 1 < points.length) i += 1;
    } else {
      d += `Q${f(next.x)} ${f(next.y)} ${f((next.x + next2.x) / 2)} ${f((next.y + next2.y) / 2)}`;
    }
  }
  return `${d}Z`;
}

function letterPaths(textX) {
  const fontScale = ((CAP / NUNITO.cap) * 100) / font.unitsPerEm;
  const pens = [0];
  for (let i = 0; i < LETTERS.length; i += 1) {
    const next = LETTERS[i + 1];
    const kern = next
      ? (font.kerning.find((pair) => pair.left === LETTERS[i] && pair.right === next)?.units ?? 0)
      : 0;
    pens.push(pens[i] + (font.glyphs[LETTERS[i]].advance + kern) * fontScale);
  }
  const data = [...LETTERS]
    .map((char, index) => {
      const origin = textX + pens[index];
      return font.glyphs[char].contours
        .map((contour) =>
          contourPath(
            contour.map((point) => ({
              x: origin + point.x * fontScale,
              y: -point.y * fontScale,
              on: point.on,
            }))
          )
        )
        .join('');
    })
    .join('');
  return `<path fill-rule="nonzero" d="${data}"/>`;
}

function wordmarkLayout(design, pad) {
  const k = CAP / NUNITO.cap;
  const diameter = O_SIZE * CAP;
  const scale = diameter / 2 / R;
  const over = 0.02 * CAP;
  const oCx = diameter / 2;
  const oCy = over - diameter / 2;
  const textX = diameter + NUNITO.opGap * k + NUNITO.left * k;
  const [x0, y0] = bbox(design.bands, design.sparks);
  const left = oCx + x0 * scale - pad;
  const top = oCy + y0 * scale - pad;
  const right = textX + NUNITO.right * k + pad;
  const bottom = NUNITO.desc * k + pad;
  return {
    scale,
    oCx,
    oCy,
    textX,
    viewBox: [left, top, right - left, bottom - top],
    oTop: (-CAP - oCy) / scale,
    oBot: (0 - oCy) / scale,
  };
}

function wordmarkSvg(design, { prefix, pad, background }) {
  const layout = wordmarkLayout(design, pad);
  const ramp = '<stop offset="0" stop-color="#FFC53D"/><stop offset="1" stop-color="#EA9C00"/>';
  const defs =
    `<linearGradient id="ink" x1="0" y1="${f(-CAP)}" x2="0" y2="0" gradientUnits="userSpaceOnUse">${ramp}</linearGradient>` +
    `<linearGradient id="vortex" x1="0" y1="${f(layout.oTop)}" x2="0" y2="${f(layout.oBot)}" gradientUnits="userSpaceOnUse">${ramp}</linearGradient>` +
    '<linearGradient id="sparkfill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD860"/><stop offset="1" stop-color="#F7B400"/></linearGradient>' +
    `<path id="S" d="${sparkPath()}"/>`;
  const body =
    `<g transform="translate(${f(layout.oCx)} ${f(layout.oCy)}) scale(${f(layout.scale)})">${markBody(design, 'static')}</g>` +
    `<g fill="url(#ink)">${letterPaths(layout.textX)}</g>`;
  return svgDocument({
    prefix,
    viewBox: layout.viewBox,
    label: 'OpenKit',
    style: '',
    defs,
    body,
    background,
  });
}

/** Every committed SVG, keyed by repo-relative path. */
export function generateBrandSvgs() {
  const design = buildGolden();
  const brand = 'apps/web/public/brand';
  return {
    [`${brand}/openkit-mark.svg`]: markSvg(design, {
      prefix: 'openkit-mark',
      label: 'OpenKit mark',
      pad: 1.1,
      sparks: 'all',
      mode: 'static',
    }),
    [`${brand}/openkit-mark-light.svg`]: markSvg(design, {
      prefix: 'openkit-mark-light',
      label: 'OpenKit mark',
      pad: 1.25,
      sparks: 'all',
      background: '#FFFFFF',
      mode: 'static',
    }),
    [`${brand}/openkit-mark-dark.svg`]: markSvg(design, {
      prefix: 'openkit-mark-dark',
      label: 'OpenKit mark',
      pad: 1.25,
      sparks: 'all',
      background: '#1E1B14',
      mode: 'static',
    }),
    [`${brand}/openkit-mark-small.svg`]: markSvg(design, {
      prefix: 'openkit-mark-small',
      label: 'OpenKit mark',
      pad: 1.04,
      sparks: 'big',
      mode: 'small',
    }),
    [`${brand}/openkit-wordmark.svg`]: wordmarkSvg(design, {
      prefix: 'openkit-wordmark',
      pad: 10,
    }),
    [`${brand}/openkit-wordmark-light.svg`]: wordmarkSvg(design, {
      prefix: 'openkit-wordmark-light',
      pad: 24,
      background: '#FFFFFF',
    }),
    [`${brand}/openkit-wordmark-dark.svg`]: wordmarkSvg(design, {
      prefix: 'openkit-wordmark-dark',
      pad: 24,
      background: '#1E1B14',
    }),
    [`${brand}/openkit-loader.svg`]: markSvg(design, {
      prefix: 'openkit-loader',
      label: 'Loading OpenKit',
      pad: 1.1,
      sparks: 'all',
      mode: 'loader',
    }),
    [`${brand}/openkit-standby.svg`]: markSvg(design, {
      prefix: 'openkit-standby',
      label: 'OpenKit',
      pad: 1.1,
      sparks: 'all',
      mode: 'standby',
    }),
    'apps/web/public/favicon.svg': markSvg(design, {
      prefix: 'favicon',
      label: 'OpenKit',
      pad: 1.04,
      sparks: 'big',
      mode: 'small',
    }),
  };
}

function worstClearance(design, bandTracks, sparkTracks, period) {
  const sampled = design.bands.map((shape) => shape.filter((_, index) => index % 2 === 0));
  const worst = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const steps = Math.round(period / 0.01);
  for (let step = 0; step <= steps; step += 1) {
    const time = Math.min(period, step * 0.01);
    const points = sampled.flatMap((shape, index) =>
      rotate(shape, valueAt(bandTracks[index], time).r ?? 0)
    );
    design.sparks.forEach(([x, y, base], index) => {
      const values = valueAt(sparkTracks[index], time);
      if ((values.o ?? 1) < 0.02) return;
      const star = rotate(sparkOutline(base * values.s, 12), values.r);
      const reach = SPARK_V * base * Math.max(values.s, 1) + 8;
      worst[index] = Math.min(worst[index], clearance(star, x, y, points, reach));
    });
  }
  return worst.map((value) => Math.round(value * 100) / 100);
}

/** Visible-star clearance in drawn units: big, lower-left, upper. */
export function motionClearance() {
  const design = buildGolden();
  const intro = tracks('intro');
  const loading = tracks('loading');
  const shiftedBands = loading.b.map((track) => shiftLoopTrack(track));
  const shiftedSparks = loading.s.map((track) => shiftLoopTrack(track));
  return {
    intro: worstClearance(design, intro.b, intro.s, introEnd()),
    loading: worstClearance(design, loading.b, loading.s, LOOP),
    loader: worstClearance(design, shiftedBands, shiftedSparks, LOOP),
  };
}

function viewBoxSize(svg) {
  const match = /viewBox="([^"]+)"/.exec(svg);
  const parts = match[1].split(/\s+/).map(Number);
  return { width: parts[2], height: parts[3] };
}

function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map((image) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

async function rasterize(page, svg, width, height) {
  const sized = svg
    .replace(/width="[^"]*"/, `width="${width}"`)
    .replace(/height="[^"]*"/, `height="${height}"`);
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}</style>${sized}`,
    { waitUntil: 'load' }
  );
  return page
    .locator('svg')
    .screenshot({ omitBackground: true, type: 'png', animations: 'disabled' });
}

async function writeRasters(svgs) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({
    args: ['--disable-lcd-text', '--font-render-hinting=none', '--disable-gpu'],
  });
  const page = await browser.newPage({
    deviceScaleFactor: 1,
    viewport: { width: 1200, height: 1200 },
  });
  const brand = join(repoRoot, 'apps/web/public/brand');
  const design = buildGolden();
  const bandsSvg = markSvg(design, {
    prefix: 'favicon-bands',
    label: 'OpenKit',
    pad: 1.04,
    sparks: 'none',
    mode: 'bands',
  });
  const jobs = [
    ['openkit-mark-512.png', svgs['apps/web/public/brand/openkit-mark.svg'], 512, 512],
    ['openkit-mark-light-512.png', svgs['apps/web/public/brand/openkit-mark-light.svg'], 512, 512],
    ['openkit-mark-dark-512.png', svgs['apps/web/public/brand/openkit-mark-dark.svg'], 512, 512],
  ];
  for (const name of [
    'openkit-wordmark.png',
    'openkit-wordmark-light.png',
    'openkit-wordmark-dark.png',
  ]) {
    const svg = svgs[`apps/web/public/brand/${name.replace('.png', '.svg')}`];
    const box = viewBoxSize(svg);
    const height = Math.round((1200 * box.height) / box.width);
    jobs.push([name, svg, 1200, height]);
  }
  for (const [name, svg, width, height] of jobs) {
    await page.setViewportSize({ width, height });
    writeFileSync(join(brand, name), await rasterize(page, svg, width, height));
  }
  await page.setViewportSize({ width: 180, height: 180 });
  writeFileSync(
    join(repoRoot, 'apps/web/public/apple-touch-icon.png'),
    await rasterize(page, svgs['apps/web/public/brand/openkit-mark-dark.svg'], 180, 180)
  );
  const icoImages = [];
  for (const [size, svg] of [
    [16, bandsSvg],
    [32, svgs['apps/web/public/favicon.svg']],
    [48, svgs['apps/web/public/favicon.svg']],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    icoImages.push({ size, png: await rasterize(page, svg, size, size) });
  }
  writeFileSync(join(repoRoot, 'apps/web/public/favicon.ico'), packIco(icoImages));
  await browser.close();
}

async function main() {
  const clearance = motionClearance();
  for (const [name, values] of Object.entries(clearance)) {
    if (values.some((value) => value < 2.5)) {
      throw new Error(`${name} clearance ${values.join(', ')} is below 2.5`);
    }
  }
  const svgs = generateBrandSvgs();
  for (const [rel, content] of Object.entries(svgs)) {
    const dest = join(repoRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  await writeRasters(svgs);
  console.log(`clearance intro ${clearance.intro.join(', ')}`);
  console.log(`clearance loading ${clearance.loading.join(', ')}`);
  console.log(`clearance loader ${clearance.loader.join(', ')}`);
  console.log(`wrote ${Object.keys(svgs).length} svgs plus png and ico`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  await main();
}
