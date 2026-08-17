export const PINE_STOCKTAKE_METHOD = 'pine-stocktake-v1' as const;
export const SAM3_IDENTITY = Object.freeze({
  repository: 'facebook/sam3',
  revision: '3c879f39826c281e95690f02c7821c4de09afae7',
  weightSha256: '6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a',
});
export const FLAT_MAP_RUNNER_IDENTITY = Object.freeze({
  path: 'C:\\Users\\nd-ops\\work\\flat-map-runner',
  baseCommit: '707ab72ffe90632f257fcdcaac9f357dba193b0b',
  validatedCommit: '824cf071c7220f831cf3352111a43caddf8f25c8',
  treeSha256: '6c35112fe4c0b70d8018f3133ac562e3e9ca37f64cbaa970e48e624c17ab337d',
});
export const PINE_STOCKTAKE_CONFIG = Object.freeze({
  canvasSize: 1008,
  supportHeight: 252,
  tileSize: 1024,
  stride: 768,
  scoreThreshold: 0.5,
  maskThreshold: 0.5,
  agreementIou: 0.7,
  rayMinHagM: 0.15,
  rayMaxHagM: 2.3,
  rayNeighbourhoodRadiusM: 0.75,
  duplicateRadiusM: 0.5,
  vegetationClasses: [3, 4, 5] as const,
});

export type Point2 = readonly [number, number];
export type Point3 = readonly [number, number, number];
export type Polygon = readonly Point2[];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeTile {
  tileId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  partial: boolean;
}

export interface ExemplarInput {
  id: string;
  sourceImageId: string;
  sourceImageSha256: string;
  polygon: Polygon;
  approved: boolean;
}

export interface BinaryMask {
  width: number;
  height: number;
  /** Row-major indices for pixels whose probability met the fixed mask threshold. */
  active: readonly number[];
}

export interface ModelCandidate {
  candidateId: string;
  exemplarId: string;
  targetImageId: string;
  targetImageSha256: string;
  tile: NativeTile;
  score: number;
  mask: BinaryMask;
  polygon: Polygon;
  modelResultSha256: string;
}

export interface FusedCandidate extends ModelCandidate {
  duplicateLineage: readonly string[];
}

export interface AgreementGroup {
  agreementId: string;
  representativeCandidateId: string;
  candidateIds: readonly string[];
  exemplarIds: readonly string[];
  scoresByExemplar: Readonly<Record<string, number>>;
  agreementLevel: 1 | 2 | 3;
  polygon: Polygon;
}

export interface CalibrationTransform {
  serial: string;
  quaternion: readonly [number, number, number, number];
  translationM: Point3;
}

export interface PoseRecord {
  timestamp: number;
  position: Point3;
  quaternion: readonly [number, number, number, number];
  timebase: string;
}

