// The real layout of the field (OpenStreetMap), drawn plainly in daylight greys.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { V, RAD, box, disc, flat, picture, ribbon } from "./kit";

export const SKY = "#d4d5d3";
const GRASS = "#777a75";
const APRON = "#969795";
const TAXIWAY = "#717270";
const RUNWAY = "#464746";

function facade() {
  return picture(512, 512, (g, w, h) => {
    g.fillStyle = "#c9cac7";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#30353a";
    g.fillRect(0, h * 0.14, w, h * 0.74);
    g.fillStyle = "#49515a";
    for (let i = 0; i < 8; i++) g.fillRect((i * w) / 8 + 4, h * 0.17, w / 8 - 8, h * 0.4);
    g.fillStyle = "#59626b";
    for (let i = 0; i < 8; i++) g.fillRect((i * w) / 8 + 4, h * 0.6, w / 8 - 8, h * 0.25);
    g.fillStyle = "#a9aaa7";
    g.fillRect(0, h * 0.94, w, h * 0.06);
  });
}

function buildings(list) {
  const group = new THREE.Group();
  const map = facade();
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const glass = new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide });
  const roof = new THREE.MeshLambertMaterial({ color: "#6f716f", side: THREE.DoubleSide });
  const walls = [], roofs = [];
  for (const b of list) {
    const poly = b.polygon;
    if (poly.length < 3) continue;
    const height = Math.min(b.heightM, 45);
    const floors = Math.max(1, Math.round(height / 4.4));
    let twiceArea = 0;
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length];
      twiceArea += p.x * q.y - q.x * p.y;
    });
    const points = twiceArea > 0 ? poly : [...poly].reverse();
    const position = [], normal = [], uv = [];
    let run = 0;
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (!len) return;
      const nx = (q.y - p.y) / len, ny = -(q.x - p.x) / len;
      const a = run / 12;
      run += len;
      const b1 = run / 12;
      for (const [at, up, u] of [[p, 0, a], [q, 0, b1], [q, 1, b1], [p, 0, a], [q, 1, b1], [p, 1, a]]) {
        position.push(at.x, up * height, -at.y);
        normal.push(nx, 0, -ny);
        uv.push(u, up * floors);
      }
    });
    const wall = new THREE.BufferGeometry();
    wall.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    wall.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    wall.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    const top = new THREE.ShapeGeometry(new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, p.y)))).rotateX(-Math.PI / 2).translate(0, height, 0);
    walls.push(wall);
    roofs.push(top);
  }
  // There are two and a half thousand of them: one draw for all walls, one for all roofs.
  for (const [parts, material] of [[walls, glass], [roofs, roof]]) {
    if (!parts.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(parts), material);
    for (const part of parts) part.dispose();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = 20;
    group.add(mesh);
  }
  return group;
}

/** Streets and low blocks past the fence, so from the air it is a city. */
function city(centre) {
  const step = 170;
  const reach = 11000;
  const fence = 3700;
  const group = new THREE.Group();
  const streets = [];
  const spots = [];
  for (let i = -Math.floor(reach / step); i <= Math.floor(reach / step); i++) {
    const a = i * step;
    const half = Math.sqrt(reach * reach - a * a);
    const runs = Math.abs(a) < fence ? [[-half, -Math.sqrt(fence * fence - a * a)], [Math.sqrt(fence * fence - a * a), half]] : [[-half, half]];
    for (const [from, to] of runs) {
      ribbon(streets, { x: centre.x + a, y: centre.y + from }, { x: centre.x + a, y: centre.y + to }, i % 5 ? 10 : 24);
      ribbon(streets, { x: centre.x + from, y: centre.y + a }, { x: centre.x + to, y: centre.y + a }, i % 5 ? 10 : 24);
    }
    for (let j = -Math.floor(reach / step); j <= Math.floor(reach / step); j++) {
      const x = (i + 0.5) * step, y = (j + 0.5) * step;
      const far = Math.hypot(x, y);
      if (far < fence + 120 || far > reach) continue;
      const r = Math.abs(Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;
      if (r < 0.22) continue; // parks and yards
      spots.push({ x: centre.x + x, y: centre.y + y, r });
    }
  }
  group.add(flat(streets, "#898b87", 1));
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: "#ffffff" }), spots.length);
  const at = new THREE.Object3D();
  const shades = ["#666865", "#747673", "#80827f"].map((s) => new THREE.Color(s));
  spots.forEach(({ x, y, r }, i) => {
    const s = (r * 173) % 1, tall = (r * 911) % 1;
    at.position.set(x, 0, -y);
    at.scale.set(70 + s * 70, 4 + tall * tall * tall * 22, 60 + ((s * 13) % 1) * 80);
    at.updateMatrix();
    mesh.setMatrixAt(i, at.matrix);
    mesh.setColorAt(i, shades[Math.floor(s * 3)]);
  });
  mesh.renderOrder = 20;
  mesh.frustumCulled = false;
  group.add(mesh);
  return group;
}

function masts(airport) {
  const group = new THREE.Group();
  const steel = new THREE.MeshLambertMaterial({ color: "#a4a5a3" });
  const lamp = new THREE.MeshBasicMaterial({ color: "#fafaf9" });
  const gates = airport.nodes.filter((n) => n.kind === "gate");
  gates.forEach((n, i) => {
    if (i % 4) return;
    const edge = airport.edges.find((e) => e.from === n.id || e.to === n.id);
    const out = edge && airport.nodes.find((m) => m.id === (edge.from === n.id ? edge.to : edge.from));
    if (!out) return;
    const len = Math.hypot(out.x - n.x, out.y - n.y) || 1;
    const p = { x: n.x + (-(out.y - n.y) / len) * 23, y: n.y + ((out.x - n.x) / len) * 23 };
    const mast = new THREE.Group();
    mast.position.copy(V(p));
    mast.rotation.y = Math.atan2(out.x - n.x, -(out.y - n.y));
    box(mast, steel, [0.4, 21, 0.4], [0, 10.5, 0]);
    box(mast, steel, [4.2, 0.6, 0.5], [0, 21, 0]);
    for (const x of [-1.5, -0.5, 0.5, 1.5]) box(mast, lamp, [0.7, 0.35, 0.15], [x, 21, 0.3]);
    group.add(mast);
  });
  return group;
}

