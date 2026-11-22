// 3D mode for the simulation viewer. Reads the same live state as the flat map
// (window.TV, set up in viewer.html) and draws it with three.js.
//
// World: x east, y north, metres from the airport reference point.
// Scene: X = x, Y = height, Z = -y. One unit is one metre.
import * as THREE from "three";

const TV = window.TV;
const canvas = document.getElementById("c3");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const HORIZON = new THREE.Color(0xc7d7e6);
const ZENITH = new THREE.Color(0x3f7fc4);
const scene = new THREE.Scene();
scene.background = HORIZON;
scene.fog = new THREE.Fog(HORIZON, 14000, 120000);
const camera = new THREE.PerspectiveCamera(40, 1, 2, 200000);

const V = (x, y, h = 0) => new THREE.Vector3(x, h, -y);
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = THREE.MathUtils.clamp;
const dirOf = (headingDeg) => ({ x: Math.sin(rad(headingDeg)), y: Math.cos(rad(headingDeg)) });
const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

// ---------------------------------------------------------------- sky, light

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(150000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
    uniforms: { horizon: { value: HORIZON }, zenith: { value: ZENITH } },
    vertexShader: "varying float h; void main() { h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "uniform vec3 horizon; uniform vec3 zenith; varying float h; void main() { gl_FragColor = vec4(mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55)), 1.0); }",
  }),
);
sky.renderOrder = -10;
sky.frustumCulled = false;
scene.add(sky);

scene.add(new THREE.HemisphereLight(0xe4f0ff, 0x6b7460, 1.25));
const SUN_DIR = new THREE.Vector3(-0.5, 0.72, 0.48).normalize(); // high in the south-west
const sun = new THREE.DirectionalLight(0xfff3df, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.4;
scene.add(sun, sun.target);

// Imagery cannot be lit, so shadows fall on a transparent sheet laid over it.
const shadowSheet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.4, depthWrite: false }));
shadowSheet.receiveShadow = true;
shadowSheet.renderOrder = 30;
scene.add(shadowSheet);

function aimSun(focus, reach) {
  const s = clamp(reach, 220, 2600);
  sun.target.position.copy(focus);
  sun.position.copy(focus).addScaledVector(SUN_DIR, 4000);
  const c = sun.shadow.camera;
  c.left = -s; c.right = s; c.top = s; c.bottom = -s; c.near = 100; c.far = 9000;
  c.updateProjectionMatrix();
  shadowSheet.position.set(focus.x, 0.25, focus.z);
  shadowSheet.scale.set(s * 2, 1, s * 2);
  return s;
}

// ------------------------------------------------------- satellite imagery
//
// Tiles come straight from Esri's World Imagery service. Around the point the
// camera is looking at, a small window of tiles is kept at every zoom level up
// to the one that matches the screen, coarse ones underneath and sharp ones on
// top, so the horizon costs little and the ground under the camera is detailed.

const TILE_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const IMAGERY_CREDIT = "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const MIN_Z = 9, MAX_Z = 19, EARTH_R = 6371008.8;

let geo = null;
const toLocal = (lon, lat) => ({ x: rad(lon - geo.lon0) * EARTH_R * geo.k, y: rad(lat - geo.lat0) * EARTH_R });
const toLonLat = (x, y) => ({ lon: geo.lon0 + deg(x / (EARTH_R * geo.k)), lat: geo.lat0 + deg(y / EARTH_R) });
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))));
const lonToTile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToTile = (lat, z) => ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * 2 ** z;

const tiles = new Map();
const tileGroup = new THREE.Group();
scene.add(tileGroup);
const tileLoader = new THREE.TextureLoader();
tileLoader.setCrossOrigin("anonymous");
const ANISO = renderer.capabilities.getMaxAnisotropy();
let tileQueue = [], tilesLoading = 0, tilesOk = 0, tilesFailed = 0, imagery = "loading";

function setImagery(state) {
  if (imagery === state) return;
  imagery = state;
  applyLayers();
  fire("tv:imagery", { ok: state === "ok", credit: state === "ok" ? IMAGERY_CREDIT : "" });
}

function loadNextTiles() {
  while (tilesLoading < 12 && tileQueue.length > 0) {
    const t = tileQueue.shift();
    if (!tiles.has(t.key) || t.state !== "queued") continue;
    t.state = "loading";
    tilesLoading++;
    tileLoader.load(
      TILE_URL(t.z, t.x, t.y),
      (tex) => {
        tilesLoading--; tilesOk++;
        if (!tiles.has(t.key)) { tex.dispose(); return loadNextTiles(); }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = ANISO;
        const nw = toLocal(tileLon(t.x, t.z), tileLat(t.y, t.z)), se = toLocal(tileLon(t.x + 1, t.z), tileLat(t.y + 1, t.z));
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute([nw.x, 0, -nw.y, se.x, 0, -nw.y, nw.x, 0, -se.y, se.x, 0, -se.y], 3));
        g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
        g.setIndex([0, 2, 1, 1, 2, 3]);
        t.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, depthWrite: false }));
        t.mesh.renderOrder = t.z - MIN_Z + 1; // sharper tiles are drawn over coarser ones
        t.state = "ready";
        tileGroup.add(t.mesh);
        if (tilesOk >= 4) setImagery("ok");
        loadNextTiles();
      },
      undefined,
      () => {
        tilesLoading--; tilesFailed++;
        t.state = "failed";
        if (tilesOk === 0 && tilesFailed >= 6) setImagery("unavailable");
        loadNextTiles();
      },
    );
  }
}

