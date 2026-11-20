// Test-only: lets Node load "cloudflare:workers" (imported by the OAuth library) from a stub.
import { registerHooks } from "node:module";

const STUB = new URL("./cloudflare-workers-stub.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
