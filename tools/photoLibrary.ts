import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";

/** Read-only catalog: independent of the optional local image-saving extension. */
export function photoLibrary(): Plugin {
  let publicDir: string, base: string;
  const catalog = async () => {
    const images: { path: string; name: string }[] = [];
    const scan = async (directory: string) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await scan(path);
        else if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
          images.push({ path: relative(publicDir, path).split(sep).join("/"), name: entry.name });
      }
    };
    await scan(join(publicDir, "images"));
    images.sort((a, b) => a.path.localeCompare(b.path, "ko", { numeric: true }));
    return { version: 1, images };
  };
  return {
    name: "public-photo-library",
    configResolved(config) { publicDir = config.publicDir; base = config.base; },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        // Vite's public-file lookup uses decodeURI, which keeps reserved filename
        // characters encoded. Serve catalogued names such as "사진 #1.png" here.
        if (pathname.startsWith(`${base}images/`) && pathname.includes("%")) {
          try {
            const path = decodeURIComponent(pathname.slice(base.length));
            const entry = (await catalog()).images.find(image => image.path === path);
            if (!entry) { response.statusCode = 404; response.end(); return; }
            const bytes = await readFile(join(publicDir, entry.path));
            response.setHeader("Content-Type", /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg");
            response.end(request.method === "HEAD" ? undefined : bytes);
          } catch { response.statusCode = 404; response.end(); }
          return;
        }
        if (pathname !== `${base}images/catalog.json`) { next(); return; }
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        try { response.end(JSON.stringify(await catalog())); }
        catch (error) {
          server.config.logger.error(`사진 목록 읽기 실패: ${String(error)}`);
          response.statusCode = 500; response.end(JSON.stringify({ error: "사진 목록을 읽지 못했어요." }));
        }
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "images/catalog.json", source: JSON.stringify(await catalog()) });
    },
  };
}
