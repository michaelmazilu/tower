// An A320-sized airliner, built in code: no downloaded model, no airline's livery.
// Nose towards -Z, wings along X, wheels on y = 0, origin amidships. Metres.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const LENGTH = 37.57;
const NOSE = -LENGTH / 2;
const TAIL = LENGTH / 2;
const R = 1.975;
const AXIS = 4.05;
const NOSE_LEN = 6.2;
const TAIL_LEN = 12.2;
const { clamp, smoothstep } = THREE.MathUtils;

/** The fuselage's radius and the height of its middle, at a station along it. */
function section(z) {
  if (z < NOSE + NOSE_LEN) {
    const t = clamp((z - NOSE) / NOSE_LEN, 0, 1);
    return { r: R * Math.pow(1 - (1 - t) * (1 - t), 0.58), y: AXIS - 0.5 * Math.pow(1 - t, 2.2) };
  }
  if (z > TAIL - TAIL_LEN) {
    const u = clamp((z - (TAIL - TAIL_LEN)) / TAIL_LEN, 0, 1);
    const r = R * (1 - 0.91 * Math.pow(u, 1.65));
    return { r, y: AXIS + (R - r) * 0.78 };
  }
  return { r: R, y: AXIS };
}

/** A point on the skin, by station and angle up from the belly. */
function skin(z, angle, out = 0) {
  const { r, y } = section(z);
  return [Math.sin(angle) * (r + out), y - Math.cos(angle) * (r + out), z];
}