export interface CameraModel {
  focalPx: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface ProjectionFrame {
  camera: CameraModel;
  cameraOrigin: Point3;
  cameraToWorld: readonly (readonly [number, number, number])[];
}

export interface LidarPoint {
  id: string;
  x: number;
  y: number;
  z: number;
  hag: number;
  classification: number;
}

export interface CrownCluster {
  status: 'matched';
  pointIds: readonly string[];
  pointCount: number;
  x: number;
  y: number;
  heightP99M: number;
  heightMaxValidM: number;
  apexX: number;
  apexY: number;
  apexZ: number;
  localGroundZ: number;
  confidence: number;
}

export type MissingHeightReason =
  | 'missing_calibration'
  | 'camera_serial_mismatch'
  | 'missing_pose_identity'
  | 'ambiguous_timebase'
  | 'unknown_crs'
  | 'no_direct_lidar_support'
  | 'ambiguous_cross_view_match'
  | 'no_bounded_neighbourhood_cluster'
  | 'new_cluster_requires_review';

export type LidarAssociation =
  | CrownCluster
  | { status: 'missing'; reason: MissingHeightReason; detail: string };

export interface ReviewRevision {
  revisionId: string;
  candidateId: string | null;
  parentRevisionId: string | null;
  polygon: Polygon;
  action: 'adjust' | 'delete' | 'add_missed' | 'mark_unsure' | 'mark_edge_clipped' | 'accept';
  reviewState: 'working' | 'accepted' | 'rejected' | 'unsure';
  edgeClipped: boolean;
  reviewerId: string;
  reviewedAt: string;
}

export interface AcceptedCrown {
  crownId: string;
  sourceImageId: string;
  sourceImageSha256: string;
  nativePolygon: Polygon;
  contributingExemplarIds: readonly string[];
  scoresByExemplar: Readonly<Record<string, number>>;
  agreementLevel: 0 | 1 | 2 | 3;
  reviewerId: string;
  reviewedAt: string;
  revisionLineage: readonly string[];
  edgeClipped: boolean;
  reviewState: 'accepted';
}

const assertFinite = (value: number, name: string) => {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
};

export function oneShotLayout(): { support: Rect; query: Rect } {
  const { canvasSize, supportHeight } = PINE_STOCKTAKE_CONFIG;
  return {
    support: { x: 0, y: 0, width: canvasSize, height: supportHeight },
    query: { x: 0, y: supportHeight, width: canvasSize, height: canvasSize - supportHeight },
  };
}

export function centreCropForSlot(box: readonly [number, number, number, number], slot: Rect, image: { width: number; height: number }): Rect {
  const [x1, y1, x2, y2] = box;
  if (!(x1 >= 0 && y1 >= 0 && x1 < x2 && y1 < y2 && x2 <= image.width && y2 <= image.height)) {
    throw new Error('exemplar box is outside its source image');
  }
  const maxScale = Math.min(slot.width / (x2 - x1), slot.height / (y2 - y1), 1);
  const cropWidth = Math.min(image.width, Math.max(slot.width, Math.ceil(slot.width / maxScale)));
  const cropHeight = Math.min(image.height, Math.max(slot.height, Math.ceil(slot.height / maxScale)));
  const x = Math.min(Math.max(Math.round((x1 + x2 - cropWidth) / 2), 0), image.width - cropWidth);
  const y = Math.min(Math.max(Math.round((y1 + y2 - cropHeight) / 2), 0), image.height - cropHeight);
  if (!(x <= x1 && y <= y1 && x + cropWidth >= x2 && y + cropHeight >= y2)) {
    throw new Error('support crop does not contain the full crown');
  }
  return { x, y, width: cropWidth, height: cropHeight };
}

export function transformBoxToCanvas(box: readonly [number, number, number, number], crop: Rect, slot: Rect): readonly [number, number, number, number] {
  const [x1, y1, x2, y2] = box;
  const sx = slot.width / crop.width;
  const sy = slot.height / crop.height;
  return [slot.x + (x1 - crop.x) * sx, slot.y + (y1 - crop.y) * sy, slot.x + (x2 - crop.x) * sx, slot.y + (y2 - crop.y) * sy];
}

export function assertThreeExternalExemplars(exemplars: readonly ExemplarInput[], targetImageId: string): void {
  if (exemplars.length !== 3) throw new Error('pine-stocktake-v1 requires exactly three exemplars');
  if (new Set(exemplars.map((item) => item.id)).size !== 3) throw new Error('exemplar IDs must be distinct');
  for (const exemplar of exemplars) {
    if (!exemplar.approved) throw new Error(`exemplar ${exemplar.id} is not approved`);
    if (exemplar.sourceImageId === targetImageId) throw new Error('target-image annotations are forbidden as prompts');
    if (exemplar.polygon.length < 3) throw new Error(`exemplar ${exemplar.id} is not a full polygon`);
  }
}

export function axisStarts(length: number, tileSize = PINE_STOCKTAKE_CONFIG.tileSize, stride = PINE_STOCKTAKE_CONFIG.stride): number[] {
  if (!Number.isInteger(length) || length <= 0 || stride <= 0 || stride > tileSize) throw new Error('invalid image, tile or stride dimensions');
  if (length <= tileSize) return [0];
  const starts: number[] = [];
  for (let start = 0; start <= length - tileSize; start += stride) starts.push(start);
  const final = length - tileSize;
  if (starts.at(-1) !== final) starts.push(final);
  return starts;
}

export function nativeTiles(width: number, height: number, tileSize = PINE_STOCKTAKE_CONFIG.tileSize, stride = PINE_STOCKTAKE_CONFIG.stride): NativeTile[] {
  const xs = axisStarts(width, tileSize, stride);
  const ys = axisStarts(height, tileSize, stride);
  const tiles: NativeTile[] = [];
  ys.forEach((y1, row) => xs.forEach((x1, column) => {
    const x2 = Math.min(width, x1 + tileSize);
    const y2 = Math.min(height, y1 + tileSize);
    tiles.push({ tileId: `T${String(row).padStart(2, '0')}${String(column).padStart(2, '0')}`, x1, y1, x2, y2, width: x2 - x1, height: y2 - y1, partial: x2 - x1 < tileSize || y2 - y1 < tileSize });
  }));
  return tiles;
}

export function isPixelCovered(x: number, y: number, tiles: readonly NativeTile[]): boolean {
  return tiles.some((tile) => x >= tile.x1 && x < tile.x2 && y >= tile.y1 && y < tile.y2);
}

export function mapQueryPointToNative(point: Point2, query: Rect, tile: NativeTile): Point2 {
  const [x, y] = point;
  return [tile.x1 + ((x - query.x) / query.width) * tile.width, tile.y1 + ((y - query.y) / query.height) * tile.height];
}

export function mapNativePointToQuery(point: Point2, query: Rect, tile: NativeTile): Point2 {
  const [x, y] = point;
  return [query.x + ((x - tile.x1) / tile.width) * query.width, query.y + ((y - tile.y1) / tile.height) * query.height];
}

export function validateNativePolygon(polygon: Polygon, width: number, height: number): void {
  if (polygon.length < 3) throw new Error('native polygon is degenerate');
  for (const [x, y] of polygon) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) throw new Error('native polygon exceeds image bounds');
  }
}

