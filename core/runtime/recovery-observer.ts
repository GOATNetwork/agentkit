import type { ActionContext, ActionRecovery } from '../schema/action';

/** Notify without letting a caller's observer mutate evidence or block an action. */
export function notifyRecovery(ctx: Pick<ActionContext, 'checkpointRecovery'>, recovery: ActionRecovery): void {
  try {
    const observer = ctx.checkpointRecovery;
    if (!observer) return;
    // Attach the rejection handler immediately. Async observers are allowed by
    // the void callback contract, but must never become unhandled rejections.
    void Promise.resolve(Reflect.apply(observer, ctx, [structuredClone(recovery)])).catch(() => {});
  } catch {
    // Notifications are best-effort; persistence belongs in the recovery store.
  }
}
