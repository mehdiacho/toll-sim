import { createMomoApp } from "./app.js";

const secret = process.env.MOMO_WEBHOOK_SECRET;
if (!secret) throw new Error("MOMO_WEBHOOK_SECRET must be set");

const app = createMomoApp({
  secret,
  callbackDelayMs: Number(process.env.MOMO_CALLBACK_DELAY_MS ?? 1500),
  logger: true,
});
await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? "0.0.0.0" });
