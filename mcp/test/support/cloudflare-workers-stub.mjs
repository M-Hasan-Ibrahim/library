// Minimal stand-in for the Workers runtime module, for Node tests only.
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export const env = {};
