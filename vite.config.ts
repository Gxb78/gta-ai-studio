import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Config minimale pour Tauri : port fixe, pas de clearScreen.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // Tauri sonde 127.0.0.1 : on bind explicitement en IPv4.
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
