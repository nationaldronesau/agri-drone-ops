export interface CenterBox {
  x: number; // Center X (pixels)
  y: number; // Center Y (pixels)
  width: number; // Box width (pixels)
  height: number; // Box height (pixels)
}

export interface YOLOPreprocessingMeta {
  originalWidth: number;
  originalHeight: number;
  inferenceWidth: number;
  inferenceHeight: number;
  letterbox: {
    enabled: boolean;
    padLeft: number;
    padTop: number;
    scale: number;
  } | null;
  tiling: {
    enabled: boolean;
    tileIndex: number;
    tileX: number;
    tileY: number;
    overlapPx: number;
  } | null;
}
