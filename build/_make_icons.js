/**
 * Rasterize the icon SVGs in build/ into the PNG + ICO set electron and
 * electron-builder consume.
 *
 *   icon.svg      -> icon.png / icon-512.png / icon-256.png / icon.ico
 *                    the APP identity (exe, installer, shortcut, main window)
 *   icon-pi.svg   -> icon-pi.png  / icon-pi.ico
 *                    the Pi monogram tile
 *
 * Run:  node build/_make_icons.js        (from the repo root)
 */

const path = require("path");
const fs = require("fs");

const BUILD = __dirname;
const REPO = path.join(BUILD, "..");
const sharp = require(path.join(REPO, "runtime-seed", "node_modules", "sharp"));

/** Sizes Explorer, the taskbar and the installer actually ask for. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Assemble a PNG-compressed .ico.
 *
 * Layout: a 6-byte ICONDIR, then one 16-byte ICONDIRENTRY per image, then the
 * image payloads. Width/height bytes are 0 for 256 (the field is one byte and
 * 256 does not fit — 0 is the documented escape).
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/** Rasterize one square PNG from an SVG buffer. */
function png(svg, size) {
  // density: rasterize the vector at a high internal resolution before the
  // resize, or the 1024px render is blurry at the edges of the rounded tile.
  return sharp(svg, { density: 512 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function render(stem, { extraPngs = [] } = {}) {
  const svg = fs.readFileSync(path.join(BUILD, `${stem}.svg`));

  fs.writeFileSync(path.join(BUILD, `${stem}.png`), await png(svg, 1024));
  console.log(`PNG   ${stem}.png (1024)`);
  for (const size of extraPngs) {
    fs.writeFileSync(path.join(BUILD, `${stem}-${size}.png`), await png(svg, size));
    console.log(`PNG   ${stem}-${size}.png`);
  }

  const images = [];
  for (const size of ICO_SIZES) images.push({ size, data: await png(svg, size) });
  fs.writeFileSync(path.join(BUILD, `${stem}.ico`), buildIco(images));
  console.log(`ICO   ${stem}.ico (${ICO_SIZES.join(", ")})`);
}

(async () => {
  await render("icon", { extraPngs: [512, 256] });
  await render("icon-pi");
})().catch((e) => {
  console.error("ICON BUILD FAILED:", (e && e.stack) || e);
  process.exit(3);
});
