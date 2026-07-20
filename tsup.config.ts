import { defineConfig } from "tsup";

export default defineConfig({
  // pngjs 含 CommonJS require("util")，打进 ESM 会报 Dynamic require；保持外部依赖从 node_modules 加载
  external: ["pngjs"],
});
