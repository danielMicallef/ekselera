import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware((context, next) => {
  const url = new URL(context.request.url);
  
  if (url.hostname === "www.ekselera.com") {
    return Response.redirect(`https://ekselera.com${url.pathname}${url.search}`, 301);
  }
  
  return next();
});