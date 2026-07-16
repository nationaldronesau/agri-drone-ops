export type CornerBox = [number, number, number, number];
export type PolygonPoint = [number, number];
export const GEOMETRY_MISMATCH_IOU_THRESHOLD = 0.85;

function isFinitePoint(point: number[]): point is PolygonPoint {
  return point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

export function getValidPolygon(polygon: number[][] | undefined): PolygonPoint[] | null {
  if (!Array.isArray(polygon) || polygon.length < 3 || !polygon.every(isFinitePoint)) {
    return null;
  }

  const points: PolygonPoint[] = polygon.map(([x, y]) => [x, y]);
  const signedDoubleArea = points.reduce((area, [x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length];
    return area + x * nextY - nextX * y;
  }, 0);

  return Math.abs(signedDoubleArea) > Number.EPSILON ? points : null;
}

export function getPolygonBoundingRect(polygon: number[][] | undefined): CornerBox | null {
  const validPolygon = getValidPolygon(polygon);
  if (!validPolygon) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [x, y] of validPolygon) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (maxX <= minX || maxY <= minY) return null;
  return [minX, minY, maxX, maxY];
}

export function calculateBoxIoU(
  first: CornerBox | number[] | undefined,
  second: CornerBox | number[] | undefined
): number | null {
  if (!first || !second || first.length < 4 || second.length < 4) return null;

  const [firstX1, firstY1, firstX2, firstY2] = first;
  const [secondX1, secondY1, secondX2, secondY2] = second;
  const coordinates = [
    firstX1,
    firstY1,
    firstX2,
    firstY2,
    secondX1,
    secondY1,
    secondX2,
    secondY2,
  ];
  if (!coordinates.every(Number.isFinite)) return null;

  const firstArea = (firstX2 - firstX1) * (firstY2 - firstY1);
  const secondArea = (secondX2 - secondX1) * (secondY2 - secondY1);
  if (firstArea <= 0 || secondArea <= 0) return null;

  const intersectionWidth = Math.max(
    0,
    Math.min(firstX2, secondX2) - Math.max(firstX1, secondX1)
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(firstY2, secondY2) - Math.max(firstY1, secondY1)
  );
  const intersectionArea = intersectionWidth * intersectionHeight;
  const unionArea = firstArea + secondArea - intersectionArea;

  return unionArea > 0 ? intersectionArea / unionArea : null;
}

export function calculatePolygonBoxIoU(
  bbox: CornerBox | number[] | undefined,
  polygon: number[][] | undefined
): number | null {
  const polygonRect = getPolygonBoundingRect(polygon);
  return polygonRect ? calculateBoxIoU(bbox, polygonRect) : null;
}
