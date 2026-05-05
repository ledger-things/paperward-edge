import { Hono } from "hono";

const app = new Hono();
app.get("/", (c) => c.text("Paperward edge — placeholder"));
export default app;
