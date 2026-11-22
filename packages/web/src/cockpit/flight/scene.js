// The visitor's flight in three dimensions, on the real field.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { aircraftPaint, buildAircraft, forgetAircraft } from "./aircraft";
import { SKY, buildField } from "./field";
import { buildStand, buildTug, neighbours, onStand, standNear, standsOf } from "./gate";
import { RAD, V, along, flat, picture, ribbon, turn } from "./kit";

const FT = 0.3048;
/** Drawn this far behind the newest report, so movement is between two known positions and cuts no corners. */
const LAG_MS = 330;
const lerp = THREE.MathUtils.lerp;
const SUN = new THREE.Vector3(0.42, 0.78, 0.46).normalize();

/** Camera by phase: metres right, ahead and up of the aircraft, then how far ahead and up it looks. */
function shot(phase, altM, failed) {
  // The failed engine is the left one: go round to that side to see it.
  if (failed && altM > 0.5) return [-54, -26, 12, -4, 4.5];
  switch (phase) {
    case "at_gate": return [53, -7, 10, -1, 5];
    case "pushback": return [56, 9, 12, 1, 4];
    case "taxi_out": case "taxi_in": return [27, -52, 22, 18, 2];
    case "holding_short": return [38, -50, 14, 7, 3];
    case "line_up": return [27, -54, 12, 14, 3];
    case "takeoff": return altM > 0.5 ? [72, 16, 4, -5, 6] : [62, -8, 8, -4, 4.5];
    case "departure": return altM < 150 ? [72, 16, 4, -5, 6] : [48, -46, 13, -2, 4];
    default: return [42, -52, 13, 0, 4];
  }
}

function release(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat()) {
      m?.map?.dispose();
      m?.dispose();
    }
  });
}

