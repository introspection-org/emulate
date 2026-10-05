import { timingSafeEqual } from "crypto";
import type { RouteContext } from "@emulators/core";
import { buildSlackEventEnvelope } from "../events.js";
import { parseSlackBody, slackError, slackOk } from "../helpers.js";
import { getSlackStore } from "../store.js";

export function appsRoutes(ctx: RouteContext): void {
  const { app, store, webhooks, tokenMap } = ctx;
  const ss = () => getSlackStore(store);

  // apps.uninstall
  app.post("/api/apps.uninstall", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const clientId = typeof body.client_id === "string" ? body.client_id : "";
    const clientSecret = typeof body.client_secret === "string" ? body.client_secret : "";
    const oauthApp = ss().oauthApps.findOneBy("client_id", clientId);
    if (!oauthApp) return slackError(c, "invalid_client_id");
    if (!secretsEqual(clientSecret, oauthApp.client_secret)) return slackError(c, "bad_client_secret");

    const authToken = c.get("authToken");
    const tokenRecord = authToken ? ss().tokens.findOneBy("token", authToken) : undefined;
    const teamId = tokenRecord?.team_id ?? ss().teams.all()[0]?.team_id ?? "T000000001";
    const installation = ss()
      .installations.all()
      .find((candidate) => candidate.client_id === clientId && candidate.team_id === teamId);
    if (!installation) return slackError(c, "app_not_installed");

    const revoked = ss()
      .tokens.all()
      .filter((token) => token.team_id === teamId && token.app_id === installation.app_id);
    for (const token of revoked) {
      ss().tokens.delete(token.id);
      tokenMap?.delete(token.token);
    }

    // The installation outlives both events so each still names the app it is about.
    const dispatch = (event: Record<string, unknown>) =>
      webhooks.dispatch(String(event.type), undefined, buildSlackEventEnvelope(teamId, event), "slack");
    await dispatch({ type: "app_uninstalled" });
    await dispatch({
      type: "tokens_revoked",
      tokens: {
        oauth: revoked.filter((token) => token.token_type === "user").map((token) => token.user_id),
        bot: [installation.bot_user_id],
      },
    });
    ss().installations.delete(installation.id);

    return slackOk(c, {});
  });
}

function secretsEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
