/**
 * vite.config.ts — Dev-server plumbing for the map editor, and nothing else.
 *
 * NOTE: this file is deliberately kept OUT of tsconfig.json's `include`
 * (which is ["src", "main.ts"]). @types/node is not installed, so `node:fs`
 * would fail `npm run typecheck`. The trade is that this file is not
 * typechecked — so it stays trivial, and all the real logic lives in
 * src/editor/serialize.ts where the compiler does cover it.
 *
 * The plugin is `apply: "serve"`, so it does not exist in a production build.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * The only files the editor may write. Compared, never used to build a path.
 * `layout.ts` is patched line by line and must look like a layout; `heights.ts`
 * is regenerated wholesale by terrain mode and must look like a heightfield.
 */
const WRITABLE = {
  "src/world/hollowmere/layout.ts": {
    min: 4000,
    marker: "export const HollowmereLayout",
  },
  "src/world/hollowmere/heights.ts": {
    min: 500,
    marker: "export const HollowmereHeights",
  },
};

function layoutWriter(): Plugin {
  const absOf = (rel: string) => resolve(process.cwd(), rel);
  const selfWritten = new Set();

  return {
    name: "hollowmere-layout-writer",
    apply: "serve",

    configureServer(server) {
      server.middlewares.use("/__layout", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("POST only");
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const { path, source } = JSON.parse(body);
            // Path safety by construction: the client's path is only ever
            // LOOKED UP in a literal table. It never reaches the filesystem as
            // given, so traversal is not possible regardless of what was sent.
            const rule = Object.prototype.hasOwnProperty.call(WRITABLE, path)
              ? WRITABLE[path]
              : null;
            if (!rule) {
              throw new Error(`refusing to write ${path}`);
            }
            // Cheap sanity gates against writing a truncated or wrong file.
            if (typeof source !== "string" || source.length < rule.min) {
              throw new Error(`payload too small to be ${path}`);
            }
            if (!source.includes(rule.marker)) {
              throw new Error(`payload is missing ${rule.marker}`);
            }
            const abs = absOf(path);
            selfWritten.add(abs);
            writeFileSync(abs, source, "utf8");
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, bytes: source.length }));
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });
    },

    handleHotUpdate(ctx) {
      // Neither file has import.meta.hot.accept, so an update propagates all
      // the way to main.ts, finds no accepting module, and full-reloads the
      // page — losing the camera, the selection, and the editing session, on
      // every save. Swallow the editor's OWN writes. A manual edit in the
      // editor of your choice still reloads, which is what you want.
      if (selfWritten.has(ctx.file)) {
        selfWritten.delete(ctx.file);
        return [];
      }
    },
  };
}

export default defineConfig({
  plugins: [layoutWriter()],
});