function activeNativePixels(mask: BinaryMask, tile: NativeTile): Set<string> {
  if (mask.width !== tile.width || mask.height !== tile.height) throw new Error('mask shape does not match native tile');
  const result = new Set<string>();
  for (const index of mask.active) {
    if (!Number.isInteger(index) || index < 0 || index >= mask.width * mask.height) throw new Error('mask index is outside native tile');
    result.add(`${tile.x1 + (index % mask.width)},${tile.y1 + Math.floor(index / mask.width)}`);
  }
  return result;
}

export function nativeMaskIou(left: Pick<ModelCandidate, 'mask' | 'tile'>, right: Pick<ModelCandidate, 'mask' | 'tile'>): number {
  const a = activeNativePixels(left.mask, left.tile);
  const b = activeNativePixels(right.mask, right.tile);
  let intersection = 0;
  for (const key of a) if (b.has(key)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function fusePerExemplar(candidates: readonly ModelCandidate[], threshold = PINE_STOCKTAKE_CONFIG.agreementIou): { kept: FusedCandidate[]; merges: readonly { candidateId: string; mergedInto: string; iou: number }[] } {
  if (new Set(candidates.map((candidate) => candidate.exemplarId)).size > 1) throw new Error('per-exemplar fusion cannot combine exemplar runs');
  const ordered = [...candidates].sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));
  const kept: FusedCandidate[] = [];
  const merges: { candidateId: string; mergedInto: string; iou: number }[] = [];
  for (const candidate of ordered) {
    const match = kept.map((item) => ({ item, iou: candidate.tile.tileId === item.tile.tileId ? 0 : nativeMaskIou(candidate, item) })).find((row) => row.iou >= threshold);
    if (!match) kept.push({ ...candidate, duplicateLineage: [] });
    else {
      const index = kept.findIndex((item) => item.candidateId === match.item.candidateId);
      kept[index] = { ...kept[index], duplicateLineage: [...kept[index].duplicateLineage, candidate.candidateId] };
      merges.push({ candidateId: candidate.candidateId, mergedInto: match.item.candidateId, iou: match.iou });
    }
  }
  return { kept, merges };
}

