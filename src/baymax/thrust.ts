/**
 * Pure flight-state to thruster mapping for the Baymax hero. No rendering imports.
 *
 * Convention: Baymax faces local -Z (three.js forward), up is +Y, right is +X.
 * `lean.pitch > 0` leans the body forward (head toward -Z); `lean.roll > 0` banks right (right side down).
 * Orientation quaternions are [x, y, z, w].
 */
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
export type SocketId = 'pack-left' | 'pack-right' | 'foot-left' | 'foot-right';
export const SOCKET_IDS: readonly SocketId[] = ['pack-left', 'pack-right', 'foot-left', 'foot-right'];

export interface FlightState {
  /** World velocity, m/s. */
  readonly velocity: Vec3;
  /** World acceleration, m/s^2. */
  readonly acceleration: Vec3;
  /** Yaw rate about world +Y, rad/s (positive = turning left / counter-clockwise from above). */
  readonly yawRate: number;
  readonly boost: boolean;
}

export interface ThrustOutput {
  readonly sockets: Record<SocketId, number>;
  readonly lean: { readonly pitch: number; readonly roll: number };
  /** Vertical body offset in metres. */
  readonly hoverBob: number;
  /** 0..1 boost level (instantaneous in computeThrust, eased in FlightDynamics). */
  readonly boost: number;
}

export const THRUST_TUNING = {
  hoverPack: 0.3,
  hoverFoot: 0.2,
  maxPitch: 0.38,
  maxRoll: 0.4,
  bobAmplitude: 0.025,
  bobHz: 0.45,
} as const;

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Rotate a world vector into the body frame (inverse of the orientation quaternion). */
export function worldToLocal(v: Vec3, q: Quat): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  const x = -qx / n, y = -qy / n, z = -qz / n, w = qw / n; // conjugate of unit quaternion
  // t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/** Deterministic seeded flicker in about [1-amp, 1+amp]; a function of time only. */
export function flicker(time: number, seed: number, amp = 0.06): number {
  const s = seed * 12.9898;
  return 1 + amp * (0.6 * Math.sin(time * 41 + s) + 0.4 * Math.sin(time * 67.3 + s * 1.7));
}

/** Pure target mapping. `time` (seconds) drives only the hover bob. */
export function computeThrust(state: FlightState, orientation: Quat = IDENTITY_QUAT, time = 0): ThrustOutput {
  const T = THRUST_TUNING;
  const a = worldToLocal(state.acceleration, orientation);
  const v = worldToLocal(state.velocity, orientation);
  const fwdAcc = -a[2]; // forward is -Z
  const sideAcc = a[0];
  const climb = clamp((state.acceleration[1] + 0.5 * state.velocity[1]) / 4, -1, 1);
  const speed = Math.hypot(state.velocity[0], state.velocity[1], state.velocity[2]);
  const fwdSpeed = -v[2];
  const boost = state.boost ? 1 : 0;

  const fwd = clamp(fwdAcc / 6, 0, 1);
  const brake = clamp(-fwdAcc / 6, 0, 1);
  const turn = clamp(state.yawRate / 1.5, -1, 1);

  const packBase = T.hoverPack + 0.6 * fwd + 0.15 * clamp(speed / 20, 0, 1) + 0.45 * boost - 0.12 * brake - 0.1 * Math.max(-climb, 0);
  const footBase = T.hoverFoot + 0.7 * Math.max(climb, 0) + 0.85 * brake - 0.7 * T.hoverFoot * Math.max(-climb, 0) + 0.15 * boost;
  // Turning left (yawRate > 0) drives the right pack harder, and vice versa.
  const diff = 0.38 * turn;
  const sideDiff = 0.1 * clamp(sideAcc / 6, -1, 1);
  const lateralFoot = 0.2 * clamp(sideAcc / 6, -1, 1);

  const sockets: Record<SocketId, number> = {
    'pack-left': clamp(packBase - diff - sideDiff, 0, 1),
    'pack-right': clamp(packBase + diff + sideDiff, 0, 1),
    'foot-left': clamp(footBase - lateralFoot, 0, 1),
    'foot-right': clamp(footBase + lateralFoot, 0, 1),
  };

  const pitch = clamp(fwdAcc / 9, -1, 1) * T.maxPitch + clamp(fwdSpeed / 25, -1, 1) * 0.14;
  const roll = (-turn * 0.32 + clamp(sideAcc / 8, -1, 1) * 0.2) * (T.maxRoll / 0.4);
  const bobFactor = 1 - clamp(speed / 6, 0, 1);
  const hoverBob = T.bobAmplitude * bobFactor * Math.sin(2 * Math.PI * T.bobHz * time);

  return { sockets, lean: { pitch: clamp(pitch, -T.maxPitch, T.maxPitch), roll: clamp(roll, -T.maxRoll, T.maxRoll) }, hoverBob, boost };
}

