// Make `cloudflare:test`'s `env` know about our Worker's bindings.
import type { Env } from "@/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