export function buildAgreementGroups(perExemplar: Readonly<Record<string, readonly FusedCandidate[]>>, threshold = PINE_STOCKTAKE_CONFIG.agreementIou): AgreementGroup[] {
  const exemplarIds = Object.keys(perExemplar).sort();
  if (exemplarIds.length !== 3) throw new Error('agreement requires three separate exemplar runs');
  const all = exemplarIds.flatMap((id) => perExemplar[id].map((candidate) => candidate));
  const groups: FusedCandidate[][] = [];
  for (const candidate of all.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId))) {
    let best: { group: FusedCandidate[]; iou: number } | null = null;
    for (const group of groups) {
      if (group.some((member) => member.exemplarId === candidate.exemplarId)) continue;
      const iou = Math.max(...group.map((member) => nativeMaskIou(candidate, member)));
      if (iou >= threshold && (!best || iou > best.iou)) best = { group, iou };
    }
    if (best) best.group.push(candidate);
    else groups.push([candidate]);
  }
  return groups.map((members, index) => {
    const representative = [...members].sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId))[0];
    const scoresByExemplar = Object.fromEntries(members.map((member) => [member.exemplarId, member.score]));
    return {
      agreementId: `agreement-${String(index + 1).padStart(6, '0')}`,
      representativeCandidateId: representative.candidateId,
      candidateIds: members.map((member) => member.candidateId).sort(),
      exemplarIds: members.map((member) => member.exemplarId).sort(),
      scoresByExemplar,
      agreementLevel: members.length as 1 | 2 | 3,
      polygon: representative.polygon,
    };
  });
}

export function assertPinnedModel(identity: { repository: string; revision: string; weightSha256: string }): void {
  if (identity.repository !== SAM3_IDENTITY.repository || identity.revision !== SAM3_IDENTITY.revision || identity.weightSha256 !== SAM3_IDENTITY.weightSha256) {
    throw new Error('SAM3 identity drift; fallback is prohibited');
  }
}

function parseVector(lines: string[], index: number): number[] {
  const values = lines[index + 1]?.trim().split(/\s+/).map(Number) ?? [];
  if (!values.length || values.some((value) => !Number.isFinite(value))) throw new Error('invalid calibration vector');
  return values;
}

export function parseClc(text: string): CalibrationTransform[] {
  const lines = text.split(/\r?\n/);
  const result: CalibrationTransform[] = [];
  let serial: string | null = null;
  let quaternion: number[] | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('Camera serial number:')) serial = line.split(':', 2)[1].trim();
    else if (line.startsWith('Q(')) quaternion = parseVector(lines, index);
    else if (line.startsWith('T(') && serial && quaternion) {
      const translation = parseVector(lines, index);
      if (quaternion.length !== 4 || translation.length !== 3) throw new Error('invalid CLC transform dimensions');
      const norm = Math.hypot(...quaternion);
      result.push({ serial, quaternion: quaternion.map((value) => value / norm) as unknown as CalibrationTransform['quaternion'], translationM: translation.map((value) => value / 1000) as unknown as Point3 });
      serial = null;
      quaternion = null;
    }
  }
  if (!result.length) throw new Error('CLC contains no camera transforms');
  if (new Set(result.map((item) => item.serial)).size !== result.length) throw new Error('CLC contains duplicate camera serials');
  return result;
}

export function parseCli(text: string): Omit<CalibrationTransform, 'serial'> {
  const lines = text.split(/\r?\n/);
  let quaternion: number[] | null = null;
  let translation: number[] | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('Q(')) quaternion = parseVector(lines, index);
    if (line.startsWith('T(')) translation = parseVector(lines, index).map((value) => value / 1000);
  }
  if (!quaternion || quaternion.length !== 4 || !translation || translation.length !== 3) throw new Error('CLI must contain one Q/T transform');
  const norm = Math.hypot(...quaternion);
  return { quaternion: quaternion.map((value) => value / norm) as unknown as CalibrationTransform['quaternion'], translationM: translation as unknown as Point3 };
}

