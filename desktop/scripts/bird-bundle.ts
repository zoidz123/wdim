import { readFile } from "node:fs/promises";
import path from "node:path";
import { build, type Plugin } from "esbuild";

export async function buildBirdCliBundle(root: string, dist: string): Promise<void> {
  await build({
    entryPoints: [path.join(root, "node_modules/@steipete/bird/dist/cli.js")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(dist, "bird.mjs"),
    sourcemap: false,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    },
    plugins: [chromeCookieExpiryCastPlugin()]
  });
}

function chromeCookieExpiryCastPlugin(): Plugin {
  return {
    name: "chrome-cookie-expiry-cast",
    setup(esbuild) {
      esbuild.onLoad({ filter: /@steipete\/sweet-cookie\/dist\/providers\/chromeSqlite\/shared\.js$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const target = "`SELECT name, value, host_key, path, expires_utc, samesite, encrypted_value, ` +";
        const replacement = "`SELECT name, value, host_key, path, CAST(expires_utc AS TEXT) AS expires_utc, samesite, encrypted_value, ` +";
        const contents = source.replace(target, replacement);
        if (contents === source) {
          throw new Error("Could not patch sweet-cookie Chrome expires_utc query for Electron Node.");
        }
        return { contents, loader: "js" };
      });
    }
  };
}
