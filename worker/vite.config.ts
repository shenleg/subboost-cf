// 将浏览器可用的原版页面与共享 UI 打包为独立 Worker 静态资源。
import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/postcss";
import { defineConfig } from "vite";

const pathFromWorker = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  publicDir: pathFromWorker("../local/public"),
  resolve: {
    // 跨工作区引用时，Hooks 和渲染器必须使用同一个 React 实例。
    dedupe: ["react", "react-dom"],
    alias: {
      "next/link": pathFromWorker("./web/shims/link.tsx"),
      "next/image": pathFromWorker("./web/shims/image.tsx"),
      "next/navigation": pathFromWorker("./web/shims/navigation.ts"),
      "@local": pathFromWorker("../local/src"),
      "@subboost/ui": pathFromWorker("../packages/ui/src"),
    },
  },
  oxc: { jsx: { runtime: "automatic" } },
  css: { postcss: { plugins: [tailwind()] } },
  build: {
    rolldownOptions: {
      onLog(level, log, handler) {
        // RSC 边界在纯客户端构建中没有语义，但保留其他捆绑诊断。
        if (log.code === "MODULE_LEVEL_DIRECTIVE" && log.message.includes('"use client"')) return;
        handler(level, log);
      },
    },
  },
});