/** Critically damped spring step (SmoothDamp form). Returns [value, velocity]. Stable for any dt. */
export function smoothDamp(current: number, velocity: number, target: number, omega: number, dt: number): [number, number] {
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  return [target + (change + temp) * e, (velocity - omega * temp) * e];
}

const CHANNELS = ['pack-left', 'pack-right', 'foot-left', 'foot-right', 'pitch', 'roll', 'bob', 'boost'] as const;
type Channel = (typeof CHANNELS)[number];

const zeroChannels = (): Record<Channel, number> => ({ 'pack-left': 0, 'pack-right': 0, 'foot-left': 0, 'foot-right': 0, pitch: 0, roll: 0, bob: 0, boost: 0 });

/** Stateful, deterministic smoothing of {@link computeThrust} with critically damped springs. */
export class FlightDynamics {
  private readonly value = zeroChannels();
  private readonly vel = zeroChannels();
  private time = 0;
  private readonly out = {
    sockets: { 'pack-left': 0, 'pack-right': 0, 'foot-left': 0, 'foot-right': 0 } as Record<SocketId, number>,
    lean: { pitch: 0, roll: 0 },
    hoverBob: 0,
    boost: 0,
  };

  get elapsed(): number { return this.time; }

  reset(): void {
    for (const c of CHANNELS) { this.value[c] = 0; this.vel[c] = 0; }
    this.time = 0;
  }

  /** Advance by dt seconds toward the target for `state`. Returns a reused output object (do not retain). */
  step(dt: number, state: FlightState, orientation: Quat = IDENTITY_QUAT): ThrustOutput {
    const d = clamp(dt, 0, 0.1);
    this.time += d;
    const t = computeThrust(state, orientation, this.time);
    const targets: Record<Channel, number> = {
      'pack-left': t.sockets['pack-left'], 'pack-right': t.sockets['pack-right'], 'foot-left': t.sockets['foot-left'], 'foot-right': t.sockets['foot-right'],
      pitch: t.lean.pitch, roll: t.lean.roll, bob: t.hoverBob, boost: t.boost,
    };
    for (const c of CHANNELS) {
      // Boost: fast attack, slow decay. Thrusters: moderately quick. Lean: softer. Bob follows its sine closely.
      const omega = c === 'boost' ? (targets.boost > this.value.boost ? 16 : 3.5) : c === 'pitch' || c === 'roll' ? 6 : c === 'bob' ? 40 : 11;
      const [nv, vv] = smoothDamp(this.value[c], this.vel[c], targets[c], omega, d);
      this.value[c] = nv;
      this.vel[c] = vv;
    }
    const o = this.out;
    for (const id of SOCKET_IDS) o.sockets[id] = clamp(this.value[id], 0, 1);
    o.lean.pitch = this.value.pitch;
    o.lean.roll = this.value.roll;
    o.hoverBob = this.value.bob;
    o.boost = clamp(this.value.boost, 0, 1);
    return o;
  }
}