function dropTile(t) {
  if (t.mesh) { tileGroup.remove(t.mesh); t.mesh.material.map.dispose(); t.mesh.material.dispose(); t.mesh.geometry.dispose(); }
  tiles.delete(t.key);
}

let lastTileUpdate = 0;
function updateTiles(now, focus, viewDist) {
  if (!geo || imagery === "unavailable" || now - lastTileUpdate < 200) return;
  lastTileUpdate = now;
  // The zoom level at which one image pixel is about one screen pixel at the point being looked at.
  const zMax = clamp(Math.round(Math.log2(2e8 / Math.max(viewDist, 40))), MIN_Z, MAX_Z);
  const { lon, lat } = toLonLat(focus.x, -focus.z);
  const centre = [], added = [];
  for (let z = MIN_Z; z <= zMax + 1 && z <= MAX_Z; z++) centre[z] = { x: Math.floor(lonToTile(lon, z)), y: Math.floor(latToTile(lat, z)), r: z <= 11 ? 1 : 2 };
  for (let z = MIN_Z; z <= zMax; z++) {
    const c = centre[z], n = 2 ** z;
    for (let dx = -c.r; dx <= c.r; dx++) {
      for (let dy = -c.r; dy <= c.r; dy++) {
        const x = c.x + dx, y = c.y + dy, key = `${z}/${x}/${y}`;
        if (x < 0 || y < 0 || x >= n || y >= n || tiles.has(key)) continue;
        const t = { key, z, x, y, state: "queued", near: Math.abs(dx) + Math.abs(dy) };
        tiles.set(key, t);
        added.push(t);
      }
    }
  }
  for (const t of [...tiles.values()]) {
    const c = centre[t.z];
    if (!c || Math.abs(t.x - c.x) > c.r + 2 || Math.abs(t.y - c.y) > c.r + 2) dropTile(t);
  }
  if (added.length > 0) {
    tileQueue = tileQueue.filter((t) => tiles.has(t.key)).concat(added).sort((a, b) => a.z - b.z || a.near - b.near);
    loadNextTiles();
  }
}

// ------------------------------------------------------------------ airport

/** Collects flat triangles on the ground. */
class Flat {
  constructor() { this.pos = []; }
  /** A strip of the given width along a line of points, mitred at the bends. */
  ribbon(points, width) {
    if (points.length < 2) return;
    const half = width / 2, left = [], right = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i], a = points[Math.max(i - 1, 0)], b = points[Math.min(i + 1, points.length - 1)];
      let dx = b.x - a.x, dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      let k = 1;
      if (i > 0 && i < points.length - 1) {
        const d1 = Math.hypot(p.x - a.x, p.y - a.y) || 1, d2 = Math.hypot(b.x - p.x, b.y - p.y) || 1;
        const cos = ((p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y)) / (d1 * d2);
        k = Math.min(2, 1 / Math.sqrt(Math.max(0.25, (1 + cos) / 2)));
      }
      left.push({ x: p.x - dy * half * k, y: p.y + dx * half * k });
      right.push({ x: p.x + dy * half * k, y: p.y - dx * half * k });
    }
    for (let i = 1; i < points.length; i++) this.quad(left[i - 1], right[i - 1], right[i], left[i]);
  }
  quad(a, b, c, d) {
    for (const p of [a, b, c, a, c, d]) this.pos.push(p.x, 0, -p.y);
  }
  /** A rectangle centred on `at`, `length` along the heading and `width` across it. */
  bar(at, headingDeg, length, width) {
    const f = dirOf(headingDeg), hl = length / 2;
    this.ribbon([{ x: at.x - f.x * hl, y: at.y - f.y * hl }, { x: at.x + f.x * hl, y: at.y + f.y * hl }], width);
  }
  mesh(color, order) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, depthWrite: false, side: THREE.DoubleSide }));
    m.renderOrder = order;
    return m;
  }
}

function flatShape(polygon) {
  const pts = polygon.slice();
  const a = pts[0], z = pts[pts.length - 1];
  if (pts.length > 3 && a.x === z.x && a.y === z.y) pts.pop();
  return new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
}

function paintedNumber(designator) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 320;
  const g = c.getContext("2d");
  g.fillStyle = "#f2f5f7"; g.textAlign = "center"; g.textBaseline = "middle";
  const m = /^(\d+)([LRC]?)$/.exec(designator) ?? [designator, designator, ""];
  g.font = "700 170px ui-sans-serif, system-ui, Arial, sans-serif";
  g.fillText(m[1], 128, m[2] ? 105 : 160);
  if (m[2]) { g.font = "700 130px ui-sans-serif, system-ui, Arial, sans-serif"; g.fillText(m[2], 128, 245); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

const WALLS = { terminal: 0xa9bccb, tower: 0xd9dee2, hangar: 0xc9cdd0, parking: 0xb4b2ac, building: 0xcfd2d2 };
const ROOFS = { terminal: 0x8b98a4, tower: 0x77828c, hangar: 0x9aa2a8, parking: 0x8f8f8b, building: 0xa9aeb0 };

/** Every building as one mesh: outlines pushed up to their height, tinted by kind. */
function buildBuildings(list) {
  const pos = [], nor = [], col = [];
  const wall = new THREE.Color(), roof = new THREE.Color();
  for (const b of list) {
    if (b.polygon.length < 3) continue;
    let geo3;
    try { geo3 = new THREE.ExtrudeGeometry(flatShape(b.polygon), { depth: b.heightM, bevelEnabled: false }).rotateX(-Math.PI / 2); } catch { continue; }
    const p = geo3.attributes.position.array, n = geo3.attributes.normal.array;
    wall.setHex(WALLS[b.kind] ?? WALLS.building); roof.setHex(ROOFS[b.kind] ?? ROOFS.building);
    // Slight variation so neighbouring blocks do not merge into one slab.
    const tint = 0.92 + (((Math.abs(b.polygon[0].x * 7 + b.polygon[0].y * 13) | 0) % 16) / 100);
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]); nor.push(n[i], n[i + 1], n[i + 2]);
      const c = n[i + 1] > 0.5 ? roof : wall;
      col.push(c.r * tint, c.g * tint, c.b * tint);
    }
    geo3.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 }));
  m.castShadow = true; m.receiveShadow = true;
  m.renderOrder = 40;
  return m;
}

