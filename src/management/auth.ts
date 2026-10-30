import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { equalSecret, hash, token } from "../runtime/index.js";
import { Fault } from "./schema.js";

export class OperatorAuth {
  private invitations = new Map<string, number>();
  private sessions = new Map<string, { csrf: string; expires: number }>();
  issue(): string {
    const value = token();
    this.invitations.set(hash(value), Date.now() + 15 * 60_000);
    return value;
  }
  redeem(c: Context, value: string): { csrf: string } {
    const digest = hash(value);
    const expiry = this.invitations.get(digest);
    if (!expiry || expiry < Date.now())
      throw new Fault("SIGN_IN_EXPIRED", "The sign-in link has expired or was already used.", 401);
    this.invitations.delete(digest);
    const id = token();
    const session = { csrf: token(), expires: Date.now() + 12 * 60 * 60_000 };
    this.sessions.set(hash(id), session);
    setCookie(c, "orgactor_operator", id, {
      httpOnly: true,
      sameSite: "Strict",
      secure: new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: 12 * 60 * 60,
    });
    return { csrf: session.csrf };
  }
  read(c: Context): { csrf: string } {
    const id = getCookie(c, "orgactor_operator");
    const session = id ? this.sessions.get(hash(id)) : undefined;
    if (!session || session.expires < Date.now())
      throw new Fault("SIGN_IN_REQUIRED", "Open a current operator sign-in link.", 401);
    return { csrf: session.csrf };
  }
  origin(c: Context): void {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin)
      throw new Fault(
        "ORIGIN_REJECTED",
        "This request must come from the console's own origin.",
        403,
      );
    const site = c.req.header("Sec-Fetch-Site");
    if (site === "cross-site")
      throw new Fault("ORIGIN_REJECTED", "Cross-site operator requests are refused.", 403);
  }
  verify(c: Context): void {
    const session = this.read(c);
    this.origin(c);
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      !equalSecret(c.req.header("X-CSRF-Token") ?? "", session.csrf)
    )
      throw new Fault("CSRF_REJECTED", "Refresh the console session before making changes.", 403);
  }
  logout(c: Context): void {
    const id = getCookie(c, "orgactor_operator");
    if (id) this.sessions.delete(hash(id));
    deleteCookie(c, "orgactor_operator", { path: "/" });
  }
}
