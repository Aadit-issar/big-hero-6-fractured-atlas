/** Rendering-only load tracker (terrain meshes, textures, sky bake).
 * It never gates or alters simulation time; it only drives the loading veil
 * and lets screenshot tooling wait for fully loaded assets. */
export interface RenderReadiness {
  readonly terrainReady: number;
  readonly terrainTotal: number;
  readonly texturesReady: boolean;
  readonly textureFallback: boolean;
  readonly skyReady: boolean;
  readonly terrainMilliseconds: number;
  readonly skyMilliseconds: number;
  readonly gasReady: boolean;
}

let state: RenderReadiness = { terrainReady: 0, terrainTotal: 0, texturesReady: false, textureFallback: false, skyReady: false, terrainMilliseconds: 0, skyMilliseconds: 0, gasReady: false };
const listeners = new Set<() => void>();

export function readReadiness(): RenderReadiness { return state; }
export function isRenderReady(s: RenderReadiness = state): boolean {
  return s.skyReady && s.texturesReady && s.gasReady && s.terrainTotal > 0 && s.terrainReady >= s.terrainTotal;
}
export function updateReadiness(patch: Partial<RenderReadiness>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
export function subscribeReadiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