let airportGroup = null, airportKey = "", drawnGroup = null, linesGroup = null, showLines = false;
let nodes = new Map();
let home = { x: 0, y: 0, span: 6000 };

function applyLayers() {
  if (!airportGroup) return;
  const drawn = imagery !== "ok";
  drawnGroup.visible = drawn; // the drawn airport stands in when there is no imagery
  linesGroup.visible = drawn || showLines;
}

function buildAirport() {
  const a = TV.airport;
  if (!a) return;
  // A restart sends the airport again; only rebuild when it is a different one.
  const key = `${a.icao}:${a.nodes.length}:${a.edges.length}`;
  if (airportGroup && key === airportKey) return;
  airportKey = key;
  if (airportGroup) {
    scene.remove(airportGroup);
    airportGroup.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [o.material].flat()) { m?.map?.dispose(); m?.dispose(); }
    });
  }
  airportGroup = new THREE.Group();
  drawnGroup = new THREE.Group();
  linesGroup = new THREE.Group();
  airportGroup.add(drawnGroup, linesGroup);
  nodes = TV.nodes;
  geo = { lat0: a.reference.lat, lon0: a.reference.lon, k: Math.cos(rad(a.reference.lat)) };
  for (const t of [...tiles.values()]) dropTile(t);
  const d = a.drawing;
  // The schematic test airport is not a real place, so real imagery would not line up with it.
  if (!d) setImagery("unavailable");
  else if (imagery === "unavailable" && tilesFailed < 6) setImagery(tilesOk > 0 ? "ok" : "loading");

  const ground = new THREE.Mesh(new THREE.CircleGeometry(190000, 72).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x6f7b68, depthWrite: false }));
  ground.renderOrder = 0;
  airportGroup.add(ground);

  // Drawn surfaces (used only when imagery cannot be loaded)
  if (d) {
    for (const ap of d.aprons) {
      if (ap.polygon.length < 4) continue;
      const m = new THREE.Mesh(new THREE.ShapeGeometry(flatShape(ap.polygon)).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8d9296, depthWrite: false, side: THREE.DoubleSide }));
      m.renderOrder = 12;
      drawnGroup.add(m);
    }
  }
  const lanes = new Flat(), taxi = new Flat(), centre = new Flat();
  if (d) {
    for (const t of d.taxiways) {
      (t.kind === "taxiway" ? taxi : lanes).ribbon(t.points, t.kind === "taxiway" ? 23 : 15);
      centre.ribbon(t.points, 0.9);
    }
    for (const s of d.stands) centre.ribbon(s.points, 0.7);
  } else {
    for (const e of a.edges) {
      if (e.kind === "runway") continue;
      taxi.ribbon([nodes.get(e.from), nodes.get(e.to)], e.kind === "gate_stub" ? 10 : 23);
    }
  }
  drawnGroup.add(lanes.mesh(0x858b90, 13), taxi.mesh(0x7c8389, 14));
  linesGroup.add(centre.mesh(0xf2c531, 20));

  // Runways: surface and paint (drawn mode), numbers, edge lights
  const surface = new Flat(), paint = new Flat(), holdPaint = new Flat();
  const white = [], green = [], red = [];
  for (const r of a.runways) {
    const [p0, p1] = r.paved ?? r.ends.map((e) => e.threshold);
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y), w = r.widthM;
    const f = { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len }, side = { x: f.y, y: -f.x };
    const at = (s, off = 0) => ({ x: p0.x + f.x * s + side.x * off, y: p0.y + f.y * s + side.y * off });
    surface.ribbon([p0, p1], w);
    for (const off of [-w / 2 + 1.2, w / 2 - 1.2]) paint.ribbon([at(0, off), at(len, off)], 0.9);
    for (let s = 170; s + 36 < len - 170; s += 60) paint.ribbon([at(s), at(s + 36)], 0.9);
    for (const s0 of [12, len - 12 - 30]) {
      for (let i = 0; i < 6; i++) for (const sign of [-1, 1]) paint.ribbon([at(s0, sign * (3.6 + i * 3.6)), at(s0 + 30, sign * (3.6 + i * 3.6))], 1.8);
    }
    for (const s0 of [400, len - 400 - 45]) for (const sign of [-1, 1]) paint.ribbon([at(s0, sign * 11), at(s0 + 45, sign * 11)], 6);
    r.ends.forEach((end, i) => {
      const p = at(i === 0 ? 85 : len - 85);
      const num = new THREE.Mesh(new THREE.PlaneGeometry(26, 32.5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: paintedNumber(end.designator), transparent: true, depthWrite: false }));
      num.position.copy(V(p.x, p.y));
      num.rotation.y = -rad(end.headingDeg);
      num.renderOrder = 17;
      drawnGroup.add(num);
    });
    for (let s = 0; s <= len; s += 60) for (const sign of [-1, 1]) { const p = at(s, sign * (w / 2 + 2)); white.push(p.x, 0.6, -p.y); }
    for (let off = -w / 2; off <= w / 2; off += 5) {
      for (const [s, arr] of [[-3, green], [len + 3, green], [1, red], [len - 1, red]]) { const p = at(s, off); arr.push(p.x, 0.6, -p.y); }
    }
  }
  // Hold lines: where the simulation stops aircraft short of each runway.
  for (const e of a.edges) {
    if (e.kind !== "runway_link") continue;
    const h = nodes.get(e.from).kind === "hold_short" ? nodes.get(e.from) : nodes.get(e.to);
    const o = h.id === e.from ? nodes.get(e.to) : nodes.get(e.from);
    const brg = deg(Math.atan2(o.x - h.x, o.y - h.y));
    holdPaint.bar(h, brg + 90, 26, 1.4);
  }
  drawnGroup.add(surface.mesh(0x4f565c, 15), paint.mesh(0xeef2f5, 16));
  linesGroup.add(holdPaint.mesh(0xff8a3d, 21));
  const lights = (arr, color, size) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthWrite: false }));
    pts.renderOrder = 22;
    return pts;
  };
  airportGroup.add(lights(white, 0xfffbe6, 1.8), lights(green, 0x59ff93, 2), lights(red, 0xff5a4d, 2));

  // Buildings: real outlines; heights are mapped where known, otherwise typical for the kind.
  const buildings = d?.buildings?.length
    ? d.buildings
    : a.terminals.map((t) => ({ kind: "terminal", heightM: t.id === "T1" || t.id === "T3" ? 22 : 12, polygon: t.polygon }));
  airportGroup.add(buildBuildings(buildings));

  const xs = a.runways.flatMap((r) => (r.paved ?? r.ends.map((e) => e.threshold)).map((p) => p.x));
  const ys = a.runways.flatMap((r) => (r.paved ?? r.ends.map((e) => e.threshold)).map((p) => p.y));
  home = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, span: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) };
  scene.add(airportGroup);
  applyLayers();
  resetView();
}

