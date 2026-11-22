// A stand: where an aircraft really stops, its markings, bridge and vehicles.
import * as THREE from "three";
import { LENGTH } from "./aircraft";
import { V, RAD, along, box, flat, insidePolygon, ribbon } from "./kit";

/** The map's gate point is where the nose wheel line ends, so the middle of the aircraft sits well short of it. */
export const SETBACK = LENGTH / 2 + 14;

export function standsOf(airport) {
  const node = new Map(airport.nodes.map((n) => [n.id, n]));
  const stands = [];
  for (const n of airport.nodes) {
    if (n.kind !== "gate") continue;
    const edge = airport.edges.find((e) => e.from === n.id || e.to === n.id);
    const out = edge && node.get(edge.from === n.id ? edge.to : edge.from);
    if (!out) continue;
    const len = Math.hypot(out.x - n.x, out.y - n.y);
    if (len < SETBACK + 5) continue;
    const ux = (out.x - n.x) / len, uy = (out.y - n.y) / len;
    stands.push({ x: n.x, y: n.y, ux, uy, len, hdg: Math.atan2(-ux, -uy) / RAD, centre: { x: n.x + ux * SETBACK, y: n.y + uy * SETBACK } });
  }
  return stands;
}

export function standNear(stands, p, within) {
  let best = null, d = within;
  for (const s of stands) {
    const far = Math.hypot(s.x - p.x, s.y - p.y);
    if (far < d) [best, d] = [s, far];
  }
  return best;
}

/** From the simulation's point to where the aircraft is drawn while it is on its stand. */
export function onStand(stand, p) {
  const back = Math.max(0, Math.min(stand.len, (p.x - stand.x) * stand.ux + (p.y - stand.y) * stand.uy));
  const drawn = SETBACK + (back * (stand.len - SETBACK)) / stand.len;
  return { x: p.x + stand.ux * (drawn - back), y: p.y + stand.uy * (drawn - back) };
}

/** Neighbours with room to park. They are scenery: the simulation does not know them. */
export function neighbours(stands, mine, buildings, limit) {
  const chosen = [];
  const reach = [[18, 0], [-21, 0], [3, 18], [3, -18], [9, 11], [9, -11]];
  const eye = along(mine.centre, mine.hdg, 8, 52);
  const sorted = [...stands].sort((a, b) => Math.hypot(a.x - mine.x, a.y - mine.y) - Math.hypot(b.x - mine.x, b.y - mine.y));
  for (const s of sorted) {
    if (s === mine || chosen.length >= limit) continue;
    const c = s.centre;
    const far = (p, d) => Math.hypot(c.x - p.x, c.y - p.y) >= d;
    if (!far(mine.centre, 42) || !far(eye, 32) || chosen.some((o) => !far(o.centre, 43))) continue;
    // Not on the line we are pushed back along.
    const t = Math.max(0, Math.min(mine.len, (c.x - mine.x) * mine.ux + (c.y - mine.y) * mine.uy));
    if (!far({ x: mine.x + mine.ux * t, y: mine.y + mine.uy * t }, 40)) continue;
    if (reach.some(([a, r]) => buildings.some((b) => insidePolygon(along(c, s.hdg, a, r), b.polygon)))) continue;
    chosen.push(s);
  }
  return chosen;
}

function nearestWall(p, buildings) {
  let best = null, d = 60;
  for (const b of buildings) {
    b.polygon.forEach((a, i) => {
      const q = b.polygon[(i + 1) % b.polygon.length];
      const dx = q.x - a.x, dy = q.y - a.y;
      const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const at = { x: a.x + k * dx, y: a.y + k * dy };
      const far = Math.hypot(at.x - p.x, at.y - p.y);
      if (far < d) [best, d] = [at, far];
    });
  }
  return best;
}

