import { createHmac, randomUUID } from "crypto";
import type { Context, RouteContext } from "@emulators/core";
import type {
  SlackChannel,
  SlackInteractionDelivery,
  SlackInteractionType,
  SlackJsonObject,
  SlackMessage,
  SlackOAuthApp,
  SlackUser,
  SlackView,
} from "../entities.js";
import {
  createSlackViewTrigger,
  formatSlackMessage,
  formatSlackView,
  generateSlackId,
  generateTs,
} from "../helpers.js";
import { getSlackStore } from "../store.js";
import { parseSlackViewPayload } from "./views.js";

const MAX_INTERACTION_DELIVERIES = 1000;
const INTERACTION_TIMEOUT_MS = 10_000;

interface InteractiveElement {
  block: SlackJsonObject;
  element: SlackJsonObject;
  action_id: string;
}

/**
 * What a person does in a Slack client, which no Web API method can start:
 * clicking a Block Kit element, submitting a modal, and Slack retrying an
 * event. Each is sent to the app exactly as Slack sends it.
 */
export function simulatorRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);

  const findUser = (ref: unknown): SlackUser | undefined => {
    if (typeof ref !== "string" || !ref)
      return ss()
        .users.all()
        .find((user) => !user.is_bot && !user.deleted);
    return ss().users.findOneBy("user_id", ref) ?? ss().users.findOneBy("name", ref);
  };
  const findChannel = (ref: unknown): SlackChannel | undefined => {
    if (typeof ref !== "string" || !ref) return undefined;
    return ss().channels.findOneBy("channel_id", ref) ?? ss().channels.findOneBy("name", ref.replace(/^#/, ""));
  };
  const findApp = (appId: string | undefined, teamId: string): SlackOAuthApp | undefined => {
    const apps = ss().oauthApps.all();
    if (appId) return apps.find((candidate) => candidate.app_id === appId);
    const installed = ss()
      .installations.all()
      .find((installation) => installation.team_id === teamId);
    return apps.find((candidate) => candidate.app_id === installed?.app_id) ?? apps[0];
  };
  const teamRef = (teamId: string) => {
    const team = ss().teams.findOneBy("team_id", teamId);
    return { id: teamId, domain: team?.domain ?? "" };
  };
  const userRef = (user: SlackUser) => ({
    id: user.user_id,
    username: user.name,
    name: user.name,
    team_id: user.team_id,
  });

  async function deliver(
    type: SlackInteractionType,
    oauthApp: SlackOAuthApp,
    payload: SlackJsonObject,
    target: { team_id: string; user_id: string; channel_id?: string; view_id?: string },
  ): Promise<SlackInteractionDelivery> {
    const url = oauthApp.interactivity_url!;
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    const signingSecret = store.getData<string>("slack.signing_secret");
    if (signingSecret) {
      const timestamp = Math.floor(Date.now() / 1000);
      headers["X-Slack-Request-Timestamp"] = String(timestamp);
      headers["X-Slack-Signature"] =
        `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    }

    let statusCode: number | null = null;
    let success = false;
    let response: unknown = null;
    const started = Date.now();
    let duration: number | null = null;
    try {
      const result = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(INTERACTION_TIMEOUT_MS),
      });
      duration = Date.now() - started;
      statusCode = result.status;
      success = result.ok;
      const text = typeof result.text === "function" ? await result.text() : "";
      try {
        response = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        response = text;
      }
    } catch {
      duration = 0;
    }

    const delivery = ss().interactionDeliveries.insert({
      delivery_id: `Ia${randomUUID().replaceAll("-", "")}`,
      type,
      app_id: oauthApp.app_id ?? "",
      url,
      payload,
      status_code: statusCode,
      success,
      duration,
      response,
      delivered_at: new Date().toISOString(),
      ...target,
    });
    const all = ss().interactionDeliveries.all();
    for (const stale of all.slice(0, Math.max(0, all.length - MAX_INTERACTION_DELIVERIES))) {
      ss().interactionDeliveries.delete(stale.id);
    }
    return delivery;
  }

  const formatDelivery = (delivery: SlackInteractionDelivery) => ({
    id: delivery.delivery_id,
    type: delivery.type,
    url: delivery.url,
    status_code: delivery.status_code,
    success: delivery.success,
    duration: delivery.duration,
    response: delivery.response,
  });

  const simulateError = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ ok: false, error }, status);

  app.post("/_slack/simulate/block-actions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const channel = findChannel(body.channel);
    if (!channel) return simulateError(c, "channel_not_found", 404);
    const messageTs = typeof body.message_ts === "string" ? body.message_ts : "";
    const message = ss()
      .messages.findBy("ts", messageTs)
      .find((candidate) => candidate.channel_id === channel.channel_id);
    if (!message) return simulateError(c, "message_not_found", 404);
    const user = findUser(body.user);
    if (!user) return simulateError(c, "user_not_found", 404);

    const match = interactiveElements(message).find(
      ({ element, action_id }) =>
        (typeof body.action_id === "string" && body.action_id === action_id) ||
        (typeof body.text === "string" && body.text === elementLabel(element)) ||
        (typeof body.url === "string" && body.url === element.url),
    );
    if (!match) return simulateError(c, "action_not_found", 404);

    const oauthApp = findApp(message.app_id, channel.team_id);
    if (!oauthApp?.interactivity_url) return simulateError(c, "interactivity_not_configured");
    const appId = oauthApp.app_id ?? "";
    const trigger = createSlackViewTrigger(store, ss(), {
      team_id: channel.team_id,
      user_id: user.user_id,
      app_id: appId,
    });

    const { block, element, action_id } = match;
    const payload: SlackJsonObject = {
      type: "block_actions",
      user: userRef(user),
      api_app_id: appId,
      token: "emulate",
      container: {
        type: "message",
        message_ts: message.ts,
        channel_id: channel.channel_id,
        is_ephemeral: false,
        ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      },
      trigger_id: trigger.trigger_id,
      team: teamRef(channel.team_id),
      enterprise: null,
      is_enterprise_install: false,
      channel: { id: channel.channel_id, name: channel.is_private ? "privategroup" : channel.name },
      message: formatSlackMessage(message),
      state: { values: {} },
      actions: [
        {
          type: element.type,
          action_id,
          block_id: typeof block.block_id === "string" ? block.block_id : "",
          ...(element.text !== undefined ? { text: element.text } : {}),
          ...(element.value !== undefined ? { value: element.value } : {}),
          ...(element.url !== undefined ? { url: element.url } : {}),
          ...(element.style !== undefined ? { style: element.style } : {}),
          action_ts: generateTs(),
        },
      ],
    };

    const delivery = await deliver("block_actions", oauthApp, payload, {
      team_id: channel.team_id,
      user_id: user.user_id,
      channel_id: channel.channel_id,
    });
    return c.json({
      ok: delivery.success,
      action_id,
      trigger_id: trigger.trigger_id,
      delivery: formatDelivery(delivery),
    });
  });

  app.post("/_slack/simulate/view-submission", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const view = typeof body.view_id === "string" ? ss().views.findOneBy("view_id", body.view_id) : undefined;
    if (!view || view.type !== "modal") return simulateError(c, "view_not_found", 404);
    const user = findUser(body.user ?? view.user_id);
    if (!user) return simulateError(c, "user_not_found", 404);
    const oauthApp = findApp(view.app_id, view.team_id);
    if (!oauthApp?.interactivity_url) return simulateError(c, "interactivity_not_configured");

    const state = submittedState(view, body.values);
    if (state.error) return simulateError(c, state.error);
    const trigger = createSlackViewTrigger(store, ss(), {
      team_id: view.team_id,
      user_id: user.user_id,
      app_id: view.app_id,
      view_id: view.view_id,
    });

    const payload: SlackJsonObject = {
      type: "view_submission",
      team: teamRef(view.team_id),
      user: userRef(user),
      api_app_id: view.app_id,
      token: "emulate",
      trigger_id: trigger.trigger_id,
      view: { ...formatSlackView(view), state: { values: state.values } },
      response_urls: [],
      enterprise: null,
      is_enterprise_install: false,
    };

    const delivery = await deliver("view_submission", oauthApp, payload, {
      team_id: view.team_id,
      user_id: user.user_id,
      view_id: view.view_id,
    });
    const answer = isJsonObject(delivery.response) ? delivery.response : {};
    const action = typeof answer.response_action === "string" ? answer.response_action : null;
    let closed = false;
    let resultView: SlackView | undefined;

    if (delivery.success && action === "errors") {
      // The modal stays open with the app's errors on its blocks.
    } else if (delivery.success && (action === "update" || action === "push")) {
      const parsed = parseSlackViewPayload(answer.view, "modal");
      if (parsed.view && action === "update") {
        resultView = ss().views.update(view.id, {
          ...parsed.view,
          hash: generateTs(),
          updated: Math.floor(Date.now() / 1000),
        });
      } else if (parsed.view) {
        const now = Math.floor(Date.now() / 1000);
        resultView = ss().views.insert({
          ...parsed.view,
          view_id: generateSlackId("V"),
          team_id: view.team_id,
          user_id: view.user_id,
          hash: generateTs(),
          root_view_id: view.root_view_id || view.view_id,
          previous_view_id: view.view_id,
          app_id: view.app_id,
          bot_id: view.bot_id,
          created: now,
          updated: now,
        });
      }
    } else if (delivery.success) {
      // An empty 200 closes this view; "clear" closes the whole stack.
      const stack =
        action === "clear"
          ? ss()
              .views.all()
              .filter((candidate) => candidate.type === "modal" && candidate.root_view_id === view.root_view_id)
          : [view];
      for (const closing of stack) ss().views.delete(closing.id);
      closed = true;
    }

    return c.json({
      ok: delivery.success,
      closed,
      response_action: action,
      errors: action === "errors" ? (answer.errors ?? null) : null,
      ...(resultView ? { view: formatSlackView(resultView) } : {}),
      delivery: formatDelivery(delivery),
    });
  });

  app.post("/_slack/simulate/event-retry", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const eventId = typeof body.event_id === "string" ? body.event_id : "";
    const attempts = webhooks
      .getDeliveries()
      .filter((delivery) => (delivery.payload as { event_id?: unknown } | null)?.event_id === eventId);
    const original = attempts.find((delivery) => delivery.redelivery_of === undefined);
    if (!original) return simulateError(c, "event_not_found", 404);

    const retryNum = attempts.filter((delivery) => delivery.hook_id === original.hook_id).length;
    const reason = typeof body.reason === "string" && body.reason ? body.reason : "http_timeout";
    const delivery = await webhooks.redeliver(original.id, {
      headers: { "X-Slack-Retry-Num": String(retryNum), "X-Slack-Retry-Reason": reason },
    });
    if (!delivery) return simulateError(c, "subscription_not_found", 404);
    return c.json({
      ok: delivery.success,
      retry_num: retryNum,
      retry_reason: reason,
      delivery: { id: delivery.id, status_code: delivery.status_code, success: delivery.success },
    });
  });
}

function isJsonObject(value: unknown): value is SlackJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function elementLabel(element: SlackJsonObject): string | undefined {
  return isJsonObject(element.text) && typeof element.text.text === "string" ? element.text.text : undefined;
}

/** Every interactive element a message carries: actions-block elements and section accessories. */
function interactiveElements(message: SlackMessage): InteractiveElement[] {
  const found: InteractiveElement[] = [];
  for (const block of message.blocks ?? []) {
    const elements: SlackJsonObject[] = [];
    if (block.type === "actions" && Array.isArray(block.elements))
      elements.push(...block.elements.filter(isJsonObject));
    if (isJsonObject(block.accessory)) elements.push(block.accessory);
    for (const element of elements) {
      // Slack generates an action_id for an element without one; a stable one lets a click be named twice.
      const generated = `${typeof block.block_id === "string" ? block.block_id : "block"}-${found.length}`;
      found.push({
        block,
        element,
        action_id: typeof element.action_id === "string" ? element.action_id : generated,
      });
    }
  }
  return found;
}

/** `values` maps a block id to an option value, a list of option values, or text. */
function submittedState(
  view: SlackView,
  values: unknown,
): { values: Record<string, Record<string, SlackJsonObject>>; error?: string } {
  const state: Record<string, Record<string, SlackJsonObject>> = {};
  for (const [blockId, value] of Object.entries(isJsonObject(values) ? values : {})) {
    const block = view.blocks.find((candidate) => candidate.type === "input" && candidate.block_id === blockId);
    if (!block || !isJsonObject(block.element)) return { values: state, error: `no_input_block:${blockId}` };
    const element = block.element;
    const groups = Array.isArray(element.option_groups) ? element.option_groups.filter(isJsonObject) : [];
    const options = [
      ...(Array.isArray(element.options) ? element.options : []),
      ...groups.flatMap((group) => (Array.isArray(group.options) ? group.options : [])),
    ].filter(isJsonObject);
    const option = (wanted: unknown) => options.find((candidate) => candidate.value === wanted);
    const type = typeof element.type === "string" ? element.type : "plain_text_input";
    const actionId = typeof element.action_id === "string" ? element.action_id : blockId;

    if (type === "checkboxes" || type === "multi_static_select") {
      const picked = (Array.isArray(value) ? value : [value]).map(option);
      if (picked.some((candidate) => !candidate)) return { values: state, error: `no_option:${blockId}` };
      state[blockId] = { [actionId]: { type, selected_options: picked } };
    } else if (type === "static_select" || type === "radio_buttons") {
      const picked = option(value);
      if (!picked) return { values: state, error: `no_option:${blockId}` };
      state[blockId] = { [actionId]: { type, selected_option: picked } };
    } else {
      state[blockId] = { [actionId]: { type, value } };
    }
  }
  return { values: state };
}