// ----------------------------------------------------------------- aircraft

// Length, wingspan, fuselage width and engine radius in metres, plus layout.
const TYPES = {
  A319: { len: 33.8, span: 35.8, dia: 3.95, eng: 1.0 },
  A320: { len: 37.6, span: 35.8, dia: 3.95, eng: 1.0 },
  A321: { len: 44.5, span: 35.8, dia: 3.95, eng: 1.0 },
  A333: { len: 63.7, span: 60.3, dia: 5.64, eng: 1.45 },
  B38M: { len: 39.5, span: 35.9, dia: 3.76, eng: 1.05 },
  B739: { len: 42.1, span: 35.8, dia: 3.76, eng: 0.92 },
  B77W: { len: 73.9, span: 64.8, dia: 6.2, eng: 1.9, winglet: false },
  B789: { len: 63.0, span: 60.1, dia: 5.77, eng: 1.6, winglet: false },
  CRJ9: { len: 36.2, span: 24.9, dia: 2.7, eng: 0.72, rear: true, tTail: true },
  E175: { len: 31.7, span: 28.7, dia: 3.0, eng: 0.82 },
  DH8D: { len: 32.8, span: 28.4, dia: 2.7, eng: 0.5, high: true, prop: true, tTail: true, winglet: false },
};
// Tail colour by airline code, so aircraft can be told apart at a glance.
const TAILS = { ACA: 0xd22630, JZA: 0xd22630, ROU: 0x7a1f3d, WJA: 0x00a3ad, DAL: 0x0b2a5b, UAL: 0x1f4e9c, AAL: 0x8f9daa, POE: 0x1b2a49, TSC: 0x2b6cc4, BAW: 0x1d2f6f, FDX: 0x4d148c, WEN: 0x00a3ad };

const matBody = new THREE.MeshStandardMaterial({ color: 0xf3f5f7, roughness: 0.42, metalness: 0.08 });
const matWing = new THREE.MeshStandardMaterial({ color: 0xc8ced5, roughness: 0.5, metalness: 0.25, side: THREE.DoubleSide });
const matEngine = new THREE.MeshStandardMaterial({ color: 0xdfe3e7, roughness: 0.45, metalness: 0.2 });
const matMetal = new THREE.MeshStandardMaterial({ color: 0x8a939c, roughness: 0.5, metalness: 0.45 });
const matDark = new THREE.MeshStandardMaterial({ color: 0x14191e, roughness: 0.7, side: THREE.DoubleSide });
const matGlass = new THREE.MeshStandardMaterial({ color: 0x0c1218, roughness: 0.15, metalness: 0.6 });
const matBlob = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false });
const matRing = new THREE.MeshBasicMaterial({ color: 0x45e06b, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide });
const matStalk = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
const liveries = new Map();
const livery = (hex) => {
  if (!liveries.has(hex)) liveries.set(hex, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide }));
  return liveries.get(hex);
};
const glow = (hex) => new THREE.MeshBasicMaterial({ color: hex, fog: false });
const blobGeo = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
const ringGeo = new THREE.RingGeometry(0.95, 1, 64).rotateX(-Math.PI / 2);

