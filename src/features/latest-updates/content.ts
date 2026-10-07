import { getCollection } from "astro:content";
export async function publishedUpdates() {
  const posts = await getCollection("updates");
  return posts.sort(
    (a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf(),
  );
}
