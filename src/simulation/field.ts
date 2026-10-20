import { DEFAULT_WAVE_COUNT, SAFE_PARAMETER_RANGES } from './constants';
import { createSeededRandom, seedToUint32 } from './seededRandom';
import type { FieldEvaluation, FieldParameters, Vec3, WaveComponent } from './types';

const TAU = Math.PI * 2;
const MAX_ABSOLUTE_INPUT = 1_000_000;

function assertFiniteInput(position: Vec3, time: number): void {
  if (!position.every(Number.isFinite) || !Number.isFinite(time)) {
    throw new RangeError('Field position and simulation time must be finite numbers.');
  }
  if (position.some((coordinate) => Math.abs(coordinate) > MAX_ABSOLUTE_INPUT)
    || Math.abs(time) > MAX_ABSOLUTE_INPUT) {
    throw new RangeError(`Field coordinates and time must remain within ±${MAX_ABSOLUTE_INPUT}.`);
  }
}

export function assertValidFieldParameters(parameters: FieldParameters): void {
  const [minCount, maxCount] = SAFE_PARAMETER_RANGES.waveCount;
  const [minCoupling, maxCoupling] = SAFE_PARAMETER_RANGES.interactionStrength;

  if (!Number.isSafeInteger(parameters.seed)) {
    throw new RangeError('Field seed must be a safe integer.');
  }
  if (!Number.isFinite(parameters.interactionStrength)
    || parameters.interactionStrength < minCoupling
    || parameters.interactionStrength > maxCoupling) {
    throw new RangeError(`Interaction strength must be in [${minCoupling}, ${maxCoupling}].`);
  }
  if (parameters.waves.length < minCount || parameters.waves.length > maxCount) {
    throw new RangeError(`Wave count must be in [${minCount}, ${maxCount}].`);
  }

  for (const [index, wave] of parameters.waves.entries()) {
    const [minAmplitude, maxAmplitude] = SAFE_PARAMETER_RANGES.amplitude;
    const [minWavenumber, maxWavenumber] = SAFE_PARAMETER_RANGES.waveNumberMagnitude;
    const [minFrequency, maxFrequency] = SAFE_PARAMETER_RANGES.angularFrequency;
    const magnitude = Math.hypot(...wave.waveVector);

    if (!Number.isFinite(wave.amplitude) || wave.amplitude < minAmplitude || wave.amplitude > maxAmplitude) {
      throw new RangeError(`Wave ${index} amplitude must be in [${minAmplitude}, ${maxAmplitude}].`);
    }
    if (!wave.waveVector.every(Number.isFinite) || magnitude < minWavenumber || magnitude > maxWavenumber) {
      throw new RangeError(`Wave ${index} wave-number magnitude must be in [${minWavenumber}, ${maxWavenumber}].`);
    }
    if (!Number.isFinite(wave.angularFrequency)
      || wave.angularFrequency < minFrequency
      || wave.angularFrequency > maxFrequency) {
      throw new RangeError(`Wave ${index} angular frequency must be in [${minFrequency}, ${maxFrequency}].`);
    }
    if (!Number.isFinite(wave.phase)) {
      throw new RangeError(`Wave ${index} phase must be finite.`);
    }
  }
}

/** Build four distinct, safely bounded waves from a reproducible seed. */
export function createFieldParameters(seed: number): FieldParameters {
  const normalizedSeed = seedToUint32(seed);
  const random = createSeededRandom(normalizedSeed);
  const waves: WaveComponent[] = [];

  for (let index = 0; index < DEFAULT_WAVE_COUNT; index += 1) {
    const z = random() * 2 - 1;
    const azimuth = random() * TAU;
    const horizontal = Math.sqrt(1 - z * z);
    const magnitude = 0.28 + random() * 0.19;

    waves.push({
      amplitude: 0.12 + random() * 0.08,
      waveVector: [
        magnitude * horizontal * Math.cos(azimuth),
        magnitude * z,
        magnitude * horizontal * Math.sin(azimuth),
      ],
      angularFrequency: 0.32 + random() * 0.32,
      phase: random() * TAU,
    });
  }

  const parameters: FieldParameters = {
    seed: normalizedSeed,
    interactionStrength: 0.24 + random() * 0.08,
    waves,
  };
  assertValidFieldParameters(parameters);
  return parameters;
}

/** Evaluate Φ, its analytical gradient, and analytical Hessian at q and t. */
export function evaluateField(
  position: Vec3,
  time: number,
  parameters: FieldParameters,
): FieldEvaluation {
  assertFiniteInput(position, time);
  assertValidFieldParameters(parameters);

  const sine = new Float64Array(parameters.waves.length);
  const cosine = new Float64Array(parameters.waves.length);
  let value = 0;
  const gradient = new Float64Array(3);
  const hessian = new Float64Array(9);

  for (let index = 0; index < parameters.waves.length; index += 1) {
    const wave = parameters.waves[index]!;
    const [kx, ky, kz] = wave.waveVector;
    const phase = kx * position[0] + ky * position[1] + kz * position[2]
      - wave.angularFrequency * time + wave.phase;

    if (!Number.isFinite(phase)) {
      throw new RangeError('Field phase overflowed; check coordinates and time.');
    }

    sine[index] = Math.sin(phase);
    cosine[index] = Math.cos(phase);
    value += wave.amplitude * sine[index]!;

    for (let row = 0; row < 3; row += 1) {
      gradient[row] = gradient[row]! + wave.amplitude * cosine[index]! * wave.waveVector[row]!;
      for (let column = 0; column < 3; column += 1) {
        const entry = row * 3 + column;
        hessian[entry] = hessian[entry]! - wave.amplitude * sine[index]!
          * wave.waveVector[row]! * wave.waveVector[column]!;
      }
    }
  }

  const coupling = parameters.interactionStrength;
  for (let left = 0; left < parameters.waves.length; left += 1) {
    const leftWave = parameters.waves[left]!;
    for (let right = left + 1; right < parameters.waves.length; right += 1) {
      const rightWave = parameters.waves[right]!;
      const leftSine = sine[left]!;
      const leftCosine = cosine[left]!;
      const rightSine = sine[right]!;
      const rightCosine = cosine[right]!;
      const weight = coupling * leftWave.amplitude * rightWave.amplitude;

      value += weight * leftSine * rightSine;

      for (let row = 0; row < 3; row += 1) {
        gradient[row] = gradient[row]! + weight * (
          leftCosine * rightSine * leftWave.waveVector[row]!
          + leftSine * rightCosine * rightWave.waveVector[row]!
        );

        for (let column = 0; column < 3; column += 1) {
          const entry = row * 3 + column;
          hessian[entry] = hessian[entry]! + weight * (
            -leftSine * rightSine * (
              leftWave.waveVector[row]! * leftWave.waveVector[column]!
              + rightWave.waveVector[row]! * rightWave.waveVector[column]!
            )
            + leftCosine * rightCosine * (
              leftWave.waveVector[row]! * rightWave.waveVector[column]!
              + rightWave.waveVector[row]! * leftWave.waveVector[column]!
            )
          );
        }
      }
    }
  }

  if (!Number.isFinite(value) || !gradient.every(Number.isFinite) || !hessian.every(Number.isFinite)) {
    throw new RangeError('Field evaluation produced a non-finite result.');
  }

  return {
    value,
    gradient: [gradient[0]!, gradient[1]!, gradient[2]!],
    hessian: [
      hessian[0]!, hessian[1]!, hessian[2]!,
      hessian[3]!, hessian[4]!, hessian[5]!,
      hessian[6]!, hessian[7]!, hessian[8]!,
    ],
  };
}
