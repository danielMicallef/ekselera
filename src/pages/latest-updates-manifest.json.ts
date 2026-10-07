import { publishedUpdates } from '../features/latest-updates/content';
export const prerender=true;
export async function GET() {
 const posts=await publishedUpdates();
 return new Response(JSON.stringify({version:1,posts:posts.map(({data})=>({postId:data.postId,url:`/latest-updates/${data.slug}/`,contentDigest:data.contentDigest,media:data.media.map(({url,digest})=>({url,digest}))}))}),{headers:{'Content-Type':'application/json','Cache-Control':'no-cache'}});
}