/** A swept flat panel lying in the horizontal plane: root chord at x = x0, tip chord at x = x1; `sweep` moves the tip aft. */
function panel(x0, x1, rootChord, tipChord, sweep, thickness) {
  const s = new THREE.Shape();
  s.moveTo(x0, 0); s.lineTo(x1, sweep); s.lineTo(x1, sweep + tipChord); s.lineTo(x0, rootChord); s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false }).rotateX(Math.PI / 2);
}
/** An upright swept panel: chord along Z (aft), height along Y. */
function upright(rootChord, tipChord, height, rake, thickness) {
  const s = new THREE.Shape();
  s.moveTo(0, 0); s.lineTo(rootChord, 0); s.lineTo(rake + tipChord, height); s.lineTo(rake, height); s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false }).translate(0, 0, -thickness / 2).rotateY(-Math.PI / 2);
}

/** Model with its nose toward -Z, wings along X, sitting with its wheels at y = 0. */
function buildAircraft(type, callsign) {
  const t = { winglet: true, ...(TYPES[type] ?? TYPES.A320) };
  const L = t.len, r = t.dia / 2, half = t.span / 2, er = t.eng;
  const g = new THREE.Group();
  const gear = new THREE.Group();
  const paintMat = livery(TAILS[callsign.slice(0, 3)] ?? 0x4f6f8f);
  const axis = r + (t.high ? 1.5 : 2.2 + er * 0.6); // height of the fuselage centreline above the ground
  const nose = -L * 0.46;
  const add = (mesh, shadow = true) => { mesh.castShadow = shadow; mesh.receiveShadow = shadow; g.add(mesh); return mesh; };

  // Fuselage: a profile spun around the long axis, with the tail cone in the airline's colour.
  const spin = (points, material) => {
    const m = new THREE.Mesh(new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), 28).rotateX(Math.PI / 2), material);
    m.position.set(0, axis, nose);
    return add(m);
  };
  spin([[0, 0], [r * 0.36, L * 0.01], [r * 0.68, L * 0.035], [r * 0.9, L * 0.07], [r, L * 0.12], [r, L * 0.64], [r * 0.9, L * 0.72]], matBody);
  const cone = spin([[r * 0.9, L * 0.72], [r * 0.62, L * 0.86], [r * 0.28, L * 0.97], [0, L]], paintMat);
  cone.position.y = axis + r * 0.12; // the tail sweeps up
  // Flight deck glass and the line of cabin windows.
  const glass = add(new THREE.Mesh(new THREE.SphereGeometry(r * 0.74, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), matGlass), false);
  glass.scale.set(0.96, 0.62, 1.6);
  glass.position.set(0, axis + r * 0.36, nose + L * 0.062);
  for (const sign of [-1, 1]) {
    const row = add(new THREE.Mesh(new THREE.BoxGeometry(0.1, Math.min(0.42, r * 0.2), L * 0.5), matDark), false);
    row.position.set(sign * r * 0.985, axis + r * 0.2, nose + L * 0.39);
  }

  // Wings
  const wingZ = nose + L * (t.rear ? 0.44 : 0.36);
  const rootChord = L * (t.prop ? 0.12 : 0.2), tipChord = rootChord * (t.prop ? 0.55 : 0.26);
  const sweep = half * (t.prop ? 0.05 : 0.52), dihedral = t.high ? 0 : 0.075;
  const wingY = t.high ? axis + r * 0.86 : axis - r * 0.42;
  const edgeZ = (x) => wingZ + ((x - r * 0.3) / (half - r * 0.3)) * sweep; // leading edge at span position x
  for (const sign of [-1, 1]) {
    const wing = add(new THREE.Mesh(panel(r * 0.3, half, rootChord, tipChord, sweep, 0.55), matWing));
    wing.scale.x = sign;
    wing.position.set(0, wingY, wingZ);
    wing.rotation.z = sign * dihedral;
    if (t.winglet) {
      const tip = new THREE.Mesh(upright(tipChord, tipChord * 0.45, half * 0.13, tipChord * 0.7, 0.25), paintMat);
      tip.position.set(half, 0, sweep);
      tip.rotation.z = -0.22;
      tip.castShadow = true;
      wing.add(tip);
    }
  }

  // Tail
  const finH = t.dia * 1.5 + 1.8, finRoot = L * 0.17, finZ = nose + L - finRoot - L * 0.035;
  const fin = add(new THREE.Mesh(upright(finRoot, finRoot * 0.42, finH, finRoot * 0.66, 0.5), paintMat));
  fin.position.set(0, axis + r * 0.55, finZ);
  const stabHalf = half * (t.tTail ? 0.3 : 0.37), stabY = t.tTail ? axis + r * 0.55 + finH : axis + r * 0.3;
  const stabZ = t.tTail ? finZ + finRoot * 0.66 : finZ + finRoot * 0.22;
  for (const sign of [-1, 1]) {
    const stab = add(new THREE.Mesh(panel(t.tTail ? 0 : r * 0.25, stabHalf, L * 0.1, L * 0.042, stabHalf * 0.55, 0.35), matWing));
    stab.scale.x = sign;
    stab.position.set(0, stabY, stabZ);
    stab.rotation.z = sign * (t.tTail ? 0 : 0.1);
  }

  // Engines
  const el = t.prop ? L * 0.19 : Math.max(L * 0.105, er * 3.1);
  const nacelleGeo = new THREE.CylinderGeometry(er, er * 0.7, el, 20).rotateX(-Math.PI / 2);
  const intakeGeo = new THREE.CircleGeometry(er * 0.84, 20);
  const enginePos = [];
  for (const sign of [-1, 1]) {
    let x, y, z;
    if (t.rear) { x = sign * (r + er * 1.05); y = axis + r * 0.38; z = nose + L * 0.74; }
    else { const ex = half * (t.prop ? 0.3 : 0.34); x = sign * ex; y = t.high ? wingY - er * 0.75 : wingY + dihedral * ex - er - 0.3; z = edgeZ(ex) - el * (t.prop ? 0.1 : 0.22); }
    enginePos.push({ x, y, z });
    const nac = add(new THREE.Mesh(nacelleGeo, matEngine)); nac.position.set(x, y, z);
    const intake = add(new THREE.Mesh(intakeGeo, matDark), false); intake.position.set(x, y, z - el / 2 - 0.02);
    if (t.prop) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(er * 4, 24), new THREE.MeshBasicMaterial({ color: 0xe8edf2, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }));
      disc.position.set(x, y, z - el / 2 - 0.5);
      g.add(disc);
    } else if (!t.rear) {
      const pylon = add(new THREE.Mesh(new THREE.BoxGeometry(0.3, er * 0.9, el * 0.7), matWing));
      pylon.position.set(x, y + er * 0.75, z + el * 0.12);
    } else {
      const pylon = add(new THREE.Mesh(new THREE.BoxGeometry(er * 0.9, 0.3, el * 0.6), matWing));
      pylon.position.set(sign * (r + er * 0.3), y, z);
    }
  }

  // Undercarriage: hidden once the aircraft is airborne.
  const wheelGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.45, 12).rotateZ(Math.PI / 2);
  const leg = (x, z, top) => {
    for (const dx of [-0.42, 0.42]) { const w = new THREE.Mesh(wheelGeo, matDark); w.position.set(x + dx, 0.6, z); w.castShadow = true; gear.add(w); }
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, top - 0.5, 8), matMetal);
    strut.position.set(x, (top - 0.5) / 2 + 0.5, z);
    gear.add(strut);
  };
  leg(0, nose + L * 0.1, axis - r * 0.7);
  const mainX = t.high ? Math.abs(enginePos[0].x) : Math.max(r * 0.95, half * 0.13);
  const mainZ = t.high ? enginePos[0].z + el * 0.45 : wingZ + rootChord * 0.78;
  for (const sign of [-1, 1]) leg(sign * mainX, mainZ, t.high ? enginePos[0].y - er * 0.4 : wingY + dihedral * mainX - 0.3);
  g.add(gear);

  // Lights: red beacon on top, red and green at the wingtips, white for landing.
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), glow(0xff3b30));
  beacon.position.set(0, axis + r + 0.25, nose + L * 0.4);
  const tipY = wingY + dihedral * half, tipZ = wingZ + sweep + tipChord * 0.4;
  const port = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), glow(0xff4d4d)); port.position.set(-half, tipY, tipZ);
  const starboard = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), glow(0x4dff7c)); starboard.position.set(half, tipY, tipZ);
  const landing = new THREE.Group();
  for (const sign of [-1, 1]) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), glow(0xffffff)); l.position.set(sign * r * 1.15, wingY, wingZ + rootChord * 0.1); landing.add(l); }
  g.add(beacon, port, starboard, landing);

  return { group: g, gear, beacon, landing, size: Math.max(L, t.span) };
}

