import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/elevation', () => ({
  getTerrainElevation: vi.fn(async () => 0),
}));

import {
  precisionPixelToGeo,
  type PrecisionGeoreferenceParams,
} from '@/lib/utils/precision-georeferencing';

type ReferenceInput = {
  px: number;
  py: number;
  f: number;
  cx: number;
  cy: number;
  pitchDeg: number;
  yawDeg: number;
  rollDeg: number;
  heightM: number;
  lat0: number;
  lon0: number;
};

type ReferenceResult = {
  lat: number;
  lon: number;
  offsetEastM: number;
  offsetNorthM: number;
};

/**
 * Normative reference implementation for the future projection core.
 *
 * Keep this standalone and literal: it intentionally does not import any
 * production projection helpers, so PR 2 can be checked against a fixed
 * independent statement of the pixel/camera/ENU conventions.
 */
function referenceProject(input: ReferenceInput): ReferenceResult {
  const radians = Math.PI / 180;
  const pitch = input.pitchDeg * radians;
  const yaw = input.yawDeg * radians;
  const roll = input.rollDeg * radians;

  // 1. Pixel -> camera ray. These normalized coordinates are already tangents.
  const vx = (input.px - input.cx) / input.f;
  const vy = (input.py - input.cy) / input.f;
  const vz = 1;

  // 2. Roll about the boresight.
  const xPrime = vx * Math.cos(roll) - vy * Math.sin(roll);
  const yPrime = vx * Math.sin(roll) + vy * Math.cos(roll);
  const zPrime = vz;

  // 3. Camera -> ENU for a north-facing level camera.
  const east0 = xPrime;
  const north0 = zPrime;
  const up0 = -yPrime;

  // 4. Pitch about the east axis.
  const north1 = north0 * Math.cos(pitch) - up0 * Math.sin(pitch);
  const up1 = north0 * Math.sin(pitch) + up0 * Math.cos(pitch);
  const east1 = east0;

  // 5. DJI compass yaw is clockwise-positive from north.
  const east = north1 * Math.sin(yaw) + east1 * Math.cos(yaw);
  const north = north1 * Math.cos(yaw) - east1 * Math.sin(yaw);
  const up = up1;
  const rayLength = Math.hypot(east, north, up);

  if (up >= -0.05 * rayLength) {
    throw new Error('NEAR_HORIZON');
  }

  // 6. Ground-plane intersection.
  const t = input.heightM / -up;
  const offsetEastM = t * east;
  const offsetNorthM = t * north;

  // 7. Small-offset geographic conversion.
  const lat = input.lat0 + offsetNorthM / 111111;
  const lon =
    input.lon0 + offsetEastM / (111111 * Math.cos(input.lat0 * radians));

  return { lat, lon, offsetEastM, offsetNorthM };
}

const goldenFixtures = [
  { id: 'A', pitchDeg: -90, yawDeg: 0, px: 1000, py: 750, east: 0, north: 0 },
  { id: 'B', pitchDeg: -90, yawDeg: 0, px: 1100, py: 750, east: 10, north: 0 },
  { id: 'C', pitchDeg: -90, yawDeg: 90, px: 1100, py: 750, east: 0, north: -10 },
  { id: 'D', pitchDeg: -90, yawDeg: 0, px: 1000, py: 850, east: 0, north: -10 },
  { id: 'E', pitchDeg: -90, yawDeg: 180, px: 1100, py: 750, east: -10, north: 0 },
  { id: 'F', pitchDeg: -45, yawDeg: 0, px: 1000, py: 750, east: 0, north: 100 },
  { id: 'G', pitchDeg: -45, yawDeg: 0, px: 1000, py: 850, east: 0, north: 81.8182 },
  { id: 'H', pitchDeg: -45, yawDeg: 270, px: 1000, py: 750, east: -100, north: 0 },
] as const;

const referenceDefaults = {
  f: 1000,
  cx: 1000,
  cy: 750,
  rollDeg: 0,
  heightM: 100,
  lat0: -26,
  lon0: 153,
};

function expectWithinMillimetre(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.001);
}

describe('future projection-core golden fixtures', () => {
  it.each(goldenFixtures)(
    'fixture $id locks the normative offsets to +/-0.001 m',
    (fixture) => {
      const result = referenceProject({ ...referenceDefaults, ...fixture });

      expectWithinMillimetre(result.offsetEastM, fixture.east);
      expectWithinMillimetre(result.offsetNorthM, fixture.north);
    }
  );
});

const currentLrfParams: PrecisionGeoreferenceParams = {
  imageWidth: 2000,
  imageHeight: 1500,
  calibratedFocalLength: 1000,
  opticalCenterX: 1000,
  opticalCenterY: 750,
  droneLatitude: -26,
  droneLongitude: 153,
  droneAltitude: 30,
  gimbalPitch: -90,
  gimbalRoll: 0,
  gimbalYaw: 0,
  lrfTargetDistance: 100,
  lrfTargetLatitude: -26,
  lrfTargetLongitude: 153,
  lrfTargetAltitude: 0,
};

function offsetsFromLrf(latitude: number, longitude: number): { east: number; north: number } {
  return {
    east:
      (longitude - currentLrfParams.lrfTargetLongitude!) *
      111111 *
      Math.cos((currentLrfParams.lrfTargetLatitude! * Math.PI) / 180),
    north:
      (latitude - currentLrfParams.lrfTargetLatitude!) * 111111,
  };
}

describe('current precision path known deviations (PR 1 characterization)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('documents bug 1: normalized camera coordinates receive a second tan()', async () => {
    const current = await precisionPixelToGeo(
      { x: 1100, y: 750 },
      currentLrfParams
    );

    expect(current).not.toBeNull();
    const offset = offsetsFromLrf(current!.latitude, current!.longitude);
    expect(offset.east).toBeCloseTo(100 * Math.tan(0.1), 3);
    expect(Math.abs(offset.east - 10)).toBeGreaterThan(0.03);
  });

  it('documents bug 2: vertical height is added to the LRF slant range', async () => {
    const current = await precisionPixelToGeo(
      { x: 1100, y: 750 },
      { ...currentLrfParams, droneAltitude: 130 }
    );

    expect(current).not.toBeNull();
    const offset = offsetsFromLrf(current!.latitude, current!.longitude);
    expect(offset.east).toBeCloseTo(Math.SQRT2 * 100 * Math.tan(0.1), 3);
    expect(offset.east).toBeGreaterThan(14);
  });

  it('documents bug 3: DJI yaw=90 rotates image-right north instead of south', async () => {
    const current = await precisionPixelToGeo(
      { x: 1100, y: 750 },
      { ...currentLrfParams, gimbalYaw: 90 }
    );

    expect(current).not.toBeNull();
    const offset = offsetsFromLrf(current!.latitude, current!.longitude);
    expect(offset.north).toBeGreaterThan(10);
    expect(offset.north).not.toBeCloseTo(-10, 3);
  });
});
