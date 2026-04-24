export const VALID_MODALITIES = ['visual', 'narrative', 'both'] as const

export const HARMONIC_DIMENSIONS = [
  'hardness', 'temperature', 'weight', 'formality', 'era_affinity',
] as const

export type HarmonicDimension = typeof HARMONIC_DIMENSIONS[number]

export const HARMONIC_DEFAULTS: Record<string, number> = {
  hardness: 0.5,
  temperature: 0.5,
  weight: 0.5,
  formality: 0.5,
  era_affinity: 0.5,
}

export const VALID_UTILITIES = ['visual', 'literary', 'dual'] as const
