// Rasterize the Rojin chat-bubble icon (SVG) to the PNG sizes the PWA needs.
// Run from client/:  node scripts/build-icons.mjs
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.join(dir, '..', 'public', 'icons');
const svg = readFileSync(path.join(iconsDir, 'icon.svg'));

const sizes = {
  'icon-192.png': 192,
  'icon-512.png': 512,
  'apple-touch-icon.png': 180,
};

for (const [name, size] of Object.entries(sizes)) {
  await sharp(svg, { density: 512 }).resize(size, size).png().toFile(path.join(iconsDir, name));
  console.log('wrote', name);
}
