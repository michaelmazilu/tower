// Small shared pieces of the 3D scene. World: x east, y north. Scene: X = x, Y = up, Z = -y.
import * as THREE from "three";

export const RAD = Math.PI / 180;
export const V = (p, h = 0) => new THREE.Vector3(p.x, h, -p.y);
export const turn = (a, b) => ((b - a + 540) % 360) - 180;
export const along = (p, hdg, ahead, right = 0) => ({
  x: p.x + Math.sin(hdg * RAD) * ahead + Math.cos(hdg * RAD) * right,
  y: p.y + Math.cos(hdg * RAD) * ahead - Math.sin(hdg * RAD) * right,
});

export function ribbon(out, from, to, width, height = 0) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (!len) return;
  const ox = (-(to.y - from.y) / len) * (width / 2);
  const oy = ((to.x - from.x) / len) * (width / 2);
  const a = [from.x + ox, from.y + oy], b = [from.x - ox, from.y - oy], c = [to.x - ox, to.y - oy], d = [to.x + ox, to.y + oy];
  for (const [x, y] of [a, b, c, a, c, d]) out.push(x, height, -y);
}

export function disc(out, at, radius, height = 0) {
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    out.push(at.x, height, -at.y, at.x + Math.cos(a) * radius, height, -(at.y + Math.sin(a) * radius), at.x + Math.cos(b) * radius, height, -(at.y + Math.sin(b) * radius));
  }
}

/** Paint on the ground: drawn in order, with no depth, so nothing flickers. */
export function flat(positions, color, order) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthWrite: false }));
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  return mesh;
}

export function picture(width, height, paint) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext("2d"), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

export function box(parent, material, [w, h, l], [x, y, z], order = 30) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.renderOrder = order;
  parent.add(mesh);
  return mesh;
}

export function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) inside = !inside;
  }
  return inside;
}
