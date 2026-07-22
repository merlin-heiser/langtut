import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs are required when the app is bundled into a Capacitor WebView.
  base: "./",
  server: { host: true, port: 5174, proxy: { "/api": "http://127.0.0.1:3210" } },
});
