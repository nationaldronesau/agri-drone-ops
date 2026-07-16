import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/elevation', () => ({
  getTerrainElevation: vi.fn(async () => 0),
}));

import {
  extractPrecisionParams,
  precisionPixelToGeo,
  type PrecisionGeoreferenceParams,
} from '@/lib/utils/precision-georeferencing';
import { projectPixelToGeo } from '@/lib/utils/projection-core';
import { getTerrainElevation } from '@/lib/services/elevation';
import {
  computeExportProjectionGeo,
  pixelToGeoWithDSM,
  resolveGeoCoordinates,
  type GeoAssetParams,
} from '@/lib/utils/georeferencing';

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

beforeEach(() => {
  vi.mocked(getTerrainElevation).mockReset();
  vi.mocked(getTerrainElevation).mockResolvedValue(0);
});

describe('projection-core golden fixtures', () => {
  it.each(goldenFixtures)(
    'fixture $id matches the independent reference and golden offsets to +/-0.001 m',
    async (fixture) => {
      const reference = referenceProject({ ...referenceDefaults, ...fixture });
      const production = await projectPixelToGeo({
        pixel: { x: fixture.px, y: fixture.py },
        imageWidth: 2000,
        imageHeight: 1500,
        intrinsics: {
          f: referenceDefaults.f,
          cx: referenceDefaults.cx,
          cy: referenceDefaults.cy,
        },
        gimbalPitchDeg: fixture.pitchDeg,
        gimbalRollDeg: referenceDefaults.rollDeg,
        gimbalYawDeg: fixture.yawDeg,
        droneLat: referenceDefaults.lat0,
        droneLon: referenceDefaults.lon0,
        heightAboveGroundM: referenceDefaults.heightM,
      });

      expect(production).not.toBeNull();
      const productionEast =
        (production!.lon - referenceDefaults.lon0) *
        111111 *
        Math.cos((referenceDefaults.lat0 * Math.PI) / 180);
      const productionNorth = (production!.lat - referenceDefaults.lat0) * 111111;

      expectWithinMillimetre(reference.offsetEastM, fixture.east);
      expectWithinMillimetre(reference.offsetNorthM, fixture.north);
      expectWithinMillimetre(productionEast, fixture.east);
      expectWithinMillimetre(productionNorth, fixture.north);
      expectWithinMillimetre(productionEast, reference.offsetEastM);
      expectWithinMillimetre(productionNorth, reference.offsetNorthM);
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

describe('projection math bug fixes', () => {
  it('fix 1: edge offset uses normalized tangent exactly once', async () => {
    const current = await precisionPixelToGeo(
      { x: 1100, y: 750 },
      currentLrfParams
    );

    expect(current).not.toBeNull();
    const offset = offsetsFromLrf(current!.latitude, current!.longitude);
    expect(offset.east).toBeCloseTo(10, 3);
    expect(offset.north).toBeCloseTo(0, 3);
  });

  it('fix 2: LRF slant range has no square-root-of-two inflation', async () => {
    const current = await precisionPixelToGeo(
      { x: 1100, y: 750 },
      { ...currentLrfParams, droneAltitude: 130 }
    );

    expect(current).not.toBeNull();
    const offset = offsetsFromLrf(current!.latitude, current!.longitude);
    expect(offset.east).toBeCloseTo(10, 3);
    expect(offset.east).toBeLessThan(11);
  });

  it('fix 3: DJI yaw=90 sends image-right south', async () => {
    const current = await precisionPixelToGeo(
      { x: 1100, y: 750 },
      { ...currentLrfParams, gimbalYaw: 90 }
    );

    expect(current).not.toBeNull();
    const offset = offsetsFromLrf(current!.latitude, current!.longitude);
    expect(offset.east).toBeCloseTo(0, 3);
    expect(offset.north).toBeCloseTo(-10, 3);
  });
});

describe('projection-core production guardrails', () => {
  it('forwards LRF target coordinates through the precision compatibility wrapper', async () => {
    const droneLat = -26;
    const droneLon = 153;
    const targetLon =
      droneLon + 3 / (111111 * Math.cos((droneLat * Math.PI) / 180));
    const result = await precisionPixelToGeo(
      { x: 1000, y: 750 },
      {
        ...currentLrfParams,
        droneLatitude: droneLat,
        droneLongitude: droneLon,
        lrfTargetLatitude: droneLat,
        lrfTargetLongitude: targetLon,
      }
    );

    expect(result).not.toBeNull();
    const eastFromTarget =
      (result!.longitude - targetLon) *
      111111 *
      Math.cos((droneLat * Math.PI) / 180);
    const northFromTarget = (result!.latitude - droneLat) * 111111;
    expectWithinMillimetre(eastFromTarget, 0);
    expectWithinMillimetre(northFromTarget, 0);
    expect(result!.qualityFlags).toContain('lrf_anchored');
  });

  it('anchors LRF pixel offsets at the gated DJI target', async () => {
    const droneLat = -26;
    const droneLon = 153;
    const targetLon =
      droneLon + 3 / (111111 * Math.cos((droneLat * Math.PI) / 180));
    const result = await computeExportProjectionGeo(
      {
        gpsLatitude: droneLat,
        gpsLongitude: droneLon,
        altitude: 100,
        gimbalPitch: -90,
        gimbalRoll: 0,
        gimbalYaw: 90,
        imageWidth: 2000,
        imageHeight: 1500,
        lrfDistance: 100,
        lrfTargetLat: droneLat,
        lrfTargetLon: targetLon,
        metadata: {
          CalibratedFocalLength: 1000,
          CalibratedOpticalCenterX: 1000,
          CalibratedOpticalCenterY: 750,
        },
      },
      { x: 1100, y: 750 }
    );

    expect(result).not.toBeNull();
    const eastFromTarget =
      (result!.lon - targetLon) *
      111111 *
      Math.cos((droneLat * Math.PI) / 180);
    const northFromTarget = (result!.lat - droneLat) * 111111;
    expectWithinMillimetre(eastFromTarget, 0);
    expectWithinMillimetre(northFromTarget, -10);
    expect(result!.method).toBe('lrf');
    expect(result!.qualityFlags).toContain('lrf_anchored');
  });

  it('keeps drone-GPS anchoring when an LRF target is absent', async () => {
    const droneLat = -26;
    const droneLon = 153;
    const result = await computeExportProjectionGeo(
      {
        gpsLatitude: droneLat,
        gpsLongitude: droneLon,
        altitude: 100,
        gimbalPitch: -90,
        gimbalRoll: 0,
        gimbalYaw: 90,
        imageWidth: 2000,
        imageHeight: 1500,
        lrfDistance: 100,
        metadata: {
          CalibratedFocalLength: 1000,
          CalibratedOpticalCenterX: 1000,
          CalibratedOpticalCenterY: 750,
        },
      },
      { x: 1100, y: 750 }
    );

    expect(result).not.toBeNull();
    const eastFromDrone =
      (result!.lon - droneLon) *
      111111 *
      Math.cos((droneLat * Math.PI) / 180);
    const northFromDrone = (result!.lat - droneLat) * 111111;
    expectWithinMillimetre(eastFromDrone, 0);
    expectWithinMillimetre(northFromDrone, -10);
    expect(result!.method).toBe('lrf');
    expect(result!.qualityFlags).not.toContain('lrf_anchored');
  });

  it('uses FOV-derived focal length when calibration metadata is absent', async () => {
    const result = await projectPixelToGeo({
      pixel: { x: 1100, y: 750 },
      imageWidth: 2000,
      imageHeight: 1500,
      fieldOfViewDeg: 90,
      gimbalPitchDeg: -90,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      droneLat: -26,
      droneLon: 153,
      heightAboveGroundM: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.offsetFromCentreM).toBeCloseTo(10, 6);
    expect(result!.qualityFlags).toContain('fov_intrinsics');
  });

  it('does not inject Matrice 4E intrinsics into uncalibrated metadata', () => {
    const params = extractPrecisionParams({
      ExifImageWidth: 2000,
      ExifImageHeight: 1500,
      FieldOfView: 90,
    });

    expect(params.calibratedFocalLength).toBeUndefined();
    expect(params.opticalCenterX).toBeUndefined();
    expect(params.opticalCenterY).toBeUndefined();
    expect(params.fieldOfView).toBe(90);
  });

  it('records an explicit quality flag when the altitude defaults', async () => {
    const result = await projectPixelToGeo({
      pixel: { x: 1000, y: 750 },
      imageWidth: 2000,
      imageHeight: 1500,
      fieldOfViewDeg: 90,
      gimbalPitchDeg: -90,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      droneLat: -26,
      droneLon: 153,
      defaultAltitudeM: 100,
    });

    expect(result).not.toBeNull();
    expect(result!.method).toBe('default_altitude');
    expect(result!.qualityFlags).toContain('default_altitude');
  });

  it('applies roll in the normative camera rotation', async () => {
    const result = await projectPixelToGeo({
      pixel: { x: 1100, y: 750 },
      imageWidth: 2000,
      imageHeight: 1500,
      intrinsics: { f: 1000, cx: 1000, cy: 750 },
      gimbalPitchDeg: -90,
      gimbalRollDeg: 90,
      gimbalYawDeg: 0,
      droneLat: -26,
      droneLon: 153,
      heightAboveGroundM: 100,
    });

    expect(result).not.toBeNull();
    const north = (result!.lat + 26) * 111111;
    expect(north).toBeCloseTo(-10, 3);
  });

  it('rejects an over-cap LRF pixel offset without relocating its far anchor', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const droneLat = -26;
    const droneLon = 153;
    const lrfHeightM = 100;
    const pitchDeg = -11.3;
    const lrfDistanceM = lrfHeightM / Math.sin((Math.abs(pitchDeg) * Math.PI) / 180);
    const targetLat = droneLat + 500 / 111111;
    const result = await projectPixelToGeo({
      pixel: { x: 1100, y: 750 },
      imageWidth: 2000,
      imageHeight: 1500,
      intrinsics: { f: 1000, cx: 1000, cy: 750 },
      gimbalPitchDeg: pitchDeg,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      droneLat,
      droneLon,
      lrfDistanceM,
      lrfTargetLat: targetLat,
      lrfTargetLon: droneLon,
      maxOffsetM: 20,
    });

    expect(result).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('[GEO] OFFSET_CAP:'));

    const nadir = await projectPixelToGeo({
      pixel: { x: 1100, y: 750 },
      imageWidth: 2000,
      imageHeight: 1500,
      intrinsics: { f: 1000, cx: 1000, cy: 750 },
      gimbalPitchDeg: -90,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      droneLat,
      droneLon,
      heightAboveGroundM: 100,
      maxOffsetM: 20,
    });

    expect(nadir).not.toBeNull();
    expect(nadir!.offsetFromCentreM).toBeCloseTo(10, 6);
    warning.mockRestore();
  });

  it('uses relative altitude directly and never queries terrain without a takeoff reference', async () => {
    const terrain = vi.fn(async () => 999);
    const result = await projectPixelToGeo({
      pixel: { x: 1000, y: 750 },
      imageWidth: 2000,
      imageHeight: 1500,
      intrinsics: { f: 1000, cx: 1000, cy: 750 },
      gimbalPitchDeg: -45,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      droneLat: -26,
      droneLon: 153,
      relativeAltitudeM: 100,
      terrainElevation: terrain,
    });

    expect(result).not.toBeNull();
    expect((result!.lat + 26) * 111111).toBeCloseTo(100, 3);
    expect(result!.qualityFlags).toContain('takeoff_reference_unknown');
    expect(terrain).not.toHaveBeenCalled();
  });

  it('applies relative-altitude terrain correction when takeoff elevation is explicit', async () => {
    const terrain = vi.fn(async () => 20);
    const result = await projectPixelToGeo({
      pixel: { x: 1000, y: 750 },
      imageWidth: 2000,
      imageHeight: 1500,
      intrinsics: { f: 1000, cx: 1000, cy: 750 },
      gimbalPitchDeg: -45,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      droneLat: -26,
      droneLon: 153,
      relativeAltitudeM: 100,
      takeoffTerrainElevationM: 50,
      terrainElevation: terrain,
    });

    expect(result).not.toBeNull();
    expect((result!.lat + 26) * 111111).toBeCloseTo(130, 3);
    expect(result!.qualityFlags).not.toContain('takeoff_reference_unknown');
    expect(terrain).toHaveBeenCalledTimes(1);
  });

  it('applies GeoAltitudeScale to the absolute-altitude adapter path', async () => {
    const result = await computeExportProjectionGeo(
      {
        gpsLatitude: -26,
        gpsLongitude: 153,
        altitude: null,
        gimbalPitch: -45,
        gimbalRoll: 0,
        gimbalYaw: 0,
        imageWidth: 2000,
        imageHeight: 1500,
        metadata: {
          AbsoluteAltitude: 200,
          GeoAltitudeScale: 1.1,
          CalibratedFocalLength: 1000,
          CalibratedOpticalCenterX: 1000,
          CalibratedOpticalCenterY: 750,
        },
      },
      { x: 1000, y: 750 }
    );

    expect(result).not.toBeNull();
    // 200 * 1.1 absolute - 30 m geoid - 0 m mocked terrain = 190 m AGL.
    expect((result!.lat + 26) * 111111).toBeCloseTo(190, 3);
    expect(result!.method).toBe('absolute_altitude_geoid_dem');
  });

  it('uses scaled-FOV intrinsics instead of calibrated focal length when GeoFovScale is valid', async () => {
    const calibratedFocalLength = 2000;
    const baseFovDeg =
      (2 * Math.atan(2000 / (2 * calibratedFocalLength)) * 180) / Math.PI;
    const scaledFovDeg = baseFovDeg * 1.1;
    const fovDerivedFocalLength =
      2000 / (2 * Math.tan((scaledFovDeg * Math.PI) / 360));
    const expectedOffsetM = (200 / fovDerivedFocalLength) * 100;
    const result = await computeExportProjectionGeo(
      {
        gpsLatitude: -26,
        gpsLongitude: 153,
        altitude: 100,
        gimbalPitch: -90,
        gimbalRoll: 0,
        gimbalYaw: 0,
        imageWidth: 2000,
        imageHeight: 1500,
        metadata: {
          GeoFovScale: 1.1,
          CalibratedFocalLength: calibratedFocalLength,
          CalibratedOpticalCenterX: 1000,
          CalibratedOpticalCenterY: 750,
        },
      },
      { x: 1200, y: 750 }
    );

    expect(result).not.toBeNull();
    expect(result!.offsetFromCentreM).toBeCloseTo(expectedOffsetM, 6);
    expect(result!.offsetFromCentreM).not.toBeCloseTo(10, 3);
    expect(result!.qualityFlags).toContain('fov_intrinsics');
  });

  it('applies the final absolute-altitude distance before a convergence break', async () => {
    const terrain = vi.mocked(getTerrainElevation);
    terrain.mockReset();
    terrain.mockResolvedValueOnce(100).mockResolvedValueOnce(100.25);

    const result = await projectPixelToGeo({
      pixel: { x: 1000, y: 750 },
      imageWidth: 2000,
      imageHeight: 1500,
      intrinsics: { f: 1000, cx: 1000, cy: 750 },
      gimbalPitchDeg: -45,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      droneLat: -26,
      droneLon: 153,
      absoluteAltitudeM: 230,
    });

    expect(result).not.toBeNull();
    const north = (result!.lat + 26) * 111111;
    expect(north).toBeCloseTo(99.75, 3);
    terrain.mockResolvedValue(0);
  });

  it('rejects and flags a near-horizon ray', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await projectPixelToGeo({
      pixel: { x: 1000, y: 750 },
      imageWidth: 2000,
      imageHeight: 1500,
      intrinsics: { f: 1000, cx: 1000, cy: 750 },
      gimbalPitchDeg: 0,
      gimbalRollDeg: 0,
      gimbalYawDeg: 0,
      droneLat: -26,
      droneLon: 153,
      heightAboveGroundM: 100,
    });

    expect(result).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('NEAR_HORIZON'));
    warning.mockRestore();
  });

  it('routes detections, export/review, and DSM compatibility through identical math', async () => {
    const asset: GeoAssetParams = {
      gpsLatitude: -26,
      gpsLongitude: 153,
      altitude: 100,
      gimbalPitch: -90,
      gimbalRoll: 0,
      gimbalYaw: 90,
      cameraFov: 90,
      imageWidth: 2000,
      imageHeight: 1500,
      lrfDistance: 100,
      lrfTargetLat: -26,
      lrfTargetLon: 153,
      metadata: {
        CalibratedFocalLength: 1000,
        CalibratedOpticalCenterX: 1000,
        CalibratedOpticalCenterY: 750,
      },
    };
    const pixel = { x: 1100, y: 750 };

    const resolved = await resolveGeoCoordinates(asset, pixel);
    const exported = await computeExportProjectionGeo(asset, pixel);
    const dsm = await pixelToGeoWithDSM(asset, pixel);

    expect(resolved).not.toBeNull();
    expect(exported).not.toBeNull();
    expect(dsm).not.toBeNull();
    expect(exported!.lat).toBe(resolved!.geo.lat);
    expect(exported!.lon).toBe(resolved!.geo.lon);
    expect(dsm!.lat).toBe(resolved!.geo.lat);
    expect(dsm!.lon).toBe(resolved!.geo.lon);
    expect(resolved!.method).toBe('lrf');
  });
});
