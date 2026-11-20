/**
 * Builds the Android launcher icons for the Capacitor shell from the one
 * source of truth — public/icon.svg (the PR #172 brand master):
 *   • legacy ic_launcher.png (the full art: olive rounded tile + funnel)
 *   • round ic_launcher_round.png (same art, circular mask)
 *   • adaptive ic_launcher_foreground.png (the mark only — funnel, flow
 *     line, orange drop — on transparent; the background colour #978C21
 *     lives in android/app/src/main/res/values/ic_launcher_background.xml)
 *
 * The PNGs are GENERATED, never committed: they are binaries, and the
 * GitHub connector pushes text only. CI runs this script before every
 * build (`npm run android:assets`); local builds run it once after
 * checkout. The adaptive-icon XMLs in mipmap-anydpi-v26/ are text and
 * ARE committed.
 *
 * The mark IS rescaled for the adaptive foreground: as drawn, the
 * funnel's top corners sit at r≈187 from the centre and the orange
 * drop's bottom edge at r≈170 — both outside the 66dp adaptive safe
 * zone (r=156 on a 512 canvas), so an aggressive mask (teardrop) would
 * clip them. Scaling the mark to 80% about the centre pulls the
 * corners to r≈149 and the drop to r≈136, inside the safe zone on
 * every mask shape; the mark then spans ~50% of the layer, the same
 * proportion as the Agent Hub's mark. The legacy and round icons use
 * the full art unscaled.
 *
 * The script fails loudly if the source SVG no longer has the expected
 * shape (olive rounded tile + cream funnel + orange drop) — e.g. when
 * the icon is redesigned, this script must be updated deliberately,
 * not silently produce a wrong icon.
 *
 * Usage: npm run android:assets
 */
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const SRC = path.join(root, 'public/icon.svg');
const RES = path.join(root, 'android/app/src/main/res');

const DENSITIES = [
  ['mipmap-mdpi', 48, 108],
  ['mipmap-hdpi', 72, 162],
  ['mipmap-xhdpi', 96, 216],
  ['mipmap-xxhdpi', 144, 324],
  ['mipmap-xxxhdpi', 192, 432],
];

const source = fs.readFileSync(SRC, 'utf8');
// The source must be the known shape: an olive rounded tile, then the
// cream funnel, the olive flow line and the orange drop. Anything else
// means the icon was redesigned — stop, do not guess.
if (!/<rect width="512" height="512" rx="112" fill="#978C21"\/>/.test(source)) {
  throw new Error(
    `android-assets: ${SRC} no longer starts with the olive rounded tile — the icon was redesigned; update this script.`,
  );
}
if (!source.includes('fill="#F7F2E9"') || !source.includes('fill="#F37021"')) {
  throw new Error(
    'android-assets: the funnel (cream) or the drop (orange) is missing from the source SVG — update this script.',
  );
}
const inner = source
  .replace(/^<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<title>[\s\S]*?<\/title>/, '')
  .trim();
const markOnly = inner.replace(/<rect width="512" height="512" rx="112" fill="#978C21"\/>\s*/, '');
if (!markOnly.includes('<path') || !markOnly.includes('<circle')) {
  throw new Error('android-assets: the funnel mark is missing from the source SVG — update this script.');
}

const wrap = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${body}</svg>`;

const render = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();

const write = (file, buf) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
};

// Adaptive foreground: the mark only, scaled to 80% about the centre
// (see the header note — pulls the funnel corners and the drop inside
// the 66dp safe zone on every mask shape).
const foregroundSvg = wrap(
  `<g transform="translate(256 256) scale(0.8) translate(-256 -256)">${markOnly}</g>`,
);

// Round icon: the full art clipped to a circle.
const roundSvg = wrap(
  `<defs><clipPath id="round"><circle cx="256" cy="256" r="256"/></clipPath></defs><g clip-path="url(#round)">${inner}</g>`,
);

const legacySvg = wrap(inner);

for (const [density, legacySize, foregroundSize] of DENSITIES) {
  write(path.join(RES, density, 'ic_launcher.png'), render(legacySvg, legacySize));
  write(path.join(RES, density, 'ic_launcher_round.png'), render(roundSvg, legacySize));
  write(path.join(RES, density, 'ic_launcher_foreground.png'), render(foregroundSvg, foregroundSize));
}

console.log(`android-assets: wrote 15 launcher PNGs from ${SRC}`);