function makeLabel() {
  const c = document.createElement("canvas");
  c.width = 384; c.height = 96;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true, fog: false }));
  sprite.scale.set(0.112, 0.028, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 100;
  return { sprite, canvas: c, tex, text: "" };
}
function setLabel(label, top, bottom, color) {
  const text = `${top}|${bottom}|${color}`;
  if (label.text === text) return;
  label.text = text;
  const g = label.canvas.getContext("2d");
  g.clearRect(0, 0, 384, 96);
  g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
  g.font = "700 40px ui-sans-serif, system-ui, Arial, sans-serif";
  g.lineWidth = 9; g.strokeStyle = "#0b1117"; g.strokeText(top, 192, 30);
  g.fillStyle = color; g.fillText(top, 192, 30);
  g.font = "600 28px ui-sans-serif, system-ui, Arial, sans-serif";
  g.lineWidth = 8; g.strokeText(bottom, 192, 72);
  g.fillStyle = "#e6edf3"; g.fillText(bottom, 192, 72);
  label.tex.needsUpdate = true;
}

const fleet = new Map();
const FT = 0.3048;

function syncFleet() {
  const list = TV.snap?.aircraft ?? [];
  const seen = new Set();
  for (const a of list) {
    seen.add(a.id);
    let f = fleet.get(a.id);
    if (!f) {
      const model = buildAircraft(a.type, a.callsign);
      const root = new THREE.Group();
      root.add(model.group);
      const blob = new THREE.Mesh(blobGeo, matBlob); blob.renderOrder = 31;
      const stalkGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
      const stalk = new THREE.Line(stalkGeo, matStalk);
      stalk.frustumCulled = false;
      const label = makeLabel();
      scene.add(root, blob, stalk, label.sprite);
      f = { ...model, root, blob, stalk, label, pos: V(a.position.x, a.position.y, a.altitudeFt * FT), heading: a.headingDeg, pitch: 0, bank: 0, lastAlt: a.altitudeFt, lastHeading: a.headingDeg, lastTime: TV.snap.time, vs: 0, turn: 0 };
      fleet.set(a.id, f);
    }
    f.data = a;
    const dt = TV.snap.time - f.lastTime;
    if (dt > 0.05) {
      f.vs = ((a.altitudeFt - f.lastAlt) * FT) / dt; // m/s
      let dh = a.headingDeg - f.lastHeading; dh = ((dh + 540) % 360) - 180;
      f.turn = dh / dt; // deg/s
      f.lastAlt = a.altitudeFt; f.lastHeading = a.headingDeg; f.lastTime = TV.snap.time;
    } else if (dt < 0) { f.lastAlt = a.altitudeFt; f.lastHeading = a.headingDeg; f.lastTime = TV.snap.time; f.vs = 0; f.turn = 0; }
  }
  for (const [id, f] of fleet) {
    if (seen.has(id)) continue;
    scene.remove(f.root, f.blob, f.stalk, f.label.sprite);
    f.label.tex.dispose(); f.stalk.geometry.dispose();
    fleet.delete(id);
  }
}

