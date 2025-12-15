/**
 * Detection Type Normalization Utility
 *
 * Ensures consistent naming of weed species and detection types across the platform.
 * This is critical for accurate filtering, grouping, and export operations.
 */

/**
 * Canonical detection type names
 * These are the standardized names used throughout the system
 */
export const CANONICAL_DETECTION_TYPES = {
  LANTANA: 'Lantana',
  WATTLE: 'Wattle',
  BELLYACHE_BUSH: 'Bellyache Bush',
  CALITROPIS: 'Calitropis',
  PINE_SAPLING: 'Pine Sapling',
  UNKNOWN: 'Unknown',
} as const;

export type CanonicalDetectionType = typeof CANONICAL_DETECTION_TYPES[keyof typeof CANONICAL_DETECTION_TYPES];

/**
 * Mapping of common variations to canonical names
 * Keys are lowercase for case-insensitive matching
 */
const DETECTION_TYPE_MAPPINGS: Record<string, string> = {
  // Lantana variations
  'lantana': CANONICAL_DETECTION_TYPES.LANTANA,
  'lantana camara': CANONICAL_DETECTION_TYPES.LANTANA,
  'lantana_camara': CANONICAL_DETECTION_TYPES.LANTANA,
  'lantana-camara': CANONICAL_DETECTION_TYPES.LANTANA,

  // Wattle variations
  'wattle': CANONICAL_DETECTION_TYPES.WATTLE,
  'acacia': CANONICAL_DETECTION_TYPES.WATTLE,
  'wattle tree': CANONICAL_DETECTION_TYPES.WATTLE,
  'wattle_tree': CANONICAL_DETECTION_TYPES.WATTLE,

  // Bellyache bush variations
  'bellyache bush': CANONICAL_DETECTION_TYPES.BELLYACHE_BUSH,
  'bellyache_bush': CANONICAL_DETECTION_TYPES.BELLYACHE_BUSH,
  'bellyache-bush': CANONICAL_DETECTION_TYPES.BELLYACHE_BUSH,
  'bellyachebush': CANONICAL_DETECTION_TYPES.BELLYACHE_BUSH,
  'jatropha': CANONICAL_DETECTION_TYPES.BELLYACHE_BUSH,
  'jatropha gossypifolia': CANONICAL_DETECTION_TYPES.BELLYACHE_BUSH,

  // Calitropis variations
  'calitropis': CANONICAL_DETECTION_TYPES.CALITROPIS,
  'calotropis': CANONICAL_DETECTION_TYPES.CALITROPIS,
  'calotropis procera': CANONICAL_DETECTION_TYPES.CALITROPIS,
  'rubber bush': CANONICAL_DETECTION_TYPES.CALITROPIS,
  'rubber_bush': CANONICAL_DETECTION_TYPES.CALITROPIS,

  // Pine sapling variations
  'pine sapling': CANONICAL_DETECTION_TYPES.PINE_SAPLING,
  'pine_sapling': CANONICAL_DETECTION_TYPES.PINE_SAPLING,
  'pine-sapling': CANONICAL_DETECTION_TYPES.PINE_SAPLING,
  'pine saplings': CANONICAL_DETECTION_TYPES.PINE_SAPLING,
  'pine-saplings': CANONICAL_DETECTION_TYPES.PINE_SAPLING,
  'pinesapling': CANONICAL_DETECTION_TYPES.PINE_SAPLING,
  'sapling': CANONICAL_DETECTION_TYPES.PINE_SAPLING,

  // Unknown/other
  'unknown': CANONICAL_DETECTION_TYPES.UNKNOWN,
  'other': CANONICAL_DETECTION_TYPES.UNKNOWN,
};

/**
 * Convert a string to title case
 * Example: "bellyache bush" -> "Bellyache Bush"
 */
function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Normalize a detection type string to its canonical form
 *
 * This function:
 * 1. Trims whitespace
 * 2. Checks against known mappings (case-insensitive)
 * 3. Falls back to title case if no mapping found
 *
 * @param rawType - The raw detection type string from the model
 * @returns The normalized detection type string
 */
export function normalizeDetectionType(rawType: string | null | undefined): string {
  if (!rawType || typeof rawType !== 'string') {
    return CANONICAL_DETECTION_TYPES.UNKNOWN;
  }

  // Trim and normalize whitespace
  const trimmed = rawType.trim().replace(/\s+/g, ' ');

  if (!trimmed) {
    return CANONICAL_DETECTION_TYPES.UNKNOWN;
  }

  // Check for exact match in mappings (case-insensitive)
  const lowerTrimmed = trimmed.toLowerCase();
  if (DETECTION_TYPE_MAPPINGS[lowerTrimmed]) {
    return DETECTION_TYPE_MAPPINGS[lowerTrimmed];
  }

  // Check for partial matches (e.g., "Lantana-something" should map to "Lantana")
  for (const [key, canonical] of Object.entries(DETECTION_TYPE_MAPPINGS)) {
    if (lowerTrimmed.startsWith(key) || key.startsWith(lowerTrimmed)) {
      return canonical;
    }
  }

  // No match found - return title case version of the original
  // This preserves new/unknown types while maintaining consistent formatting
  return toTitleCase(trimmed);
}

/**
 * Check if a detection type is a known/canonical type
 */
export function isKnownDetectionType(type: string): boolean {
  const normalized = normalizeDetectionType(type);
  return Object.values(CANONICAL_DETECTION_TYPES).includes(normalized as CanonicalDetectionType);
}

/**
 * Get all canonical detection types
 */
export function getAllCanonicalTypes(): string[] {
  return Object.values(CANONICAL_DETECTION_TYPES);
}
