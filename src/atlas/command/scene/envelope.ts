/** Geometry of an uncertainty envelope: a tube along a path whose radius at each sample is the estimator's OWN stated uncertainty at that time
 * (`positionAt(...).uncertainty`). Nothing is invented: if the model says ±1.4 m at the sample, the tube is 1.4 m in radius there. Pure and tested. */
export type P3 = readonly [number, number, number];

export interface EnvelopeMesh { readonly positions: Float32Array; readonly indices: Uint16Array; readonly rings: number; readonly sides: number }

/** Rings are placed at the path samples; frames are parallel-transported so the tube does not twist. */
export function buildEnvelope(points: readonly P3[], radii: readonly number[], sides = 10, out?: { positions: Float32Array; indices: Uint16Array }, count?: number): EnvelopeMesh {
  const n = count ?? points.length;
  const positions = out?.positions ?? new Float32Array(n * sides * 3);
  const indices = out?.indices ?? new Uint16Array(Math.max(0, n - 1) * sides * 6);
  let nx = 0, ny = 1, nz = 0;
  let first = true;
  for (let i = 0; i < n; i += 1) {
    const a = points[Math.max(0, i - 1)]!, b = points[Math.min(n - 1, i + 1)]!;
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    if (first) { // any vector not parallel to the tangent
        if (Math.abs(ty) < 0.9) { nx = 0; ny = 1; nz = 0; } else { nx = 1; ny = 0; nz = 0; }
        first = false;
    }
    // Project the previous normal onto the plane orthogonal to the new tangent.
    const dot = nx * tx + ny * ty + nz * tz;
    nx -= dot * tx; ny -= dot * ty; nz -= dot * tz;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const r = Math.max(0, radii[i] ?? 0), p = points[i]!;
    for (let s = 0; s < sides; s += 1) {
      const ang = (s / sides) * Math.PI * 2, c = Math.cos(ang) * r, sn = Math.sin(ang) * r;
      const k = (i * sides + s) * 3;
      positions[k] = p[0] + nx * c + bx * sn; positions[k + 1] = p[1] + ny * c + by * sn; positions[k + 2] = p[2] + nz * c + bz * sn;
    }
  }
  for (let i = 0; i < n - 1; i += 1) for (let s = 0; s < sides; s += 1) {
    const a = i * sides + s, b = i * sides + ((s + 1) % sides), c = (i + 1) * sides + s, d = (i + 1) * sides + ((s + 1) % sides);
    const k = (i * sides + s) * 6;
    indices[k] = a; indices[k + 1] = c; indices[k + 2] = b; indices[k + 3] = b; indices[k + 4] = c; indices[k + 5] = d;
  }
  return { positions, indices, rings: n, sides };
}
