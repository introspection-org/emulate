import { randomUUID } from "node:crypto";
import type { Context, Store, WebhookDispatcher } from "@emulators/core";
import type { EnvelopedEvent } from "@slack/bolt";
import type { AppMentionEvent, GenericMessageEvent } from "@slack/types";
import type { SlackChannel, SlackInstallation } from "./entities.js";
import { getSlackStore } from "./store.js";

export function buildSlackEventEnvelope(teamId: string, event: Record<string, unknown>) {
  return {
    type: "event_callback" as const,
    team_id: teamId,
    event_id: `Ev${randomUUID().replaceAll("-", "")}`,
    event_time: Math.floor(Date.now() / 1000),
    event,
  };
}

export function resolveSlackEventTeamId(c: Context, store: Store, fallbackTeamId?: string): string {
  const slackStore = getSlackStore(store);
  const token = c.get("authToken");
  const tokenTeamId = token ? slackStore.tokens.findOneBy("token", token)?.team_id : undefined;
  return tokenTeamId ?? fallbackTeamId ?? slackStore.teams.all()[0]?.team_id ?? "T000000001";
}

export function slackChannelType(channel: SlackChannel): "channel" | "group" | "im" | "mpim" {
  if (channel.is_im) return "im";
  if (channel.is_mpim) return "mpim";
  return channel.is_private ? "group" : "channel";
}

/** Slack's deprecated verification token, which every envelope and interaction payload still carries. */
export const SLACK_VERIFICATION_TOKEN = "emulate";

interface SlackEventEnvelope {
  type: "event_callback";
  team_id: string;
  event: Record<string, unknown>;
  [key: string]: unknown;
}

/** What Slack adds to the envelope for the app an event is delivered to. */
type InstalledAppEnvelope = Pick<EnvelopedEvent, "token" | "api_app_id" | "authorizations" | "is_ext_shared_channel">;

/**
 * Slack Connect: the author's own workspace. `@slack/types` declares both on
 * `AppMentionEvent` and on neither message event type; they are set on the
 * message as well so an app reading either event sees the same author.
 */
type AuthorTeamFields = Pick<AppMentionEvent, "user_team" | "source_team">;

function isSlackEventEnvelope(payload: unknown): payload is SlackEventEnvelope {
  if (!payload || typeof payload !== "object") return false;
  const envelope = payload as Record<string, unknown>;
  return envelope.type === "event_callback" && typeof envelope.event === "object" && envelope.event !== null;
}

/**
 * Completes every Slack event on its way out with what Slack adds outside the
 * route that raised it: the installed app on the envelope, the conversation
 * type and the author's workspace on a message, and the `app_mention` an app
 * receives when a message names its bot user.
 */
export function installSlackEventEnrichment(store: Store, webhooks: WebhookDispatcher): void {
  const ss = () => getSlackStore(store);
  const dispatch = webhooks.dispatch.bind(webhooks);
  const appEnvelope = (installation: SlackInstallation, channel: SlackChannel | undefined): InstalledAppEnvelope => ({
    token: SLACK_VERIFICATION_TOKEN,
    api_app_id: installation.app_id,
    authorizations: [
      {
        enterprise_id: null,
        team_id: installation.team_id,
        user_id: installation.bot_user_id,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
    ...(channel?.is_ext_shared ? { is_ext_shared_channel: true } : {}),
  });

  webhooks.dispatch = async (event, action, payload, owner, repo) => {
    if (owner !== "slack" || !isSlackEventEnvelope(payload)) {
      await dispatch(event, action, payload, owner, repo);
      return;
    }

    const installations = ss()
      .installations.all()
      .filter((candidate) => candidate.team_id === payload.team_id);
    const inner = { ...payload.event };
    const channelId = typeof inner.channel === "string" ? inner.channel : undefined;
    const channel = channelId ? ss().channels.findOneBy("channel_id", channelId) : undefined;
    const isMessage = inner.type === "message";
    const author =
      isMessage && typeof inner.user === "string" ? ss().users.findOneBy("user_id", inner.user) : undefined;

    if (isMessage && channel && inner.channel_type === undefined) {
      inner.channel_type = slackChannelType(channel) satisfies GenericMessageEvent["channel_type"];
    }
    if (isMessage && inner.event_ts === undefined && typeof inner.ts === "string") {
      inner.event_ts = inner.ts satisfies GenericMessageEvent["event_ts"];
    }
    const authorTeam: AuthorTeamFields =
      author && author.team_id !== payload.team_id ? { user_team: author.team_id, source_team: author.team_id } : {};
    Object.assign(inner, authorTeam);

    const envelope = {
      ...payload,
      ...(installations[0] ? appEnvelope(installations[0], channel) : {}),
      event: inner,
    };
    await dispatch(event, action, envelope, owner, repo);

    if (!isMessage || inner.subtype !== undefined || inner.bot_id !== undefined) return;
    if (typeof inner.text !== "string" || typeof inner.ts !== "string" || !channelId) return;
    for (const mentioned of installations) {
      if (inner.user === mentioned.bot_user_id || !inner.text.includes(`<@${mentioned.bot_user_id}>`)) continue;
      const mention: AppMentionEvent = {
        type: "app_mention",
        ...(typeof inner.user === "string" ? { user: inner.user } : {}),
        text: inner.text,
        ts: inner.ts,
        channel: channelId,
        event_ts: inner.ts,
        ...(typeof inner.thread_ts === "string" ? { thread_ts: inner.thread_ts } : {}),
        ...(typeof inner.client_msg_id === "string" ? { client_msg_id: inner.client_msg_id } : {}),
        ...(Array.isArray(inner.blocks) ? { blocks: inner.blocks as AppMentionEvent["blocks"] } : {}),
        ...(Array.isArray(inner.attachments)
          ? { attachments: inner.attachments as AppMentionEvent["attachments"] }
          : {}),
        ...authorTeam,
      };
      await dispatch(
        "app_mention",
        action,
        { ...buildSlackEventEnvelope(payload.team_id, { ...mention }), ...appEnvelope(mentioned, channel) },
        owner,
        repo,
      );
    }
  };
}