function fuselage() {
  const along = 120;
  const round = 64;
  const position = [], uv = [], index = [];
  for (let i = 0; i <= along; i++) {
    // Stations crowd into the nose, where the curve is.
    const t = Math.pow(i / along, 1.45);
    const z = NOSE + t * LENGTH;
    for (let j = 0; j <= round; j++) {
      position.push(...skin(z, (j / round) * Math.PI * 2));
      uv.push(t, j / round);
    }
  }
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < round; j++) {
      const a = i * (round + 1) + j, b = a + round + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function livery(c, named) {
  const W = 4096, H = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  const x = (z) => ((z - NOSE) / LENGTH) * W;
  const m = W / LENGTH;
  const up = H / (Math.PI * 2);
  g.fillStyle = c.white;
  g.fillRect(0, 0, W, H);
  g.fillStyle = c.g200;
  g.fillRect(0, 0, W, 0.9 * up);
  g.fillRect(0, H - 0.9 * up, W, 0.9 * up);

  for (const side of [1, -1]) {
    const y = (angle) => (side === 1 ? angle : Math.PI * 2 - angle) * up;
    const band = (z0, z1, a0, a1) => g.fillRect(x(z0), Math.min(y(a0), y(a1)), x(z1) - x(z0), Math.abs(y(a1) - y(a0)));
    const area = (points) => {
      g.beginPath();
      points.forEach(([z, a], i) => (i ? g.lineTo(x(z), y(a)) : g.moveTo(x(z), y(a))));
      g.closePath();
      g.fill();
    };
    // Tail sweep, continued into the fin.
    g.fillStyle = named ? c.red : c.g600;
    area([[8.6, Math.PI], [11.2, 1.7], [14.6, 0.5], [16.2, 0], [TAIL, 0], [TAIL, Math.PI]]);

    g.fillStyle = "#20242a";
    for (let z = -11.6; z < 10.2; z += 0.53) {
      if (Math.abs(z + 0.5) < 0.2) continue;
      g.beginPath();
      g.ellipse(x(z), y(1.83), 0.13 * m, 0.095 * up, 0, 0, Math.PI * 2);
      g.fill();
    }
    // Flight deck glass, in panes.
    g.fillStyle = "#101317";
    area([[-17.45, Math.PI], [-17.45, 2.72], [-17.2, 2.2], [-16.55, 2.05], [-15.75, 2.12], [-15.7, 2.32], [-16.5, 2.62], [-16.75, Math.PI]]);
    g.fillStyle = c.white;
    for (const z of [-17.0, -16.4]) band(z, z + 0.07, 2.05, 2.6);
    band(-17.5, -16.7, Math.PI - 0.035, Math.PI);

    g.strokeStyle = c.g400;
    g.lineWidth = 5;
    for (const z of [-13.4, 11.0]) g.strokeRect(x(z), Math.min(y(1.36), y(2.12)), 0.82 * m, 0.76 * up);

    if (named) {
      g.save();
      g.translate(x(-7.6), y(2.23));
      if (side === 1) g.scale(-1, -1);
      g.scale(1, up / (R * m));
      g.fillStyle = c.black;
      g.font = `700 ${1.15 * m}px Helvetica Neue, Arial, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("TowerAI", 0, 0);
      g.restore();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// Top of the aerofoil from leading edge to trailing, then back underneath.
const FOIL = [
  [0, 0], [0.015, 0.22], [0.06, 0.42], [0.15, 0.58], [0.32, 0.64], [0.55, 0.5], [0.8, 0.24], [1, 0.03],
  [1, -0.01], [0.8, -0.1], [0.55, -0.24], [0.32, -0.36], [0.15, -0.36], [0.06, -0.28], [0.015, -0.14],
];

/** A surface through stations [x, y, leading edge z, chord, thickness, cant]; a cant of 90 degrees stands it upright. */
function loft(stations, mirror = false) {
  const position = [], index = [];
  const n = FOIL.length;
  const s = mirror ? -1 : 1;
  for (const [x, y, z, chord, thick, cant = 0] of stations) {
    const nx = -Math.sin((cant * Math.PI) / 180), ny = Math.cos((cant * Math.PI) / 180);
    for (const [along, off] of FOIL) position.push(s * (x + nx * off * thick), y + ny * off * thick, z + along * chord);
  }
  const face = (a, b, d) => (mirror ? index.push(a, d, b) : index.push(a, b, d));
  for (let i = 0; i + 1 < stations.length; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j, b = i * n + ((j + 1) % n);
      face(a, a + n, b);
      face(b, a + n, b + n);
    }
  }
  const end = (stations.length - 1) * n;
  for (let j = 1; j + 1 < n; j++) face(end, end + j + 1, end + j);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const WING = [
  [1.1, 3.05, -5.0, 7.4, 1.0], [2.2, 3.12, -4.35, 6.7, 0.88], [6.3, 3.55, -2.0, 3.9, 0.5],
  [11.5, 4.02, 0.6, 2.7, 0.3], [16.5, 4.5, 3.05, 1.62, 0.17],
];
const WINGLET = [
  [16.5, 4.5, 3.05, 1.62, 0.17], [17.15, 4.62, 3.38, 1.46, 0.15, 22], [17.6, 4.95, 3.75, 1.22, 0.13, 55],
  [17.8, 5.5, 4.2, 0.95, 0.11, 76], [17.92, 6.75, 5.05, 0.52, 0.07, 82],
];
const FIN = [
  [0, 5.5, 10.2, 6.6, 0.3, 90], [0, 6.3, 11.5, 5.5, 0.42, 90], [0, 9.0, 14.0, 3.6, 0.32, 90],
  [0, 11.7, 16.5, 2.0, 0.18, 90], [0, 11.85, 16.9, 1.5, 0.1, 90],
];
const STAB = [[0.3, 4.95, 13.5, 3.8, 0.4], [3.3, 5.28, 15.35, 2.3, 0.24], [6.15, 5.6, 17.0, 1.3, 0.12], [6.3, 5.62, 17.3, 0.9, 0.05]];
const ENGINE = { x: 5.75, y: 2.02, z: -5.1 };

let shared = null;
function geometry() {
  if (shared) return shared;
  const lathe = (points) => new THREE.LatheGeometry(points.map(([r, z]) => new THREE.Vector2(r, z)), 40).rotateX(Math.PI / 2);
  const blade = new THREE.BoxGeometry(0.13, 0.66, 0.03).translate(0, 0.56, 0);
  blade.rotateY(0.5);
  shared = {
    fuselage: fuselage(),
    fairing: new THREE.SphereGeometry(1, 28, 16).scale(2.15, 1.0, 5.8).translate(0, 2.8, -1.2),
    wings: [loft(WING), loft(WING, true)],
    winglets: [loft(WINGLET), loft(WINGLET, true)],
    fin: loft(FIN),
    stabs: [loft(STAB), loft(STAB, true)],
    cowl: lathe([[0.99, -1.72], [1.1, -1.5], [1.17, -0.95], [1.18, 0.1], [1.12, 1.0], [0.93, 1.75], [0.85, 2.0]]),
    lip: lathe([[0.86, -1.45], [0.87, -1.68], [0.93, -1.8], [1.02, -1.78], [1.1, -1.5]]),
    duct: lathe([[0.86, -1.46], [0.9, -0.9], [0.01, -0.86]]),
    exhaust: lathe([[0.85, 2.0], [0.62, 2.05], [0.55, 2.55], [0.2, 2.6], [0.01, 3.05]]),
    spinner: lathe([[0.01, -1.4], [0.15, -1.28], [0.27, -1.05], [0.28, -0.95]]),
    pylon: loft([[ENGINE.x, 2.95, -6.1, 5.2, 0.3, 90], [ENGINE.x, 3.6, -3.4, 3.6, 0.26, 90]]),
    blade,
    tyre: new THREE.CylinderGeometry(0.56, 0.56, 0.4, 28).rotateZ(Math.PI / 2),
    noseTyre: new THREE.CylinderGeometry(0.4, 0.4, 0.26, 24).rotateZ(Math.PI / 2),
    hub: new THREE.CylinderGeometry(0.27, 0.27, 0.42, 16).rotateZ(Math.PI / 2),
    strut: new THREE.CylinderGeometry(0.14, 0.17, 1, 14),
    lamp: new THREE.SphereGeometry(0.13, 10, 8),
  };
  return shared;
}

/** For the scene to call when it goes: the shapes are shared between aircraft. */
export function forgetAircraft() {
  shared = null;
}

export function aircraftPaint(c, named) {
  const paint = (color, roughness, metalness = 0, more = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: 0.65, ...more });
  const side = { side: THREE.DoubleSide };
  return {
    named,
    skin: new THREE.MeshPhysicalMaterial({ map: livery(c, named), roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2, envMapIntensity: 0.55, ...side }),
    wing: paint("#b9bab8", 0.38, 0.35, side),
    belly: paint(c.g200, 0.4, 0.1),
    tail: paint(named ? c.red : c.g600, 0.32, 0.05, side),
    white: paint(c.white, 0.3, 0.05, side),
    steel: paint("#d9d9d7", 0.16, 0.95, side),
    dark: paint("#17191c", 0.65, 0.2, side),
    fan: paint("#70747a", 0.3, 0.8, side),
    tyre: paint("#111213", 0.9),
    mark: new THREE.MeshBasicMaterial({ color: c.white, ...side }),
    red: new THREE.MeshBasicMaterial({ color: c.red }),
    lamp: new THREE.MeshBasicMaterial({ color: "#ffffff" }),
  };
}

/** One mesh for each paint among a node's own children, so an aircraft is a dozen draws and not eighty. */
function bake(node) {
  const byPaint = new Map();
  for (const child of [...node.children]) {
    if (!child.isMesh) continue;
    child.updateMatrix();
    const part = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    part.applyMatrix4(child.matrix);
    if (!part.attributes.uv) part.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(part.attributes.position.count * 2), 2));
    if (!byPaint.has(child.material)) byPaint.set(child.material, []);
    byPaint.get(child.material).push(part);
    node.remove(child);
  }
  const meshes = [];
  for (const [material, parts] of byPaint) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), material);
    for (const part of parts) part.dispose();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    node.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

/** Built once for each paint, then copied: every aircraft in that paint shares the shapes. */
export function buildAircraft(paint) {
  paint.plan ??= assemble(paint);
  const group = paint.plan.clone();
  return {
    group,
    gear: group.getObjectByName("gear"),
    beacon: group.getObjectByName("beacon"),
    fans: ["fan0", "fan1"].map((name) => group.getObjectByName(name)),
    engine: new THREE.Vector3(-ENGINE.x, ENGINE.y, ENGINE.z),
  };
}

function assemble(paint) {
  const g = geometry();
  const group = new THREE.Group();
  const gear = new THREE.Group();
  const add = (shape, material, parent = group, at = null) => {
    const mesh = new THREE.Mesh(shape, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (at) mesh.position.set(...at);
    parent.add(mesh);
    return mesh;
  };

  add(g.fuselage, paint.skin);
  add(g.fairing, paint.belly);
  for (const w of g.wings) add(w, paint.wing);
  for (const w of g.winglets) add(w, paint.tail);
  add(g.fin, paint.tail);
  for (const s of g.stabs) add(s, paint.wing);

  if (paint.named) {
    // The product's square, on both sides of the fin.
    for (const side of [-1, 1]) {
      const mark = add(new THREE.PlaneGeometry(1.55, 1.55), paint.mark, group, [side * 0.3, 9.1, 15.8]);
      mark.rotation.y = Math.PI / 2;
      mark.castShadow = false;
    }
  }

  const fans = [];
  for (const side of [-1, 1]) {
    const at = [side * ENGINE.x, ENGINE.y, ENGINE.z];
    add(g.cowl, paint.white, group, at);
    add(g.lip, paint.steel, group, at);
    add(g.duct, paint.dark, group, at);
    add(g.exhaust, paint.steel, group, at);
    const fan = new THREE.Group();
    fan.name = `fan${fans.length}`;
    fan.position.set(...at);
    for (let i = 0; i < 18; i++) add(g.blade, paint.fan, fan, [0, 0, -1.02]).rotation.z = (i / 18) * Math.PI * 2;
    add(g.spinner, paint.steel, fan);
    fans.push(fan);
    add(g.pylon, paint.wing).position.x = side === 1 ? 0 : -ENGINE.x * 2;
  }

  const strut = (x, z, top, bottom) => {
    const m = add(g.strut, paint.steel, gear, [x, (top + bottom) / 2, z]);
    m.scale.y = top - bottom;
  };
  for (const dx of [-0.25, 0.25]) add(g.noseTyre, paint.tyre, gear, [dx, 0.4, -13.8]);
  strut(0, -13.8, 2.5, 0.4);
  for (const side of [-1, 1]) {
    strut(side * 3.8, 0.7, 3.2, 0.56);
    for (const dx of [-0.46, 0.46]) {
      add(g.tyre, paint.tyre, gear, [side * 3.8 + dx, 0.56, 0.7]);
      add(g.hub, paint.steel, gear, [side * 3.8 + dx, 0.56, 0.7]);
    }
  }
  group.add(gear);

  add(g.lamp, paint.red, group, [-17.3, 4.7, 3.6]);
  add(g.lamp, paint.lamp, group, [17.3, 4.7, 3.6]);
  const beacon = add(g.lamp, paint.red, group, [0, AXIS + R + 0.07, -2]);
  for (const side of [-1, 1]) add(g.lamp, paint.lamp, group, [side * 1.9, 3.1, -4.75]);

  group.remove(beacon);
  bake(group);
  gear.name = "gear";
  bake(gear);
  for (const fan of fans) {
    bake(fan);
    group.add(fan);
  }
  beacon.name = "beacon";
  group.add(beacon);
  return group;
}