export function createFlightScene(canvas, airport, c, first) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.4));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 700, 12_000);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  release(room);
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(34, 1, 1.5, 120_000);
  scene.add(new THREE.HemisphereLight("#f4f5f3", "#555755", 1.5));
  const sun = new THREE.DirectionalLight("#ffffff", 2.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536);
  Object.assign(sun.shadow.camera, { left: -75, right: 75, top: 75, bottom: -75, near: 10, far: 600 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.normalBias = 0.06;
  sun.shadow.bias = -0.0002;
  scene.add(sun, sun.target);
  const shade = new THREE.Mesh(new THREE.PlaneGeometry(150, 150).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.38, depthWrite: false }));
  shade.receiveShadow = true;
  shade.renderOrder = 12;
  scene.add(shade);

  scene.add(buildField(airport, c, first.runway));

  const named = aircraftPaint(c, true);
  const plain = aircraftPaint(c, false);
  const model = (paint) => {
    const a = buildAircraft(paint);
    a.group.rotation.order = "YXZ";
    a.group.traverse((o) => (o.renderOrder = 40));
    scene.add(a.group);
    return a;
  };
  const me = model(named);
  const tug = buildTug(c);
  me.group.add(tug);

  const puffs = [];
  const trail = new THREE.Group();
  const soft = picture(96, 96, (g) => {
    for (let r = 47; r > 0; r -= 3) {
      g.fillStyle = "rgba(255,255,255,0.11)";
      g.beginPath();
      g.arc(48, 48, r, 0, Math.PI * 2);
      g.fill();
    }
  });
  for (let i = 0; i < 70; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: soft, color: "#17191a", transparent: true, depthWrite: false }));
    m.renderOrder = 42;
    trail.add(m);
    puffs.push(m);
  }
  const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: soft, color: c.red, transparent: true, depthWrite: false }));
  flame.renderOrder = 43;
  flame.position.copy(me.engine).add(new THREE.Vector3(0, 0, 2.5));
  trail.add(flame);
  me.group.add(trail);

  const route = flat([], c.red, 10);
  scene.add(route);

  const stands = standsOf(airport);
  const buildings = airport.drawing?.buildings ?? [];
  let mine = null;
  let dressed = null;
  let bridge = null;
  /** The stand is only known once the aircraft is seen on it. */
  const dress = (stand) => {
    if (dressed) return;
    dressed = stand;
    const built = buildStand(stand, buildings, c, true);
    scene.add(built.group);
    bridge = built.bridge;
    for (const other of neighbours(stands, stand, buildings, 9)) {
      const parked = model(plain);
      parked.group.position.copy(V(other.centre));
      parked.group.rotation.y = -other.hdg * RAD;
      parked.beacon.visible = false;
      scene.add(buildStand(other, buildings, c, false).group);
    }
  };

  const others = new Map();
  let state = first;
  let samples = [];
  let view = null;
  let frame = 0;
  let before = performance.now();
  let routeKey = "";

  const report = (next) => {
    const at = performance.now();
    if (samples.length && samples[0].run !== next.runId) {
      samples = [];
      view = null;
      mine = null;
    }
    state = next;
    const v = next.vitals;
    let p = { x: next.x, y: next.y };
    if (next.phase === "at_gate" || next.phase === "pushback") {
      mine ??= standNear(stands, p, next.phase === "at_gate" ? 8 : 150);
      if (mine) {
        dress(mine);
        p = onStand(mine, p);
      }
    }
    samples.push({ run: next.runId, at, ...p, alt: v.onGround ? 0 : Math.max(0, v.altFt) * FT, hdg: v.hdg });
    if (samples.length > 8) samples.shift();
  };
  report(first);

  const pose = (now) => {
    const t = now - LAG_MS;
    let a = samples[0], b = a;
    for (const s of samples) {
      b = s;
      if (s.at >= t) break;
      a = s;
    }
    const k = b.at > a.at ? Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at))) : 1;
    return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), alt: lerp(a.alt, b.alt, k), hdg: a.hdg + turn(a.hdg, b.hdg) * k };
  };

  const draw = (now) => {
    frame = requestAnimationFrame(draw);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const ratio = renderer.getPixelRatio();
    if (canvas.width !== Math.floor(w * ratio) || canvas.height !== Math.floor(h * ratio)) renderer.setSize(w, h, false);
    camera.aspect = w / h;

    const dt = Math.min(0.2, Math.max(0, now - before) / 1000);
    before = now;
    const p = pose(now);
    const v = state.vitals;
    const parked = state.phase === "at_gate" || state.phase === "pushback";
    // The tower's panel is on the right once it has spoken, so the aircraft moves over to the left of it.
    const aside = w <= 900 ? 0 : state.exchanges.length ? 40 : -95;
    const [right, ahead, up, lookAhead, lookUp] = shot(state.phase, p.alt, v.engines[0] === 0);
    // Round the aircraft, never in a straight line through it.
    const bearing = Math.atan2(right, ahead) / RAD, away = Math.hypot(right, ahead);
    if (!view) view = { hdg: p.hdg, bearing, away, up, lookAhead, lookUp, pitch: 0, bank: 0, aside, last: p.hdg };
    const ease = 1 - Math.exp(-dt * 1.6);
    view.hdg += turn(view.hdg, p.hdg) * ease;
    view.bearing += turn(view.bearing, bearing) * ease;
    for (const [key, to] of [["away", away], ["up", up], ["lookAhead", lookAhead], ["lookUp", lookUp], ["aside", aside]]) view[key] = lerp(view[key], to, ease);
    camera.setViewOffset(w, h, view.aside, -h * 0.035, w, h);

    const rotating = state.phase === "takeoff" && v.gsKt >= 130;
    const climb = p.alt > 0.5 ? Math.atan2(v.vsFpm * FT, Math.max(60, v.gsKt) * 30.87) / RAD : 0;
    const pitch = p.alt > 0.5 ? Math.min(13, Math.max(-3, climb * 1.3 + 2.5)) : rotating ? 5 : 0;
    view.pitch = lerp(view.pitch, pitch, 1 - Math.exp(-dt * 2.5));
    const rate = dt && p.alt > 10 ? turn(view.last, p.hdg) / dt : 0;
    view.last = p.hdg;
    view.bank = lerp(view.bank, Math.max(-20, Math.min(20, -rate * 4)), 1 - Math.exp(-dt * 1.5));

    me.group.position.copy(V(p, p.alt));
    me.group.rotation.set(view.pitch * RAD, -p.hdg * RAD, view.bank * RAD);
    me.gear.visible = v.gearDown;
    me.beacon.visible = state.phase !== "at_gate" && now % 1100 < 170;
    me.fans.forEach((fan, i) => (fan.rotation.z += dt * v.engines[i] * 0.14));
    tug.visible = parked;
    if (bridge) bridge.scale.z = lerp(bridge.scale.z, state.phase === "at_gate" ? 1 : 0.68, ease);

    trail.visible = v.engines[0] === 0 || v.smoke;
    if (trail.visible) {
      puffs.forEach((b, i) => {
        const age = (now / 1500 + i / puffs.length) % 1;
        b.position.set(me.engine.x + Math.sin(i * 3) * age * 1.7, me.engine.y + age * 3.5 + Math.cos(i * 5) * age, me.engine.z + 2.6 + age * 32);
        b.scale.setScalar(1.8 + age * 6.5);
        b.material.opacity = 0.95 * (1 - age) * Math.min(1, age * 14);
      });
      flame.visible = v.engines[0] === 0;
      flame.scale.setScalar(3 + Math.sin(now / 45) * 0.4);
    }

    const path = parked || p.alt >= 1 ? [] : state.path;
    const key = path.length ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${path.length}` : "";
    if (key !== routeKey) {
      routeKey = key;
      const line = [];
      [p, ...path].slice(0, -1).forEach((from, i) => ribbon(line, from, path[i], 0.75));
      route.geometry.dispose();
      route.geometry = new THREE.BufferGeometry();
      route.geometry.setAttribute("position", new THREE.Float32BufferAttribute(line, 3));
      route.visible = line.length > 0;
    }

    for (const t of state.traffic) {
      const stand = t.altFt <= 0 && t.status.includes("parked") ? standNear(stands, t, 8) : null;
      const at = V(stand ? stand.centre : t, t.altFt * FT);
      let o = others.get(t.callsign);
      if (!o) {
        o = model(plain);
        o.group.position.copy(at);
        others.set(t.callsign, o);
      }
      o.group.position.lerp(at, 1 - Math.exp(-dt * 4));
      o.group.rotation.y = -t.hdg * RAD;
      o.gear.visible = t.altFt < 1500;
    }
    for (const [id, o] of others) o.group.visible = state.traffic.some((t) => t.callsign === id);

    const ground = V(p);
    const centre = V(p, Math.min(p.alt, 400));
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(SUN, 260);
    shade.position.copy(ground).setY(0.03);
    shade.visible = p.alt < 90;

    camera.position.copy(V(along(p, view.hdg + view.bearing, view.away), p.alt + view.up));
    camera.lookAt(V(along(p, view.hdg, view.lookAhead), p.alt + view.lookUp));
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(draw);

  return {
    report,
    dispose() {
      cancelAnimationFrame(frame);
      release(scene);
      forgetAircraft();
      environment.dispose();
      // Not forceContextLoss: React mounts an effect twice in development, on the same canvas.
      renderer.dispose();
    },
  };
}
