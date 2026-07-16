import { getTerrainElevation } from '@/lib/services/elevation';

/**
 * Canonical pixel -> WGS84 projection conventions.
 *
 * Pixel: origin top-left, +x right, +y down.
 * Camera: +x right, +y image-down, +z along the boresight.
 * World: ENU (east, north, up).
 * DJI yaw: compass bearing, clockwise-positive from north.
 * DJI pitch: 0 = horizontal, -90 = nadir.
 * DJI roll: clockwise-positive when viewed from behind the camera.
 *
 * The rotation and intersection below are a literal implementation of the
 * normative georeferencing-overhaul referenceProject() fixture. Normalized
 * pixel coordinates are tangents already; they must never receive tan() again.
 */

const METERS_PER_DEGREE_LAT = 111111;
const NEAR_HORIZON_RATIO = 0.05;
const HEIGHT_CONVERGENCE_M = 0.5;
const ABSOLUTE_HEIGHT_ITERATIONS = 3;

export type ProjectionMethod =
  | 'lrf'
  | 'relative_altitude_dem'
  | 'absolute_altitude_geoid_dem'
  | 'provided_height'
  | 'default_altitude';

export interface ProjectionIntrinsics {
  f: number;
  cx: number;
  cy: number;
}

export interface ProjectionPixel {
  x: number;
  y: number;
}

export interface ProjectionCoreInput {
  pixel: ProjectionPixel;
  imageWidth: number;
  imageHeight: number;
  intrinsics?: Partial<ProjectionIntrinsics> | null;
  fieldOfViewDeg?: number | null;
  gimbalPitchDeg: number;
  gimbalRollDeg: number;
  gimbalYawDeg: number;
  droneLat: number;
  droneLon: number;

  /** A caller-resolved AGL height, primarily for fixtures and compatibility. */
  heightAboveGroundM?: number | null;
  /** Slant range along the centre-pixel boresight. Highest-priority height source. */
  lrfDistanceM?: number | null;
  /** DJI-computed LRF boresight ground point used to anchor LRF projections. */
  lrfTargetLat?: number | null;
  lrfTargetLon?: number | null;
  /** Height above the takeoff elevation. */
  relativeAltitudeM?: number | null;
  /** WGS84 ellipsoidal/barometric absolute altitude. */
  absoluteAltitudeM?: number | null;
  /** Optional known elevation seeds. */
  takeoffTerrainElevationM?: number | null;
  lrfTargetElevationM?: number | null;
  /** Explicit, flagged last resort. */
  defaultAltitudeM?: number | null;

  maxOffsetM?: number | null;
  terrainElevation?: (lat: number, lon: number) => Promise<number>;
  geoidHeightCorrection?: (lat: number, lon: number) => number;
  qualityFlags?: string[];
}

export interface ProjectionCoreResult {
  lat: number;
  lon: number;
  method: ProjectionMethod;
  offsetFromCentreM: number;
  qualityFlags: string[];
}

type RayEnu = {
  east: number;
  north: number;
  up: number;
  length: number;
};

