// Writes the icon files in public/ from the mark in src/core/brand.ts. Run it after changing the mark:
//   npm run icons
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { tileSvg } from "../src/core/brand.ts";

const PUBLIC = join(import.meta.dirname, "..", "public");

function png(svg: string, size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: (72 * size) / 32 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

/** An .ico file that holds PNG images, which every current browser reads. */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size, at);
    header.writeUInt8(size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

const tile = tileSvg();
writeFileSync(join(PUBLIC, "favicon.svg"), tile + "\n");
writeFileSync(join(PUBLIC, "favicon.ico"), ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(tile, size) })))));
writeFileSync(join(PUBLIC, "apple-touch-icon.png"), await png(tileSvg(0), 180));
console.log("wrote favicon.svg, favicon.ico and apple-touch-icon.png to public/");