// ------------------------------------------------------------------ camera

const view = { target: new THREE.Vector3(), dist: 8000, az: rad(25), pol: rad(60), mode: "free" };
function resetView() {
  view.target.copy(V(home.x, home.y));
  view.dist = home.span * 1.05; view.az = rad(28); view.pol = rad(62);
}
function fitAll() {
  const pts = [...fleet.values()].map((f) => f.pos);
  if (!pts.length) return resetView();
  const box = new THREE.Box3().setFromPoints(pts);
  box.expandByPoint(V(home.x - home.span / 2, home.y - home.span / 2)).expandByPoint(V(home.x + home.span / 2, home.y + home.span / 2));
  box.getCenter(view.target); view.target.y = 0;
  const size = box.getSize(new THREE.Vector3());
  view.dist = Math.max(size.x, size.z) * 1.2; view.pol = rad(52);
}
const selectedCraft = () => (TV.selected ? fleet.get(TV.selected) : undefined);

const chasePos = new THREE.Vector3(), chaseLook = new THREE.Vector3();
let chaseReady = false;
/** Positions the camera and returns what it is looking at and from how far. */
function placeCamera(dt) {
  const f = selectedCraft();
  if (view.mode === "chase" && f) {
    const h = dirOf(f.heading), back = Math.max(130, f.size * 3), up = Math.max(34, f.size * 0.7);
    const want = new THREE.Vector3(f.pos.x - h.x * back, f.pos.y + up, f.pos.z + h.y * back);
    const look = new THREE.Vector3(f.pos.x + h.x * 110, f.pos.y + 7, f.pos.z - h.y * 110);
    const k = chaseReady ? 1 - Math.exp(-dt * 3) : 1;
    chasePos.lerp(want, k); chaseLook.lerp(look, k); chaseReady = true;
    camera.position.copy(chasePos); camera.lookAt(chaseLook);
    return { focus: new THREE.Vector3(f.pos.x, 0, f.pos.z), dist: Math.max(back * 1.2, camera.position.y * 1.1) };
  }
  chaseReady = false;
  if (view.mode === "follow" && f) view.target.lerp(new THREE.Vector3(f.pos.x, f.pos.y, f.pos.z), 1 - Math.exp(-dt * 5));
  const s = Math.sin(view.pol);
  camera.position.set(view.target.x + view.dist * s * Math.sin(view.az), view.target.y + view.dist * Math.cos(view.pol), view.target.z + view.dist * s * Math.cos(view.az));
  camera.lookAt(view.target);
  return { focus: new THREE.Vector3(view.target.x, 0, view.target.z), dist: view.dist };
}

// Selected aircraft: ring on the ground and its cleared route.
const ring = new THREE.Mesh(ringGeo, matRing); ring.renderOrder = 32; ring.visible = false; scene.add(ring);
const routeLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x45e06b, depthTest: false, transparent: true, opacity: 0.95 }));
routeLine.renderOrder = 50; routeLine.visible = false; routeLine.frustumCulled = false; scene.add(routeLine);

function updateRoute(f) {
  const a = f?.data;
  if (!a || a.altitudeFt > 0 || !a.route?.length) { routeLine.visible = false; return; }
  const last = Math.min(a.routeLimitIndex ?? a.route.length - 1, a.route.length - 1);
  const pts = [new THREE.Vector3(f.pos.x, 1.5, f.pos.z)];
  for (let i = a.currentWaypointIndex; i <= last; i++) { const n = nodes.get(a.route[i]); if (n) pts.push(V(n.x, n.y, 1.5)); }
  routeLine.geometry.setFromPoints(pts);
  routeLine.visible = pts.length > 1;
}

// -------------------------------------------------------------------- loop

