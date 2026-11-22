import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.TOWERAI_API ?? "http://127.0.0.1:8787";
// Object form keeps the browser's Host, which the server's same-origin check compares with Origin.
const proxy = { "/api": { target: api }, "/ws": { target: api, ws: true } };

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5181, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 5181, strictPort: true, proxy },
});
