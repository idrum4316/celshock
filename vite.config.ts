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

/** The one file the editor may write. Compared, never used to build a path. */
const LAYOUT_REL = "src/world/hollowmere/layout.ts";

function layoutWriter(): Plugin {
  const layoutAbs = resolve(process.cwd(), LAYOUT_REL);
  let selfWrite = false;

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
            // COMPARED against a literal. It never reaches the filesystem, so
            // traversal is not possible regardless of what was sent.
            if (path !== LAYOUT_REL) {
              throw new Error(`refusing to write ${path}`);
            }
            // Cheap sanity gates against writing a truncated or wrong file.
            if (typeof source !== "string" || source.length < 4000) {
              throw new Error("payload too small to be the layout");
            }
            if (!source.includes("export const HollowmereLayout")) {
              throw new Error("payload is missing the layout export");
            }
            selfWrite = true;
            writeFileSync(layoutAbs, source, "utf8");
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, bytes: source.length }));
          } catch (err) {
            selfWrite = false;
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });
    },

    handleHotUpdate(ctx) {
      // layout.ts has no import.meta.hot.accept, so an update propagates all
      // the way to main.ts, finds no accepting module, and full-reloads the
      // page — losing the camera, the selection, and the editing session, on
      // every save. Swallow the editor's OWN writes. A manual edit in the
      // editor of your choice still reloads, which is what you want.
      if (ctx.file === layoutAbs && selfWrite) {
        selfWrite = false;
        return [];
      }
    },
  };
}

export default defineConfig({
  plugins: [layoutWriter()],
});
