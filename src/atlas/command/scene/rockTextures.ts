import { DataTexture, NoColorSpace, RepeatWrapping, RGBAFormat, SRGBColorSpace, TextureLoader } from 'three';
import type { Texture, WebGLRenderer } from 'three';
import type { RockTextureSet } from '../../../scene/terrain/rockMaterial';

/** The Dimension's three CC0 rock sets (docs/ASSET_PROVENANCE.md), loaded for ATLAS. The Dimension's own loader resolves them against the site root;
 * the ATLAS lab serves a different public folder, so the files are referenced relative to this module and bundled by Vite. Same images, same colour
 * spaces (colour maps sRGB; normal and ARM maps linear), same `RockTextureSet` shape, so `createRockMaterial` is used unchanged. */
const SETS = {
  cliff: { albedo: new URL('../../../../public/assets/textures/cliff_side/cliff_side_diff_2k.jpg', import.meta.url).href, normal: new URL('../../../../public/assets/textures/cliff_side/cliff_side_nor_gl_2k.jpg', import.meta.url).href, arm: new URL('../../../../public/assets/textures/cliff_side/cliff_side_arm_2k.jpg', import.meta.url).href },
  top: { albedo: new URL('../../../../public/assets/textures/rocks_ground_06/rocks_ground_06_diff_1k.jpg', import.meta.url).href, normal: new URL('../../../../public/assets/textures/rocks_ground_06/rocks_ground_06_nor_gl_1k.jpg', import.meta.url).href, arm: new URL('../../../../public/assets/textures/rocks_ground_06/rocks_ground_06_arm_1k.jpg', import.meta.url).href },
  base: { albedo: new URL('../../../../public/assets/textures/lichen_rock/lichen_rock_diff_1k.jpg', import.meta.url).href, normal: new URL('../../../../public/assets/textures/lichen_rock/lichen_rock_nor_gl_1k.jpg', import.meta.url).href, arm: new URL('../../../../public/assets/textures/lichen_rock/lichen_rock_arm_1k.jpg', import.meta.url).href },
} as const;
type LayerName = keyof typeof SETS;
type MapName = 'albedo' | 'normal' | 'arm';

function flat(rgba: [number, number, number, number], srgb: boolean): DataTexture {
  const t = new DataTexture(new Uint8Array(rgba), 1, 1, RGBAFormat);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace; t.wrapS = t.wrapT = RepeatWrapping; t.needsUpdate = true;
  return t;
}

export function loadAtlasRockTextures(renderer: WebGLRenderer, anisotropy: number): RockTextureSet {
  const loader = new TextureLoader();
  const maps = {} as Record<LayerName, Record<MapName, Texture>>;
  const all: Texture[] = [];
  let remaining = 0, failed = false;
  let done: (v: { failed: boolean }) => void = () => undefined;
  const ready = new Promise<{ failed: boolean }>(resolve => { done = resolve; });
  const settle = () => { remaining -= 1; if (remaining === 0) done({ failed }); };
  const aniso = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  for (const layer of Object.keys(SETS) as LayerName[]) {
    maps[layer] = {} as Record<MapName, Texture>;
    for (const map of ['albedo', 'normal', 'arm'] as const) {
      const fallback = map === 'albedo' ? flat([118, 118, 122, 255], true) : map === 'normal' ? flat([128, 128, 255, 255], false) : flat([255, 220, 0, 255], false);
      remaining += 1;
      const texture = loader.load(SETS[layer][map], () => settle(), undefined, () => { failed = true; texture.image = fallback.image as unknown as HTMLImageElement; texture.needsUpdate = true; settle(); });
      texture.colorSpace = map === 'albedo' ? SRGBColorSpace : NoColorSpace;
      texture.wrapS = texture.wrapT = RepeatWrapping; texture.anisotropy = aniso;
      maps[layer][map] = texture; all.push(texture, fallback);
    }
  }
  return { maps, ready, dispose: () => all.forEach(t => t.dispose()) };
}
