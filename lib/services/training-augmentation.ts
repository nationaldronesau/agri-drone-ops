interface AugmentationConfigInput {
  horizontalFlip?: unknown;
  horizontal_flip?: unknown;
  verticalFlip?: unknown;
  vertical_flip?: unknown;
  rotation?: unknown;
  rotation_degrees?: unknown;
  degrees?: unknown;
  brightness?: unknown;
  brightness_pct?: unknown;
  saturation?: unknown;
  saturation_pct?: unknown;
  hsv_v?: unknown;
  hsv_s?: unknown;
  blur?: unknown;
  shadow?: unknown;
  copiesPerImage?: unknown;
  copies_per_image?: unknown;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const toNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  return null;
};

const parseConfigObject = (value: unknown): AugmentationConfigInput | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as AugmentationConfigInput;
};

export function buildTrainingAugmentationFromInput(
  preset: string | null | undefined,
  rawConfig: unknown
): Record<string, unknown> | undefined {
  const config = parseConfigObject(rawConfig);
  const result: Record<string, unknown> = {};

  const normalizedPreset =
    typeof preset === 'string' && preset.trim() && preset !== 'none'
      ? preset
      : null;
  if (normalizedPreset) {
    result.preset = normalizedPreset;
  }

  const horizontalFlip = toBoolean(config?.horizontalFlip ?? config?.horizontal_flip);
  if (horizontalFlip !== null) {
    result.horizontal_flip = horizontalFlip;
    result.fliplr = horizontalFlip ? 0.5 : 0;
  }

  const verticalFlip = toBoolean(config?.verticalFlip ?? config?.vertical_flip);
  if (verticalFlip !== null) {
    result.vertical_flip = verticalFlip;
    result.flipud = verticalFlip ? 0.5 : 0;
  }

  const rotation = toNumber(
    config?.rotation ?? config?.rotation_degrees ?? config?.degrees
  );
  if (rotation !== null && rotation > 0) {
    result.rotation_degrees = clamp(rotation, 0, 180);
    result.degrees = clamp(rotation, 0, 180);
  }

  const brightnessFromHsv = toNumber(config?.hsv_v);
  const brightness = toNumber(config?.brightness ?? config?.brightness_pct);
  const brightnessPct =
    brightness !== null
      ? clamp(brightness, 0, 100)
      : brightnessFromHsv !== null
        ? clamp(brightnessFromHsv * 100, 0, 100)
        : null;
  if (brightnessPct !== null) {
    result.brightness_pct = brightnessPct;
    result.hsv_v = clamp(brightnessPct / 100, 0, 1);
  }

  const saturationFromHsv = toNumber(config?.hsv_s);
  const saturation = toNumber(config?.saturation ?? config?.saturation_pct);
  const saturationPct =
    saturation !== null
      ? clamp(saturation, 0, 100)
      : saturationFromHsv !== null
        ? clamp(saturationFromHsv * 100, 0, 100)
        : null;
  if (saturationPct !== null) {
    result.saturation_pct = saturationPct;
    result.hsv_s = clamp(saturationPct / 100, 0, 1);
  }

  const blur = toBoolean(config?.blur);
  if (blur !== null) {
    result.blur = blur;
  }

  const shadow = toBoolean(config?.shadow);
  if (shadow !== null) {
    result.shadow = shadow;
  }

  const copiesPerImage = toNumber(
    config?.copiesPerImage ?? config?.copies_per_image
  );
  if (copiesPerImage !== null) {
    result.copies_per_image = clamp(Math.round(copiesPerImage), 1, 10);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function buildTrainingAugmentationFromDataset(dataset: {
  augmentationPreset?: string | null;
  augmentationConfig?: string | null;
}): Record<string, unknown> | undefined {
  if (!dataset) return undefined;

  let parsedConfig: unknown = null;
  if (dataset.augmentationConfig) {
    try {
      parsedConfig = JSON.parse(dataset.augmentationConfig);
    } catch {
      parsedConfig = null;
    }
  }

  return buildTrainingAugmentationFromInput(
    dataset.augmentationPreset || null,
    parsedConfig
  );
}
