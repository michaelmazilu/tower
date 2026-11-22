import { createReadStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;

const acceptsGzip = (req: IncomingMessage) => /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
const zip = promisify(gzip);
/** Compressed bodies by path, kept until the file changes. */
const zipped = new Map<string, { version: string; body: Promise<Buffer> }>();

export async function isFile(path: string): Promise<boolean> {
  return fs.stat(path).then((s) => s.isFile(), () => false);
}

/** Streams a file, with gzip for text and byte ranges for audio. */
export async function serveFile(req: IncomingMessage, res: ServerResponse, path: string, cache: string): Promise<void> {
  const stat = await fs.stat(path);
  const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string | number> = { "content-type": type, "cache-control": cache, "x-content-type-options": "nosniff" };

  if (COMPRESSIBLE.test(type)) {
    headers.vary = "accept-encoding";
    if (acceptsGzip(req)) {
      const version = `${stat.mtimeMs}:${stat.size}`;
      let entry = zipped.get(path);
      if (entry?.version !== version) {
        entry = { version, body: fs.readFile(path).then((raw) => zip(raw)) };
        zipped.set(path, entry);
      }
      const body = await entry.body;
      res.writeHead(200, { ...headers, "content-encoding": "gzip", "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
  }

  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = type.startsWith("audio/") ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "") : null;
  if (type.startsWith("audio/")) headers["accept-ranges"] = "bytes";
  if (range && Number(range[1]) < stat.size) {
    start = Number(range[1]);
    if (range[2]) end = Math.max(start, Math.min(end, Number(range[2])));
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  res.writeHead(status, { ...headers, "content-length": Math.max(0, end - start + 1) });
  if (req.method === "HEAD" || stat.size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  // The status is already sent; all that is left is to hang up.
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/**
 * The file to serve for a URL path in a single-page app, or null. Never
 * leaves `root`; a page route falls back to index.html, a missing asset does not.
 */
export async function appFile(root: string, urlPath: string): Promise<string | null> {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (path.includes("\0") || path.includes("\\")) return null;
  const base = resolve(root);
  const file = resolve(base, `.${path.startsWith("/") ? path : `/${path}`}`);
  if (file !== base && !file.startsWith(base + sep)) return null;
  if (file !== base && (await isFile(file))) return file;
  if (extname(file) || path.startsWith("/assets/")) return null;
  const index = join(base, "index.html");
  return (await isFile(index)) ? index : null;
}