export function validateCameraSerials(imageSerials: readonly string[], clc: readonly CalibrationTransform[]): void {
  const available = new Set(clc.map((item) => item.serial));
  const missing = [...new Set(imageSerials)].filter((serial) => !available.has(serial));
  if (missing.length) throw new Error(`camera serial mismatch: ${missing.join(', ')}`);
}

function normalizeQuaternion(q: readonly number[]): [number, number, number, number] {
  const norm = Math.hypot(...q);
  if (!norm) throw new Error('zero quaternion');
  return q.map((value) => value / norm) as [number, number, number, number];
}

export function matchPose(timestamp: number, poses: readonly PoseRecord[], expectedTimebase: string): PoseRecord {
  if (!expectedTimebase.trim()) throw new Error('ambiguous timebase');
  if (poses.length < 2 || poses.some((pose) => pose.timebase !== expectedTimebase)) throw new Error('pose timebase cannot be proven');
  const ordered = [...poses].sort((a, b) => a.timestamp - b.timestamp);
  if (timestamp < ordered[0].timestamp || timestamp > ordered.at(-1)!.timestamp) throw new Error('trigger is outside pose span');
  const rightIndex = ordered.findIndex((pose) => pose.timestamp >= timestamp);
  if (ordered[rightIndex].timestamp === timestamp) return ordered[rightIndex];
  if (rightIndex <= 0) throw new Error('missing pose identity');
  const left = ordered[rightIndex - 1];
  const right = ordered[rightIndex];
  const fraction = (timestamp - left.timestamp) / (right.timestamp - left.timestamp);
  return {
    timestamp,
    timebase: expectedTimebase,
    position: left.position.map((value, index) => value + (right.position[index] - value) * fraction) as unknown as Point3,
    quaternion: normalizeQuaternion(left.quaternion.map((value, index) => value + (right.quaternion[index] - value) * fraction)),
  };
}

function matVec(matrix: ProjectionFrame['cameraToWorld'], vector: Point3): Point3 {
  return matrix.map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]) as unknown as Point3;
}

function transpose(matrix: ProjectionFrame['cameraToWorld']): ProjectionFrame['cameraToWorld'] {
  return [0, 1, 2].map((column) => [matrix[0][column], matrix[1][column], matrix[2][column]]) as ProjectionFrame['cameraToWorld'];
}

export function pixelToWorld(frame: ProjectionFrame, pixel: Point2, distanceM: number): Point3 {
  if (distanceM <= 0) throw new Error('distance must be positive');
  const rayCamera = normalize3([(pixel[0] - frame.camera.cx) / frame.camera.focalPx, (pixel[1] - frame.camera.cy) / frame.camera.focalPx, 1]);
  const rayWorld = matVec(frame.cameraToWorld, rayCamera);
  return frame.cameraOrigin.map((value, index) => value + rayWorld[index] * distanceM) as unknown as Point3;
}

export function worldToPixel(frame: ProjectionFrame, world: Point3): Point2 {
  const delta = world.map((value, index) => value - frame.cameraOrigin[index]) as unknown as Point3;
  const camera = matVec(transpose(frame.cameraToWorld), delta);
  if (camera[2] <= 0) throw new Error('world point is behind camera');
  return [frame.camera.cx + frame.camera.focalPx * camera[0] / camera[2], frame.camera.cy + frame.camera.focalPx * camera[1] / camera[2]];
}

function normalize3(vector: Point3): Point3 {
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm) as unknown as Point3;
}

