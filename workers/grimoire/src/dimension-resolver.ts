import { safeParseJSON } from './arrangement-tagger'

export interface DimensionAxis {
  slug: string
  label_low: string
  label_high: string
  harmonic_key: string
  description?: string | null
  active: number
}

export interface AtomCoordRow {
  id: string
  text_lower: string
  harmonics: string | null
  register: number | null
}

export function resolveDimensionPosition(
  axis: DimensionAxis,
  atom: AtomCoordRow,
): number | null {
  if (axis.harmonic_key === 'register') {
    return typeof atom.register === 'number' ? atom.register : null
  }
  if (!atom.harmonics) return null
  const parsed = safeParseJSON<Record<string, unknown>>(atom.harmonics, {})
  const value = parsed[axis.harmonic_key]
  return typeof value === 'number' ? value : null
}