let lastFrame = performance.now(), lastPanel = -1;
function frame(now) {
  requestAnimationFrame(frame);
  if (TV.mode !== "3d" || !TV.airport) { lastFrame = now; return; }
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    lastPanel = -1;
  }
  // Keep the view centred on the part of the window the side panel does not cover.
  const panel = TV.panelWidth();
  if (panel !== lastPanel) {
    lastPanel = panel;
    if (panel > 0) camera.setViewOffset(w, h, panel / 2, 0, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }

  syncFleet();
  const ease = 1 - Math.exp(-dt * 10);
  const blink = now % 1200 < 140;
  for (const f of fleet.values()) {
    const a = f.data;
    f.pos.lerp(V(a.position.x, a.position.y, a.altitudeFt * FT), ease);
    let dh = a.headingDeg - f.heading; dh = ((dh + 540) % 360) - 180;
    f.heading = (f.heading + dh * ease + 360) % 360;
    const speed = Math.max(a.speedKts * 0.5144, 1);
    const airborne = a.altitudeFt > 5;
    const wantPitch = airborne ? Math.atan2(f.vs, speed) + (f.vs < -0.5 ? rad(4) : rad(2)) : 0;
    const wantBank = airborne ? clamp(-f.turn * 0.14, -0.45, 0.45) : 0;
    f.pitch += (wantPitch - f.pitch) * (1 - Math.exp(-dt * 2.5));
    f.bank += (wantBank - f.bank) * (1 - Math.exp(-dt * 2.5));
  }
  const { focus, dist } = placeCamera(dt);
  sky.position.copy(camera.position);
  const reach = aimSun(focus, dist * 0.9);
  updateTiles(now, focus, dist);

  const sel = selectedCraft();
  for (const [id, f] of fleet) {
    const a = f.data;
    // Real-size aircraft vanish in a view of the whole airport, so they grow with distance.
    const camDist = camera.position.distanceTo(f.pos);
    const scale = view.mode === "chase" && f === sel ? 1 : clamp(camDist / 1700, 1, 7);
    f.root.position.copy(f.pos);
    f.root.rotation.set(0, -rad(f.heading), 0);
    f.group.rotation.set(f.pitch, 0, f.bank);
    f.root.scale.setScalar(scale);
    f.gear.visible = a.altitudeFt < 150;
    f.beacon.visible = blink && a.phase !== "at_gate";
    f.landing.visible = a.altitudeFt > 0 && a.altitudeFt < 3500;
    // Real shadows only reach so far from where the camera looks; beyond that, and in the air, a soft spot marks the ground position.
    const inShadowBox = Math.abs(f.pos.x - focus.x) < reach * 0.9 && Math.abs(f.pos.z - focus.z) < reach * 0.9;
    f.blob.visible = a.altitudeFt > 20 || !inShadowBox;
    f.blob.position.set(f.pos.x, 0.3, f.pos.z);
    f.blob.scale.set(f.size * 0.4 * scale, 1, f.size * 0.4 * scale);
    const p = f.stalk.geometry.attributes.position;
    p.setXYZ(0, f.pos.x, f.pos.y, f.pos.z); p.setXYZ(1, f.pos.x, 0, f.pos.z); p.needsUpdate = true;
    f.stalk.visible = a.altitudeFt > 30;
    f.label.sprite.position.set(f.pos.x, f.pos.y + f.size * 0.42 * scale + 4, f.pos.z);
    f.label.sprite.visible = a.phase !== "at_gate" || id === TV.selected || camDist < 2500;
    const sub = a.altitudeFt > 0 ? `${Math.round(a.altitudeFt / 100) * 100} ft  ${Math.round(a.speedKts)} kt` : `${a.phase.replace(/_/g, " ")}${a.speedKts > 0.5 ? `  ${Math.round(a.speedKts)} kt` : ""}`;
    setLabel(f.label, a.callsign, sub, TV.colorOf(a));
  }
  if (sel) {
    ring.visible = true;
    ring.position.set(sel.pos.x, 0.4, sel.pos.z);
    const s = sel.size * 0.68 * sel.root.scale.x;
    ring.scale.set(s, 1, s);
  } else ring.visible = false;
  updateRoute(sel);

  renderer.render(scene, camera);
}

// ------------------------------------------------------------------- input

let drag = null, moved = false;
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
  moved = false;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.pan) {
    const k = view.dist * 0.0013;
    view.target.x -= (Math.cos(view.az) * dx + Math.sin(view.az) * dy) * k;
    view.target.z -= (-Math.sin(view.az) * dx + Math.cos(view.az) * dy) * k;
    if (view.mode !== "free") fire("tv:cam-changed", (view.mode = "free"));
  } else {
    view.az -= dx * 0.005;
    view.pol = clamp(view.pol - dy * 0.004, rad(3), rad(88.5));
  }
});
canvas.addEventListener("pointerup", (e) => {
  canvas.classList.remove("dragging");
  drag = null;
  if (moved) return;
  const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  let best = null, bd = 26;
  const v = new THREE.Vector3();
  for (const [id, f] of fleet) {
    v.copy(f.pos).project(camera);
    if (v.z > 1) continue;
    const d = Math.hypot(((v.x + 1) / 2) * r.width - px, ((1 - v.y) / 2) * r.height - py);
    if (d < bd) { bd = d; best = id; }
  }
  TV.select(best);
});
canvas.addEventListener("pointercancel", () => { drag = null; canvas.classList.remove("dragging"); });
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  view.dist = clamp(view.dist * Math.exp(e.deltaY * 0.0012), 45, 120000);
}, { passive: false });
canvas.addEventListener("dblclick", resetView);

window.addEventListener("tv:airport", buildAirport);
window.addEventListener("tv:fit", resetView);
window.addEventListener("tv:fitall", fitAll);
window.addEventListener("tv:cam", (e) => { view.mode = e.detail; });
window.addEventListener("tv:lines", (e) => { showLines = e.detail; applyLayers(); });
window.addEventListener("tv:focus", (e) => {
  const f = fleet.get(e.detail);
  if (!f) return;
  view.target.set(f.pos.x, f.pos.y, f.pos.z);
  if (view.mode === "free") view.dist = Math.min(view.dist, f.data.altitudeFt > 0 ? 6000 : 900);
});

if (TV.airport) buildAirport();
requestAnimationFrame(frame);
