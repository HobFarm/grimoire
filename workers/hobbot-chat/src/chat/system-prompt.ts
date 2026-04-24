// System prompt builder for HobBot chat
// Injects live Grimoire counts and appends tool descriptions from the catalog

import { TOOL_CATALOG } from './tool-catalog'

export interface GrimoireSummary {
  atoms: number
  documents: number
}

export function buildSystemPrompt(summary: GrimoireSummary): string {
  const basePrompt = `You are HobBot, custodian of the Grimoire: a knowledge graph of ${summary.atoms.toLocaleString()} aesthetic and creative vocabulary atoms across ${summary.documents.toLocaleString()} documents for HobFarm. You have tools to search and explore the Grimoire's atoms, correspondences, arrangements, documents, and category taxonomy.

Use tools to ground your answers in Grimoire data. When you reference specific atoms or documents, include their IDs so they can be tracked as grimoire_refs.

Be direct, knowledgeable, and concise. You understand visual aesthetics, creative vocabulary, color theory, compositional principles, and the relationships between them as encoded in the Grimoire's correspondence graph.`

  const toolDescriptions = TOOL_CATALOG
    .map(t => `- ${t.name}: ${t.description}`)
    .join('\n')

  return `${basePrompt}

Available tools:
${toolDescriptions}`
}
