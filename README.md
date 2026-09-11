# Prepvia Education Authentication

Single-page Vite + Supabase auth designed for Vercel. This version intentionally uses **one index.html** and `./src/main.js`, avoiding Vercel/Vite multi-page path-resolution issues.

## GitHub root
index.html, package.json, supabase-schema.sql, .env.example, README.md, src/

## Supabase
1. Create/open your Supabase project.
2. SQL Editor -> run supabase-schema.sql.
3. Authentication -> Providers -> enable Email and Google.
4. Add your Vercel domain to Authentication URL Configuration and Redirect URLs.

## Vercel Environment Variables
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY

Do not put service-role/secret keys in the frontend or GitHub.

## Deploy
Vercel Build Command: npm run build
Output: dist
Framework: Vite