export function buildStand(stand, buildings, c, busy) {
  const group = new THREE.Group();
  const { centre, hdg } = stand;
  const at = (ahead, right) => along(centre, hdg, ahead, right);

  const red = [], white = [];
  const corners = [at(21, -7), at(21, 7), at(5, 20), at(-9, 20), at(-21, 8), at(-21, -8), at(-9, -20), at(5, -20)];
  corners.forEach((p, i) => ribbon(red, p, corners[(i + 1) % corners.length], 0.16));
  ribbon(white, at(13.8, -2.2), at(13.8, 2.2), 0.35);
  group.add(flat(red, c.red, 10), flat(white, c.white, 10));

  const paint = (color, roughness = 0.6, metalness = 0.1) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const body = paint("#e2e3e0"), dark = paint("#25282b"), steel = paint("#8b8d8b", 0.4, 0.6), glass = paint("#39424b", 0.15, 0.5);

  let bridge = null;
  const door = at(13.0, -2.6);
  const wall = nearestWall(door, buildings);
  if (wall) {
    const len = Math.hypot(wall.x - door.x, wall.y - door.y);
    const arm = new THREE.Group();
    arm.position.copy(V(wall));
    arm.rotation.y = Math.atan2(door.x - wall.x, -(door.y - wall.y));
    box(arm, body, [3.2, 3.1, len - 1.5], [0, 5.2, (len - 1.5) / 2]);
    box(arm, glass, [3.26, 1.0, len - 3], [0, 5.6, (len - 1.5) / 2]);
    for (let z = 2.5; z < len - 3; z += 3.2) box(arm, body, [3.32, 1.1, 0.3], [0, 5.6, z]);
    box(arm, dark, [4.1, 3.6, 2.4], [0, 5.2, len - 1.2]);
    box(arm, steel, [0.7, 3.6, 0.7], [0, 1.8, Math.max(2, len - 4.5)]);
    box(arm, dark, [2.6, 0.8, 1.0], [0, 0.4, Math.max(2, len - 4.5)]);
    group.add(arm);
    bridge = arm;
  }

  if (busy) {
    const kit = new THREE.Group();
    kit.position.copy(V(centre));
    kit.rotation.y = -hdg * RAD;
    const wheels = (x, z, w, l) => {
      for (const dx of [-w, w]) for (const dz of [-l, l]) box(kit, dark, [0.35, 0.7, 0.8], [x + dx, 0.35, z + dz]);
    };
    // Baggage train, clear of the engine and of the way out.
    box(kit, body, [1.7, 1.2, 2.6], [9, 1.0, -17]);
    box(kit, glass, [1.6, 0.8, 1.1], [9, 1.95, -16.6]);
    wheels(9, -17, 0.8, 0.85);
    for (const [i, z] of [-13.6, -10.6].entries()) {
      box(kit, steel, [1.7, 0.25, 2.3], [11.5 + i, 0.7, z]);
      for (const dz of [-0.55, 0.55]) box(kit, i ? body : dark, [1.2, 0.85, 0.9], [11.5 + i, 1.25, z + dz]);
      wheels(11.5 + i, z, 0.75, 0.7);
    }
    // Service truck.
    box(kit, body, [2.6, 2.6, 5.2], [-12, 2.2, -19]);
    box(kit, glass, [2.4, 1.2, 1.6], [-12, 1.8, -22.4]);
    wheels(-12, -19.8, 1.15, 2.2);
    const cone = new THREE.ConeGeometry(0.3, 0.8, 4);
    const orange = paint(c.red, 0.8);
    for (const [x, z] of [[18.6, 4.5], [-18.6, 4.5], [7.5, -8], [-7.5, -8], [0, 21], [2.8, -20.5]]) {
      const mesh = new THREE.Mesh(cone, orange);
      mesh.position.set(x, 0.4, z);
      mesh.castShadow = true;
      mesh.renderOrder = 30;
      kit.add(mesh);
    }
    group.add(kit);
  }
  return { group, bridge };
}

/** The pushback tug, hung on the nose wheel. */
export function buildTug(c) {
  const tug = new THREE.Group();
  const paint = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 });
  const red = paint(c.red), dark = paint("#25282b"), glass = paint("#39424b");
  box(tug, dark, [0.25, 0.2, 4.2], [0, 0.5, -15.9], 45);
  box(tug, red, [3, 1.15, 5.2], [0, 0.95, -20.4], 45);
  box(tug, glass, [2.1, 0.9, 1.6], [0, 1.95, -21.2], 45);
  box(tug, red, [2.3, 0.15, 1.8], [0, 2.45, -21.2], 45);
  for (const x of [-1.4, 1.4]) for (const z of [-22, -18.8]) box(tug, dark, [0.5, 1, 1.1], [x, 0.5, z], 45);
  return tug;
}
