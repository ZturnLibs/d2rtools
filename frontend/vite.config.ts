import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // dev 下前端要 import 项目根的 ../src/ztron-commands.ts（codegen 产物）
    fs: { allow: [".."] },
  },
});
