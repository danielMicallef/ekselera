import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

export const updates = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/updates" }),
  schema: z.object({
    postId: z.string().uuid(),
    slug: z.string().regex(/^[\p{L}\p{N}-]+$/u),
    title: z.string().min(1).max(180),
    authorId: z.string(),
    publishedAt: z.coerce.date(),
    summary: z.string().min(1).max(240),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    media: z
      .array(
        z.object({
          name: z.string(),
          url: z.string(),
          width: z.number().positive(),
          height: z.number().positive(),
          digest: z.string(),
        }),
      )
      .default([]),
  }),
});