export function selectProjectedCrs(latitude: number, longitude: number): string {
  assertFinite(latitude, 'latitude');
  assertFinite(longitude, 'longitude');
  if (latitude < -80 || latitude > 84 || longitude < -180 || longitude > 180) throw new Error('location cannot be represented by a UTM projected CRS');
  const zone = Math.min(60, Math.max(1, Math.floor((longitude + 180) / 6) + 1));
  return `EPSG:${latitude >= 0 ? 32600 + zone : 32700 + zone}`;
}

function quantile(values: readonly number[], probability: number): number {
  if (!values.length) throw new Error('quantile requires values');
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function connectedComponents(points: readonly LidarPoint[], cellSizeM: number): LidarPoint[][] {
  const cells = new Map<string, LidarPoint[]>();
  for (const point of points) {
    const key = `${Math.floor(point.x / cellSizeM)},${Math.floor(point.y / cellSizeM)}`;
    cells.set(key, [...(cells.get(key) ?? []), point]);
  }
  const remaining = new Set(cells.keys());
  const result: LidarPoint[][] = [];
  while (remaining.size) {
    const start = remaining.values().next().value as string;
    const queue = [start];
    remaining.delete(start);
    const component: LidarPoint[] = [];
    while (queue.length) {
      const key = queue.shift()!;
      component.push(...(cells.get(key) ?? []));
      const [x, y] = key.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
        const neighbour = `${x + dx},${y + dy}`;
        if (remaining.delete(neighbour)) queue.push(neighbour);
      }
    }
    result.push(component);
  }
  return result;
}

export function selectCrownCluster(points: readonly LidarPoint[], cellSizeM = 0.08, minPoints = 5): LidarAssociation {
  const valid = points.filter((point) => PINE_STOCKTAKE_CONFIG.vegetationClasses.includes(point.classification as 3 | 4 | 5) && Number.isFinite(point.hag) && point.hag >= PINE_STOCKTAKE_CONFIG.rayMinHagM);
  if (valid.length < minPoints) return { status: 'missing', reason: 'no_direct_lidar_support', detail: `Only ${valid.length} valid vegetation points` };
  const components = connectedComponents(valid, cellSizeM).filter((component) => component.length >= minPoints);
  if (!components.length) return { status: 'missing', reason: 'no_direct_lidar_support', detail: 'No coherent vegetation component' };
  const selected = [...components].sort((a, b) => b.length * (0.5 + quantile(b.map((point) => point.hag), 0.95)) - a.length * (0.5 + quantile(a.map((point) => point.hag), 0.95)))[0];
  const highCut = quantile(selected.map((point) => point.hag), 0.995) + 0.1;
  const robust = selected.filter((point) => point.hag <= highCut);
  const p70 = quantile(robust.map((point) => point.hag), 0.7);
  const upper = robust.filter((point) => point.hag >= p70);
  const weight = upper.reduce((sum, point) => sum + Math.max(point.hag, 0.15), 0);
  const apex = [...robust].sort((a, b) => b.hag - a.hag)[0];
  return {
    status: 'matched', pointIds: robust.map((point) => point.id), pointCount: robust.length,
    x: upper.reduce((sum, point) => sum + point.x * Math.max(point.hag, 0.15), 0) / weight,
    y: upper.reduce((sum, point) => sum + point.y * Math.max(point.hag, 0.15), 0) / weight,
    heightP99M: quantile(robust.map((point) => point.hag), 0.99), heightMaxValidM: apex.hag,
    apexX: apex.x, apexY: apex.y, apexZ: apex.z,
    localGroundZ: quantile(robust.map((point) => point.z - point.hag), 0.5),
    confidence: Math.min(1, robust.length / 30) * Math.min(1, components.length === 1 ? 1 : 0.8),
  };
}

export function pointInPolygon(point: Point2, polygon: Polygon): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [xi, yi] = polygon[index];
    const [xj, yj] = polygon[previous];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function strictCrossViewRecovery(polygon: Polygon, candidates: readonly { crownId: string; projectedCentre: Point2; projectedApex: Point2 }[]): { status: 'matched'; crownId: string } | { status: 'missing'; reason: MissingHeightReason } {
  const inside = candidates.filter((candidate) => pointInPolygon(candidate.projectedCentre, polygon) || pointInPolygon(candidate.projectedApex, polygon));
  if (inside.length === 1) return { status: 'matched', crownId: inside[0].crownId };
  return { status: 'missing', reason: inside.length > 1 ? 'ambiguous_cross_view_match' : 'no_direct_lidar_support' };
}

function pointSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length2 = dx * dx + dy * dy;
  const fraction = length2 ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length2)) : 0;
  return Math.hypot(point[0] - (start[0] + dx * fraction), point[1] - (start[1] + dy * fraction));
}

export function boundedNeighbourhoodRecovery(points: readonly LidarPoint[], rayStart: Point2, rayEnd: Point2, existing: readonly { crownId: string; x: number; y: number }[]): { association: LidarAssociation; recovery: 'merge_existing' | 'new_cluster_review' | 'missing'; existingCrownId?: string } {
  const bounded = points.filter((point) => point.hag >= PINE_STOCKTAKE_CONFIG.rayMinHagM && point.hag <= PINE_STOCKTAKE_CONFIG.rayMaxHagM && pointSegmentDistance([point.x, point.y], rayStart, rayEnd) <= PINE_STOCKTAKE_CONFIG.rayNeighbourhoodRadiusM);
  const association = selectCrownCluster(bounded);
  if (association.status === 'missing') return { association: { status: 'missing', reason: 'no_bounded_neighbourhood_cluster', detail: association.detail }, recovery: 'missing' };
  const matches = existing.filter((item) => Math.hypot(item.x - association.x, item.y - association.y) <= PINE_STOCKTAKE_CONFIG.duplicateRadiusM);
  if (matches.length === 1) return { association, recovery: 'merge_existing', existingCrownId: matches[0].crownId };
  if (matches.length > 1) return { association: { status: 'missing', reason: 'ambiguous_cross_view_match', detail: 'Cluster is within duplicate radius of multiple accepted crowns' }, recovery: 'missing' };
  return { association, recovery: 'new_cluster_review' };
}

export function createReviewRevision(input: Omit<ReviewRevision, 'reviewedAt'> & { reviewedAt?: string }): ReviewRevision {
  if (input.polygon.length < 3 && input.action !== 'delete') throw new Error('review polygon is degenerate');
  return Object.freeze({ ...input, polygon: input.polygon.map((point) => Object.freeze([...point] as Point2)), reviewedAt: input.reviewedAt ?? new Date().toISOString() });
}

export function acceptCrown(params: { crownId: string; sourceImageId: string; sourceImageSha256: string; group: AgreementGroup | null; revisions: readonly ReviewRevision[] }): AcceptedCrown {
  const accepted = [...params.revisions].reverse().find((revision) => revision.reviewState === 'accepted' && revision.action === 'accept');
  if (!accepted) throw new Error('only an accepted review revision can enter stock mapping');
  const lineage: string[] = [];
  let current: ReviewRevision | undefined = accepted;
  const byId = new Map(params.revisions.map((revision) => [revision.revisionId, revision]));
  while (current) {
    lineage.unshift(current.revisionId);
    current = current.parentRevisionId ? byId.get(current.parentRevisionId) : undefined;
  }
  return Object.freeze({
    crownId: params.crownId, sourceImageId: params.sourceImageId, sourceImageSha256: params.sourceImageSha256,
    nativePolygon: accepted.polygon, contributingExemplarIds: params.group?.exemplarIds ?? [], scoresByExemplar: params.group?.scoresByExemplar ?? {},
    agreementLevel: params.group?.agreementLevel ?? 0, reviewerId: accepted.reviewerId, reviewedAt: accepted.reviewedAt,
    revisionLineage: lineage, edgeClipped: accepted.edgeClipped, reviewState: 'accepted' as const,
  });
}