export function buildField(airport, c, runway) {
  const field = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.CircleGeometry(90_000, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: GRASS, depthWrite: false }));
  ground.renderOrder = 0;
  field.add(ground);

  const d = airport.drawing;
  for (const apron of d?.aprons ?? []) {
    if (apron.polygon.length < 3) continue;
    const mesh = new THREE.Mesh(
      new THREE.ShapeGeometry(new THREE.Shape(apron.polygon.map((p) => new THREE.Vector2(p.x, p.y)))).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: APRON, depthWrite: false, side: THREE.DoubleSide }),
    );
    mesh.renderOrder = 3;
    field.add(mesh);
  }

  const taxi = [], lanes = [], centre = [], stands = [];
  for (const way of d?.taxiways ?? []) {
    const main = way.kind === "taxiway";
    const out = main ? taxi : lanes;
    const width = main ? 25 : 17;
    way.points.forEach((p, i) => {
      disc(out, p, width / 2);
      if (!i) return;
      ribbon(out, way.points[i - 1], p, width);
      ribbon(centre, way.points[i - 1], p, 0.3);
    });
  }
  for (const stand of d?.stands ?? []) stand.points.slice(1).forEach((to, i) => ribbon(stands, stand.points[i], to, 0.3));
  // Lanes under the aprons, taxiways over them.
  field.add(flat(lanes, APRON, 2), flat(taxi, TAXIWAY, 4), flat(centre, "#c9cac7", 5), flat(stands, c.white, 5));

  const tarmac = [], paint = [], mine = [], hold = [], lamps = [];
  for (const r of airport.runways) {
    const [from, to] = r.paved ?? [r.ends[0].threshold, r.ends[1].threshold];
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const ux = (to.x - from.x) / len, uy = (to.y - from.y) / len;
    const w = r.widthM;
    const at = (s, off = 0) => ({ x: from.x + ux * s + uy * off, y: from.y + uy * s - ux * off });
    ribbon(tarmac, from, to, w);
    for (const side of [-1, 1]) ribbon(paint, at(0, side * (w / 2 - 1.5)), at(len, side * (w / 2 - 1.5)), 0.9);
    for (let s = 170; s + 36 < len - 170; s += 60) ribbon(paint, at(s), at(s + 36), 0.9);
    for (const s of [10, len - 42]) for (let i = 0; i < 6; i++) for (const side of [-1, 1]) ribbon(paint, at(s, side * (3 + i * 3.6)), at(s + 32, side * (3 + i * 3.6)), 1.8);
    for (const s of [400, len - 445]) for (const side of [-1, 1]) ribbon(paint, at(s, side * 10), at(s + 45, side * 10), 6);
    for (let s = 0; s <= len; s += 60) for (const side of [-1, 1]) disc(lamps, at(s, side * (w / 2 + 2)), 0.4, 0.2);
    r.ends.forEach((end, i) => {
      const map = picture(256, 256, (g) => {
        g.fillStyle = c.white;
        g.font = "700 150px Helvetica Neue, Arial";
        g.textAlign = "center";
        const [, number, side] = /^(\d+)([LRC]?)$/.exec(end.designator) ?? [null, end.designator, ""];
        g.fillText(number, 128, side ? 118 : 180);
        if (side) g.fillText(side, 128, 246);
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(26, 26).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false }));
      mesh.position.copy(V(at(i === 0 ? 64 : len - 64), 0.02));
      mesh.rotation.y = -end.headingDeg * RAD;
      mesh.renderOrder = 8;
      field.add(mesh);
      if (end.designator !== runway) return;
      const s = i === 0 ? 2 : len - 2;
      ribbon(mine, at(s, -w / 2), at(s, w / 2), 3);
    });
  }
  const node = new Map(airport.nodes.map((n) => [n.id, n]));
  // One line to a holding point, however many ways lead on from it.
  const lined = new Set();
  for (const edge of airport.edges) {
    if (edge.kind !== "runway_link") continue;
    let h = node.get(edge.from), o = node.get(edge.to);
    if (!h || !o) continue;
    if (h.kind !== "hold_short") [h, o] = [o, h];
    if (lined.has(h.id)) continue;
    lined.add(h.id);
    const len = Math.hypot(o.x - h.x, o.y - h.y) || 1;
    const ux = (o.x - h.x) / len, uy = (o.y - h.y) / len;
    for (const back of [0, 1.8]) {
      const m = { x: h.x - ux * back, y: h.y - uy * back };
      ribbon(hold, { x: m.x - uy * 12.5, y: m.y + ux * 12.5 }, { x: m.x + uy * 12.5, y: m.y - ux * 12.5 }, 0.8);
    }
  }
  field.add(flat(tarmac, RUNWAY, 6), flat(paint, c.white, 7), flat(lamps, c.white, 7), flat(hold, c.red, 9), flat(mine, c.red, 9));

  field.add(buildings(d?.buildings?.length ? d.buildings : airport.terminals.map((t) => ({ heightM: 18, polygon: t.polygon }))));
  field.add(city(airport.center ?? { x: 0, y: 0 }), masts(airport));
  return field;
}
