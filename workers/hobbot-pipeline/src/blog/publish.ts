// Promote action: build frontmatter + commit to GitHub
// Called by the review endpoint after human approval, not by the pipeline.

import type { BlogPostRow } from './types'

function buildFrontmatter(post: BlogPostRow): string {
  const tags: string[] = JSON.parse(post.tags || '[]')
  const tagLines = tags.map(t => `  - ${t}`).join('\n')
  const publishedAt = post.published_at ?? new Date().toISOString()

  const lines = [
    '---',
    `title: ${JSON.stringify(post.title)}`,
    `excerpt: ${JSON.stringify(post.excerpt)}`,
    'author: d00d',
    `category: ${post.category}`,
    `tags:`,
    tagLines || '  []',
  ]

  if (post.arrangement) lines.push(`arrangement: ${post.arrangement}`)

  lines.push(
    `publishedAt: ${publishedAt.split('T')[0]}`,
    'draft: false',
    'featured: false',
    '---',
  )

  return lines.join('\n')
}

// UTF-8-safe base64 for Workers runtime
function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
}

export async function promoteToGitHub(
  post: BlogPostRow,
  githubToken: string,
  db: D1Database
): Promise<{ sha: string }> {
  const frontmatter = buildFrontmatter(post)
  const fileContent = `${frontmatter}\n\n${post.body_md}\n`
  const path = `src/content/blog/${post.slug}.md`

  const body = {
    message: `blog: ${post.title}`,
    content: toBase64(fileContent),
    branch: 'main',
  }

  // TODO: if file already exists (re-promote/update), GET the existing SHA first
  // and include it as "sha" in the PUT body, otherwise GitHub returns 422.
  const response = await fetch(
    `https://api.github.com/repos/HobFarm/hobfarm/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'hobbot-worker',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(body),
    }
  )

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errText}`)
  }

  const data = (await response.json()) as { content: { sha: string } }
  const sha = data.content.sha

  await db
    .prepare(
      `UPDATE blog_posts
       SET github_sha = ?, status = 'published', published_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(sha, post.id)
    .run()

  return { sha }
}
