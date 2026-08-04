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
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

/**
 * Emits `dist/sw.js` from the template at `src/pwa/sw.js`, with `__PRECACHE__`
 * replaced by a manifest of everything the build produced.
 *
 * It runs in `writeBundle` and walks `dist/` on disk rather than reading the
 * Rollup bundle, for two reasons: `index.html` and the copied `public/` files
 * are not both reliably in the bundle object at any one hook, and what the
 * worker must precache is exactly "the files that were deployed".
 *
 * The version is a hash of every file's NAME AND CONTENTS. Hashing the names
 * alone looks sufficient — Vite content-hashes the asset filenames — but
 * `index.html` is the one unhashed file, and this project keeps the whole HUD
 * stylesheet inside it. A change there would otherwise leave the worker's
 * bytes identical, and a byte-identical worker is one the browser never
 * updates: the old HUD would be served from cache forever.
 */
function serviceWorker(): Plugin {
  const walk = (dir: string, root: string) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) return walk(abs, root);
      return [relative(root, abs).split("\\").join("/")];
    });

  return {
    name: "hollowmere-service-worker",
    apply: "build",

    writeBundle(options) {
      const outDir = options.dir ?? resolve(process.cwd(), "dist");
      // Source maps are a debugging aid nobody loads offline, and the worker
      // itself is not something the worker caches.
      const files = walk(outDir, outDir)
        .filter((f) => f !== "sw.js" && !f.endsWith(".map"))
        .sort();

      const hash = createHash("sha256");
      for (const file of files) {
        hash.update(file);
        hash.update(readFileSync(join(outDir, file)));
      }

      const manifest = {
        version: hash.digest("hex").slice(0, 12),
        // "/" is the URL a launch actually asks for; index.html is the same
        // bytes under the name the deploy wrote. The worker's navigation
        // handler looks up "/", so it has to be a precached key in its own
        // right rather than a redirect the cache knows nothing about.
        urls: ["/", ...files.map((f) => `/${f}`)],
      };

      const template = readFileSync(
        resolve(process.cwd(), "src/pwa/sw.js"),
        "utf8",
      );
      // The whole declaration is the anchor, not the placeholder alone: the
      // file's header comment names the placeholder too, and a plain string
      // replace substitutes the manifest into the prose instead of the code.
      const decl = /^const PRECACHE = __PRECACHE__;$/m;
      if (!decl.test(template)) {
        throw new Error("src/pwa/sw.js is missing its PRECACHE declaration");
      }
      writeFileSync(
        join(outDir, "sw.js"),
        template.replace(
          decl,
          `const PRECACHE = ${JSON.stringify(manifest, null, 2)};`,
        ),
        "utf8",
      );
    },
  };
}

export default defineConfig({
  plugins: [layoutWriter(), serviceWorker()],
});
