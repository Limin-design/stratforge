import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react")) return "vendor-react";
          if (id.includes("dockview")) return "vendor-dockview";
          if (id.includes("lightweight-charts")) return "vendor-charts";
          return "vendor";
        },
      },
    },
  },
});
