import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom", "three", "zustand"] },
  root: ".",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    host: "127.0.0.1",
    port: 5317,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.CHIMERA_DEMO_BACKEND || "https://modal-labs-demos--chimera-demo-server-serve.us-east.modal.run",
        changeOrigin: true,
      },
    },
  },
});
