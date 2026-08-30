# Prep.via — Vercel Ready

Upload this project to the GitHub repository connected to Vercel.

## Structure
- `public/index.html` — website
- `api/create-order.js` — Razorpay order creation
- `api/verify-payment.js` — server-side payment verification + fulfilment
- `api/razorpay-webhook.js` — Razorpay payment.captured webhook

## Vercel Environment Variables
Add all variables from `.env.example` in Vercel Project → Settings → Environment Variables. Never commit `.env`.

## Razorpay webhook
Configure a webhook URL: `https://YOUR-DOMAIN.com/api/razorpay-webhook` and enable `payment.captured`. Use the same value as `RAZORPAY_WEBHOOK_SECRET`.

## Email
Use an SMTP mailbox. The package link is taken from `PACKAGE_LINK`.

## Meta
Set `META_PIXEL_ID` and `META_ACCESS_TOKEN`. Browser Purchase and server Purchase use the Razorpay payment ID as event ID for deduplication.

## Deploy
Commit/push these files to GitHub. Vercel will install dependencies and deploy the `/api` functions automatically.
