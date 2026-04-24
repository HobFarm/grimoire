// Grimoire tool catalog for chat tool-use loop.
// Tool definitions come from shared manifests (single source of truth).
// Handlers are chat-specific: they call GrimoireHandle and extract refs.

import { GRIMOIRE_MANIFESTS, toChatToolDef } from '@shared/tools'
import type { ChatToolDef } from '@shared/tools'
import type { GrimoireHandle } from '@shared/grimoire/types'

export interface GrimoireTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  execute: (handle: GrimoireHandle, input: Record<string, unknown>) => Promise<{ result: string; refs: string[] }>
}

function extractRefs(data: unknown): string[] {
  const refs: string[] = []
  if (!data || typeof data !== 'object') return refs

  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object' && 'id' in item) {
        refs.push(item.id as string)
      }
      refs.push(...extractRefs(item))
    }
  } else {
    const obj = data as Record<string, unknown>
    if ('id' in obj && typeof obj.id === 'string') refs.push(obj.id)
    if ('atom' in obj) refs.push(...extractRefs(obj.atom))
    if ('correspondences' in obj) refs.push(...extractRefs(obj.correspondences))
    if ('category_siblings' in obj) refs.push(...extractRefs(obj.category_siblings))
  }

  return [...new Set(refs)]
}

// Chat-specific handlers keyed by tool name.
// These call GrimoireHandle methods and extract atom refs for the UI.
const CHAT_HANDLERS: Record<string, GrimoireTool['execute']> = {
  grimoire_search: async (handle, input) => {
    const result = await handle.search(
      input.q as string,
      {
        category: input.category as string | undefined,
        collection: input.collection as string | undefined,
        limit: (input.limit as number) ?? 20,
      },
    )
    return { result: JSON.stringify(result, null, 2), refs: extractRefs(result) }
  },

  grimoire_lookup: async (handle, input) => {
    const result = await handle.lookup(input.term as string)
    if (!result) return { result: JSON.stringify({ error: 'not_found' }), refs: [] }
    return { result: JSON.stringify(result, null, 2), refs: [result.id] }
  },

  grimoire_recommend: async (handle, input) => {
    const result = await handle.recommend(input.intent as string, input.arrangement as string | undefined)
    return { result: JSON.stringify(result, null, 2), refs: extractRefs(result) }
  },

  grimoire_correspondences: async (handle, input) => {
    const result = await handle.correspondences(input.term as string, (input.depth as number) ?? 2)
    return { result: JSON.stringify(result, null, 2), refs: extractRefs(result) }
  },

  grimoire_arrangements: async (handle) => {
    const result = await handle.arrangements()
    return { result: JSON.stringify(result, null, 2), refs: [] }
  },

  grimoire_categories: async (handle) => {
    const result = await handle.categories()
    return { result: JSON.stringify(result, null, 2), refs: [] }
  },

  grimoire_document_search: async (handle, input) => {
    const result = await handle.documentChunkSearch(
      input.query as string,
      {
        category: input.category as string | undefined,
        arrangement: input.arrangement as string | undefined,
        document_id: input.document_id as string | undefined,
        limit: (input.limit as number) ?? 20,
      },
    )
    return { result: JSON.stringify(result, null, 2), refs: extractRefs(result) }
  },

  grimoire_stats: async (handle) => {
    const result = await handle.stats()
    return { result: JSON.stringify(result, null, 2), refs: [] }
  },
}

// Generate tool catalog from shared manifests + chat-specific handlers
const chatDefs = GRIMOIRE_MANIFESTS
  .filter(m => m.surfaces.includes('chat'))
  .map(toChatToolDef)

export const TOOL_CATALOG: GrimoireTool[] = chatDefs.map((def: ChatToolDef) => {
  const handler = CHAT_HANDLERS[def.name]
  if (!handler) throw new Error(`No chat handler for manifest tool: ${def.name}`)
  return { ...def, execute: handler }
})

// Build Workers AI / OpenAI-format tools array
export function getWorkersAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return TOOL_CATALOG.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
}

// Execute a tool by name
export async function executeTool(
  handle: GrimoireHandle,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ result: string; refs: string[] } | null> {
  const tool = TOOL_CATALOG.find(t => t.name === toolName)
  if (!tool) return null
  return tool.execute(handle, input)
}
