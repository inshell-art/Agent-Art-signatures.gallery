import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageName = "@fontsource-variable/instrument-sans";
const { version } = JSON.parse(readFileSync(require.resolve(`${packageName}/package.json`), "utf8")) as { version: string };
const basePath = `/assets/fonts/instrument-sans-${version}`;

// Resolve package assets from either src or compiled dist, independently of cwd.
// Only these four WOFF2 files and their license are public; never resolve a request path.
const assets = new Map<string, { bytes: Buffer; contentType: string }>();
for (const subset of ["latin", "latin-ext"]) {
  for (const style of ["normal", "italic"]) {
    const filename = `instrument-sans-${subset}-wght-${style}.woff2`;
    assets.set(`${basePath}/${filename}`, {
      bytes: readFileSync(require.resolve(`${packageName}/files/${filename}`)),
      contentType: "font/woff2",
    });
  }
}
assets.set(`${basePath}/LICENSE.txt`, {
  bytes: readFileSync(require.resolve(`${packageName}/LICENSE`)),
  contentType: "text/plain; charset=utf-8",
});

export function siteFontAsset(pathname: string) {
  return assets.get(pathname);
}

export const SITE_FONT_PRELOAD = `<link rel="preload" href="${basePath}/instrument-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>`;

// Preserve the distributor's weight ranges, true italics and Unicode subsets.
// Latin upright is preloaded; extended Latin and italic load only when needed.
export const SITE_FONT_CSS = `/* Instrument Sans · SIL OFL 1.1 · ${basePath}/LICENSE.txt */\n` +
  ["wght.css", "wght-italic.css"].map((filename) =>
    readFileSync(require.resolve(`${packageName}/${filename}`), "utf8")
      .replaceAll("Instrument Sans Variable", "Instrument Sans")
      .replaceAll("./files/", `${basePath}/`),
  ).join("\n");