export interface StockObservation { crownId: string; sourceImageId: string; x: number; y: number; lidar: boolean; lineage: readonly string[]; heightP99M?: number; apex?: Point3; localGroundZ?: number; missingReason?: MissingHeightReason }
export interface StockRecord { stockId: string; x: number; y: number; locationSource: 'lidar' | 'flat_map_approximate'; observations: readonly StockObservation[]; lineage: readonly string[]; heightP99M: number | null; apex: Point3 | null; localGroundZ: number | null; missingReason: MissingHeightReason | null }

export function deduplicateObservations(observations: readonly StockObservation[], radiusM = PINE_STOCKTAKE_CONFIG.duplicateRadiusM): StockRecord[] {
  const clusters: StockObservation[][] = [];
  for (const observation of [...observations].sort((a, b) => Number(b.lidar) - Number(a.lidar) || a.crownId.localeCompare(b.crownId))) {
    const match = clusters.find((cluster) => !cluster.some((member) => member.sourceImageId === observation.sourceImageId) && Math.hypot(cluster[0].x - observation.x, cluster[0].y - observation.y) <= radiusM);
    if (match) match.push(observation); else clusters.push([observation]);
  }
  return clusters.map((cluster, index) => {
    const lidar = cluster.filter((item) => item.lidar);
    const primary = lidar.length ? lidar : cluster;
    const orderedX = primary.map((item) => item.x).sort((a, b) => a - b);
    const orderedY = primary.map((item) => item.y).sort((a, b) => a - b);
    const middle = Math.floor(primary.length / 2);
    const heights = lidar.flatMap((item) => item.heightP99M == null ? [] : [item.heightP99M]).sort((a, b) => a - b);
    const apexRows = lidar.filter((item) => item.apex).sort((a, b) => b.apex![2] - a.apex![2]);
    const grounds = lidar.flatMap((item) => item.localGroundZ == null ? [] : [item.localGroundZ]).sort((a, b) => a - b);
    return {
      stockId: `sapling-${String(index + 1).padStart(5, '0')}`, x: orderedX[middle], y: orderedY[middle], locationSource: lidar.length ? 'lidar' : 'flat_map_approximate',
      observations: cluster, lineage: [...new Set(cluster.flatMap((item) => [item.crownId, ...item.lineage]))].sort(),
      heightP99M: heights.length ? heights[Math.floor(heights.length / 2)] : null, apex: apexRows[0]?.apex ?? null,
      localGroundZ: grounds.length ? grounds[Math.floor(grounds.length / 2)] : null,
      missingReason: heights.length ? null : cluster.find((item) => item.missingReason)?.missingReason ?? 'no_bounded_neighbourhood_cluster',
    };
  });
}

function csvEscape(value: unknown): string {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportStockCsv(records: readonly StockRecord[]): string {
  const fields = ['stock_id', 'x', 'y', 'location_source', 'height_p99_m', 'apex_x', 'apex_y', 'apex_z', 'local_ground_z', 'missing_reason', 'lineage'];
  const rows = records.map((record) => [record.stockId, record.x, record.y, record.locationSource, record.heightP99M, record.apex?.[0], record.apex?.[1], record.apex?.[2], record.localGroundZ, record.missingReason, record.lineage]);
  return [fields, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

export function exportStockGeoJson(records: readonly StockRecord[], crs: string) {
  if (!/^EPSG:\d+$/.test(crs)) throw new Error('unknown CRS');
  return { type: 'FeatureCollection' as const, crs: { type: 'name', properties: { name: crs } }, features: records.map((record) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [record.x, record.y] }, properties: { ...record, observations: record.observations, flatMapApproximate: record.locationSource === 'flat_map_approximate' } })) };
}

export interface StageState { completed: readonly string[]; attempts: Readonly<Record<string, number>>; reviewRevisionCount: number }
export function applyRestartableStage(state: StageState, stage: string, idempotencyKey: string): StageState {
  const token = `${stage}:${idempotencyKey}`;
  if (state.completed.includes(token)) return state;
  return { completed: [...state.completed, token], attempts: { ...state.attempts, [stage]: (state.attempts[stage] ?? 0) + 1 }, reviewRevisionCount: state.reviewRevisionCount };
}