type ProjectedOffsets = {
  east: number;
  north: number;
  centreEast: number;
  centreNorth: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function uniqueFlags(flags: string[]): string[] {
  return [...new Set(flags)];
}

function resolveIntrinsics(input: ProjectionCoreInput, flags: string[]): ProjectionIntrinsics | null {
  const calibrated = input.intrinsics;
  if (
    calibrated &&
    isPositiveFinite(calibrated.f) &&
    isFiniteNumber(calibrated.cx) &&
    isFiniteNumber(calibrated.cy)
  ) {
    return { f: calibrated.f, cx: calibrated.cx, cy: calibrated.cy };
  }

  if (
    !isPositiveFinite(input.imageWidth) ||
    !isPositiveFinite(input.imageHeight) ||
    !isFiniteNumber(input.fieldOfViewDeg) ||
    input.fieldOfViewDeg <= 0 ||
    input.fieldOfViewDeg >= 180
  ) {
    return null;
  }

  const f = input.imageWidth / (2 * Math.tan((input.fieldOfViewDeg * Math.PI) / 360));
  if (!isPositiveFinite(f)) {
    return null;
  }

  flags.push('fov_intrinsics');
  return {
    f,
    cx: isFiniteNumber(calibrated?.cx) ? calibrated.cx : input.imageWidth / 2,
    cy: isFiniteNumber(calibrated?.cy) ? calibrated.cy : input.imageHeight / 2,
  };
}

function cameraRayToEnu(
  tanx: number,
  tany: number,
  pitchDeg: number,
  rollDeg: number,
  yawDeg: number
): RayEnu | null {
  if (![tanx, tany, pitchDeg, rollDeg, yawDeg].every(Number.isFinite)) {
    return null;
  }

  const radians = Math.PI / 180;
  const pitch = pitchDeg * radians;
  const roll = rollDeg * radians;
  const yaw = yawDeg * radians;

  // Roll about the boresight.
  const xPrime = tanx * Math.cos(roll) - tany * Math.sin(roll);
  const yPrime = tanx * Math.sin(roll) + tany * Math.cos(roll);
  const zPrime = 1;

  // Camera -> ENU for a north-facing, level camera.
  const east0 = xPrime;
  const north0 = zPrime;
  const up0 = -yPrime;

  // Pitch about the East axis.
  const north1 = north0 * Math.cos(pitch) - up0 * Math.sin(pitch);
  const up1 = north0 * Math.sin(pitch) + up0 * Math.cos(pitch);

  // DJI compass yaw, clockwise-positive from north.
  const east = north1 * Math.sin(yaw) + east0 * Math.cos(yaw);
  const north = north1 * Math.cos(yaw) - east0 * Math.sin(yaw);
  const up = up1;
  const length = Math.hypot(east, north, up);

  if (![east, north, up, length].every(Number.isFinite) || length <= 0) {
    return null;
  }
  return { east, north, up, length };
}

function intersectAtHeight(
  input: ProjectionCoreInput,
  intrinsics: ProjectionIntrinsics,
  heightM: number
): ProjectedOffsets | null {
  if (!isPositiveFinite(heightM)) {
    return null;
  }

  const tanx = (input.pixel.x - intrinsics.cx) / intrinsics.f;
  const tany = (input.pixel.y - intrinsics.cy) / intrinsics.f;
  const ray = cameraRayToEnu(
    tanx,
    tany,
    input.gimbalPitchDeg,
    input.gimbalRollDeg,
    input.gimbalYawDeg
  );
  const boresight = cameraRayToEnu(
    0,
    0,
    input.gimbalPitchDeg,
    input.gimbalRollDeg,
    input.gimbalYawDeg
  );

  if (
    !ray ||
    !boresight ||
    ray.up >= -NEAR_HORIZON_RATIO * ray.length ||
    boresight.up >= -NEAR_HORIZON_RATIO * boresight.length
  ) {
    console.warn('[GEO] NEAR_HORIZON: projection ray is not safely descending');
    return null;
  }

  const t = heightM / -ray.up;
  const centreT = heightM / -boresight.up;
  const east = t * ray.east;
  const north = t * ray.north;
  const centreEast = centreT * boresight.east;
  const centreNorth = centreT * boresight.north;

  if (![east, north, centreEast, centreNorth].every(Number.isFinite)) {
    return null;
  }
  return { east, north, centreEast, centreNorth };
}

function resultAtHeight(
  input: ProjectionCoreInput,
  intrinsics: ProjectionIntrinsics,
  heightM: number,
  method: ProjectionMethod,
  flags: string[]
): ProjectionCoreResult | null {
  const offsets = intersectAtHeight(input, intrinsics, heightM);
  if (!offsets) {
    return null;
  }

  const metersPerDegreeLon =
    METERS_PER_DEGREE_LAT * Math.cos((input.droneLat * Math.PI) / 180);
  if (!Number.isFinite(metersPerDegreeLon) || Math.abs(metersPerDegreeLon) < 1e-6) {
    return null;
  }

  let lat = input.droneLat + offsets.north / METERS_PER_DEGREE_LAT;
  let lon = input.droneLon + offsets.east / metersPerDegreeLon;

  if (
    method === 'lrf' &&
    isFiniteNumber(input.lrfTargetLat) &&
    isFiniteNumber(input.lrfTargetLon)
  ) {
    const targetMetersPerDegreeLon =
      METERS_PER_DEGREE_LAT * Math.cos((input.lrfTargetLat * Math.PI) / 180);
    if (
      !Number.isFinite(targetMetersPerDegreeLon) ||
      Math.abs(targetMetersPerDegreeLon) < 1e-6
    ) {
      return null;
    }

    const deltaEast = offsets.east - offsets.centreEast;
    const deltaNorth = offsets.north - offsets.centreNorth;
    lat = input.lrfTargetLat + deltaNorth / METERS_PER_DEGREE_LAT;
    lon = input.lrfTargetLon + deltaEast / targetMetersPerDegreeLon;
    flags.push('lrf_anchored');
  }

  if (!validateProjectedCoordinates(lat, lon)) {
    return null;
  }

  const offsetFromCentreM = Math.hypot(
    offsets.east - offsets.centreEast,
    offsets.north - offsets.centreNorth
  );
  if (!Number.isFinite(offsetFromCentreM)) {
    return null;
  }
  if (isPositiveFinite(input.maxOffsetM) && offsetFromCentreM > input.maxOffsetM) {
    console.warn(
      `[GEO] OFFSET_CAP: pixel ground offset ${offsetFromCentreM.toFixed(3)}m exceeds ` +
        `${input.maxOffsetM.toFixed(3)}m; rejecting projection`
    );
    return null;
  }

  if (!validateProjectedCoordinates(lat, lon)) {
    return null;
  }

  return {
    lat,
    lon,
    method,
    offsetFromCentreM,
    qualityFlags: uniqueFlags(flags),
  };
}

function lrfHeight(input: ProjectionCoreInput): number | null {
  if (!isPositiveFinite(input.lrfDistanceM)) {
    return null;
  }
  const boresight = cameraRayToEnu(
    0,
    0,
    input.gimbalPitchDeg,
    input.gimbalRollDeg,
    input.gimbalYawDeg
  );
  if (!boresight || boresight.up >= -NEAR_HORIZON_RATIO * boresight.length) {
    console.warn('[GEO] NEAR_HORIZON: LRF boresight is not safely descending');
    return null;
  }
  const height = input.lrfDistanceM * -boresight.up;
  return isPositiveFinite(height) ? height : null;
}

/**
 * Temporary geoid approximation retained unchanged for PR 2 compatibility.
 * PR 3 replaces this with the real geoid model.
 */
export function getGeoidHeightCorrection(latitude: number, longitude: number): number {
  if (latitude >= -30 && latitude <= -25 && longitude >= 150 && longitude <= 155) {
    return 30;
  }
  if (latitude >= -35 && latitude <= -30 && longitude >= 150 && longitude <= 155) {
    return 32;
  }
  if (latitude >= -40 && latitude <= -35 && longitude >= 145 && longitude <= 150) {
    return 28;
  }
  return 30;
}

export function validateProjectedCoordinates(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** Synchronous compatibility entry point when AGL height is already resolved. */
export function projectPixelToGeoAtHeight(
  input: ProjectionCoreInput,
  heightM: number,
  method: ProjectionMethod = 'provided_height'
): ProjectionCoreResult | null {
  const flags = [...(input.qualityFlags ?? [])];
  const intrinsics = resolveIntrinsics(input, flags);
  if (
    !intrinsics ||
    !isPositiveFinite(input.imageWidth) ||
    !isPositiveFinite(input.imageHeight) ||
    !isFiniteNumber(input.pixel?.x) ||
    !isFiniteNumber(input.pixel?.y) ||
    !validateProjectedCoordinates(input.droneLat, input.droneLon)
  ) {
    return null;
  }
  return resultAtHeight(input, intrinsics, heightM, method, flags);
}

/**
 * Resolve height using LRF -> relative+DEM -> absolute-geoid-DEM, then run the
 * one canonical pixel/ray/ENU projection implementation.
 */
export async function projectPixelToGeo(
  input: ProjectionCoreInput
): Promise<ProjectionCoreResult | null> {
  if (
    !input ||
    !isPositiveFinite(input.imageWidth) ||
    !isPositiveFinite(input.imageHeight) ||
    !isFiniteNumber(input.pixel?.x) ||
    !isFiniteNumber(input.pixel?.y) ||
    !validateProjectedCoordinates(input.droneLat, input.droneLon)
  ) {
    return null;
  }

  const flags = [...(input.qualityFlags ?? [])];
  const intrinsics = resolveIntrinsics(input, flags);
  if (!intrinsics) {
    return null;
  }

  const resolvedLrfHeight = lrfHeight(input);
  if (resolvedLrfHeight != null) {
    return resultAtHeight(input, intrinsics, resolvedLrfHeight, 'lrf', flags);
  }

  if (isPositiveFinite(input.heightAboveGroundM)) {
    return resultAtHeight(
      input,
      intrinsics,
      input.heightAboveGroundM,
      'provided_height',
      flags
    );
  }

  const terrainElevation = input.terrainElevation ?? getTerrainElevation;

  if (isPositiveFinite(input.relativeAltitudeM)) {
    if (!isFiniteNumber(input.takeoffTerrainElevationM)) {
      flags.push('takeoff_reference_unknown');
      return resultAtHeight(
        input,
        intrinsics,
        input.relativeAltitudeM,
        'relative_altitude_dem',
        flags
      );
    }

    try {
      const initial = resultAtHeight(
        input,
        intrinsics,
        input.relativeAltitudeM,
        'relative_altitude_dem',
        flags
      );
      if (!initial) {
        return null;
      }
      const targetElevation = await terrainElevation(initial.lat, initial.lon);
      const finalHeight =
        input.relativeAltitudeM + input.takeoffTerrainElevationM - targetElevation;
      return resultAtHeight(
        input,
        intrinsics,
        finalHeight,
        'relative_altitude_dem',
        flags
      );
    } catch {
      flags.push('estimated_elevation');
      return resultAtHeight(
        input,
        intrinsics,
        input.relativeAltitudeM,
        'relative_altitude_dem',
        flags
      );
    }
  }

  if (isFiniteNumber(input.absoluteAltitudeM)) {
    const geoid = input.geoidHeightCorrection ?? getGeoidHeightCorrection;
    try {
      let terrain = isFiniteNumber(input.lrfTargetElevationM)
        ? input.lrfTargetElevationM
        : await terrainElevation(input.droneLat, input.droneLon);
      let projected: ProjectionCoreResult | null = null;

      for (let iteration = 0; iteration < ABSOLUTE_HEIGHT_ITERATIONS; iteration += 1) {
        const initialHeight = input.absoluteAltitudeM - geoid(input.droneLat, input.droneLon) - terrain;
        projected = resultAtHeight(
          input,
          intrinsics,
          initialHeight,
          'absolute_altitude_geoid_dem',
          flags
        );
        if (!projected) {
          return null;
        }

        const targetTerrain = await terrainElevation(projected.lat, projected.lon);
        const finalHeight =
          input.absoluteAltitudeM - geoid(projected.lat, projected.lon) - targetTerrain;

        // Apply the updated distance before checking convergence. The legacy
        // implementation broke first and shipped the stale distance.
        projected = resultAtHeight(
          input,
          intrinsics,
          finalHeight,
          'absolute_altitude_geoid_dem',
          flags
        );
        if (!projected) {
          return null;
        }

        if (Math.abs(targetTerrain - terrain) < HEIGHT_CONVERGENCE_M) {
          return projected;
        }
        terrain = targetTerrain;
      }
      return projected;
    } catch {
      flags.push('estimated_elevation');
    }
  }

  if (isPositiveFinite(input.defaultAltitudeM)) {
    flags.push('default_altitude');
    return resultAtHeight(
      input,
      intrinsics,
      input.defaultAltitudeM,
      'default_altitude',
      flags
    );
  }

  return null;
}
