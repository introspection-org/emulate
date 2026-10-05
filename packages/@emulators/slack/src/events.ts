import { randomUUID } from "node:crypto";
import type { Context, Store, WebhookDispatcher } from "@emulators/core";
import type { SlackChannel } from "./entities.js";
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

interface SlackEventEnvelope {
  type: "event_callback";
  team_id: string;
  event: Record<string, unknown>;
  [key: string]: unknown;
}

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

  webhooks.dispatch = async (event, action, payload, owner, repo) => {
    if (owner !== "slack" || !isSlackEventEnvelope(payload)) {
      await dispatch(event, action, payload, owner, repo);
      return;
    }

    const installation = ss()
      .installations.all()
      .find((candidate) => candidate.team_id === payload.team_id);
    const inner = { ...payload.event };
    const isMessage = inner.type === "message" || inner.type === "app_mention";
    const channelId = typeof inner.channel === "string" ? inner.channel : undefined;
    const channel = isMessage && channelId ? ss().channels.findOneBy("channel_id", channelId) : undefined;
    const author =
      isMessage && typeof inner.user === "string" ? ss().users.findOneBy("user_id", inner.user) : undefined;

    if (channel && inner.type === "message" && inner.channel_type === undefined) {
      inner.channel_type = slackChannelType(channel);
    }
    if (author && author.team_id !== payload.team_id) {
      inner.user_team ??= author.team_id;
      inner.source_team ??= author.team_id;
    }

    const envelope = {
      ...payload,
      ...(installation
        ? {
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
          }
        : {}),
      event: inner,
    };
    await dispatch(event, action, envelope, owner, repo);

    if (inner.type !== "message" || inner.subtype !== undefined || inner.bot_id !== undefined) return;
    const text = typeof inner.text === "string" ? inner.text : "";
    for (const mentioned of ss()
      .installations.all()
      .filter((candidate) => candidate.team_id === payload.team_id)) {
      if (inner.user === mentioned.bot_user_id || !text.includes(`<@${mentioned.bot_user_id}>`)) continue;
      const { channel_type: _channelType, ...mention } = inner;
      await dispatch(
        "app_mention",
        action,
        {
          ...buildSlackEventEnvelope(payload.team_id, { ...mention, type: "app_mention", event_ts: inner.ts }),
          api_app_id: mentioned.app_id,
          authorizations: [
            {
              enterprise_id: null,
              team_id: mentioned.team_id,
              user_id: mentioned.bot_user_id,
              is_bot: true,
              is_enterprise_install: false,
            },
          ],
        },
        owner,
        repo,
      );
    }
  };
}
