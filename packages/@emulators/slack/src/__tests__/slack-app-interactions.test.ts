import { createHmac } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlackStore, seedFromConfig } from "../index.js";
import {
  authHeaders,
  captureFetchRequests,
  createSlackTestApp,
  registerSlackEventSubscription,
  slackTestBaseUrl as base,
  type SlackTestApp,
} from "./helpers.js";

const signingSecret = "test-signing-secret";
const interactivityUrl = "https://app.example/slack/interactions";
const botToken = "xoxb-installed-app";

/** A workspace with one installed app, its bot token, and a channel the bot is in. */
function installedApp(config: Parameters<typeof seedFromConfig>[2] = {}): SlackTestApp & {
  channel: string;
  botUserId: string;
} {
  const setup = createSlackTestApp();
  seedFromConfig(setup.store, base, {
    signing_secret: signingSecret,
    oauth_apps: [
      {
        app_id: "A0TESTAPP",
        client_id: "client-1",
        client_secret: "secret-1",
        name: "Test App",
        redirect_uris: ["https://app.example/callback"],
        interactivity_url: interactivityUrl,
        bot_id: "B0TESTBOT",
        bot_user_id: "U0TESTBOT",
      },
    ],
    tokens: [
      {
        token: botToken,
        type: "bot",
        user_id: "U0TESTBOT",
        app_id: "A0TESTAPP",
        client_id: "client-1",
        bot_id: "B0TESTBOT",
        bot_user_id: "U0TESTBOT",
      },
    ],
    ...config,
  });
  const ss = getSlackStore(setup.store);
  const channel = ss.channels.insert({
    channel_id: "C0TESTCHAN",
    team_id: "T000000001",
    name: "support",
    is_channel: true,
    is_private: false,
    is_archived: false,
    topic: { value: "", creator: "U000000001", last_set: 0 },
    purpose: { value: "", creator: "U000000001", last_set: 0 },
    members: ["U000000001", "U0TESTBOT"],
    creator: "U000000001",
    num_members: 2,
  });
  return { ...setup, channel: channel.channel_id, botUserId: "U0TESTBOT" };
}

const botHeaders = { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" };

async function call(app: SlackTestApp["app"], path: string, body: unknown, headers = authHeaders()) {
  const response = await app.request(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return (await response.json()) as Record<string, any>;
}

/** Stubs fetch with a JSON answer, and records what was sent. */
function answerWith(answer: unknown = null) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return { ok: true, status: 200, text: async () => (answer === null ? "" : JSON.stringify(answer)) };
    }),
  );
  return {
    requests,
    interactions: () =>
      requests
        .filter((request) => request.url === interactivityUrl)
        .map((request) => JSON.parse(new URLSearchParams(request.body).get("payload")!) as Record<string, any>),
  };
}

const promptBlocks = [
  { type: "section", block_id: "intro", text: { type: "mrkdwn", text: "Connect this channel" } },
  {
    type: "actions",
    block_id: "bind",
    elements: [
      { type: "button", action_id: "connect_here", text: { type: "plain_text", text: "Connect here" }, value: "go" },
      { type: "button", text: { type: "plain_text", text: "Open settings" }, url: "https://app.example/settings" },
    ],
  },
];

const modal = {
  type: "modal",
  callback_id: "bind_channel",
  title: { type: "plain_text", text: "Connect" },
  submit: { type: "plain_text", text: "Save" },
  private_metadata: "C0TESTCHAN",
  blocks: [
    {
      type: "input",
      block_id: "target",
      label: { type: "plain_text", text: "Project" },
      element: {
        type: "static_select",
        action_id: "target_select",
        options: [
          { text: { type: "plain_text", text: "Alpha" }, value: "alpha" },
          { text: { type: "plain_text", text: "Beta" }, value: "beta" },
        ],
      },
    },
    {
      type: "input",
      block_id: "note",
      label: { type: "plain_text", text: "Note" },
      element: { type: "plain_text_input", action_id: "note_input" },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Slack plugin - interactivity simulation", () => {
  it("posts a signed block_actions payload whose trigger_id opens a modal", async () => {
    const { app, channel } = installedApp();
    const capture = answerWith();
    const posted = await call(
      app,
      "/api/chat.postMessage",
      { channel, text: "prompt", blocks: promptBlocks },
      botHeaders,
    );

    const clicked = await call(app, "/_slack/simulate/block-actions", {
      channel,
      message_ts: posted.ts,
      action_id: "connect_here",
    });
    expect(clicked).toMatchObject({ ok: true, action_id: "connect_here", delivery: { status_code: 200 } });

    const request = capture.requests.find((candidate) => candidate.url === interactivityUrl)!;
    expect(request.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const timestamp = request.headers["X-Slack-Request-Timestamp"];
    expect(request.headers["X-Slack-Signature"]).toBe(
      `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${request.body}`).digest("hex")}`,
    );

    const [payload] = capture.interactions();
    expect(payload).toMatchObject({
      type: "block_actions",
      api_app_id: "A0TESTAPP",
      user: { id: "U000000001", team_id: "T000000001" },
      team: { id: "T000000001" },
      channel: { id: channel, name: "support" },
      container: { type: "message", message_ts: posted.ts, channel_id: channel },
      message: { ts: posted.ts, bot_id: "B0TESTBOT" },
      actions: [{ type: "button", action_id: "connect_here", block_id: "bind", value: "go" }],
    });

    const opened = await call(app, "/api/views.open", { trigger_id: payload.trigger_id, view: modal }, botHeaders);
    expect(opened).toMatchObject({ ok: true, view: { callback_id: "bind_channel" } });
  });

  it("finds an element by its label or url, and refuses one the message does not carry", async () => {
    const { app, channel } = installedApp();
    const capture = answerWith();
    const posted = await call(
      app,
      "/api/chat.postMessage",
      { channel, text: "prompt", blocks: promptBlocks },
      botHeaders,
    );

    const byUrl = await call(app, "/_slack/simulate/block-actions", {
      channel: "#support",
      message_ts: posted.ts,
      url: "https://app.example/settings",
    });
    expect(byUrl.ok).toBe(true);
    expect(capture.interactions()[0].actions[0]).toMatchObject({ url: "https://app.example/settings" });

    const missing = await app.request(`${base}/_slack/simulate/block-actions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, message_ts: posted.ts, action_id: "nope" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, error: "action_not_found" });
  });

  it("requires the app to have an interactivity_url", async () => {
    const { app, store, channel } = installedApp();
    const ss = getSlackStore(store);
    ss.oauthApps.update(ss.oauthApps.all()[0].id, { interactivity_url: undefined });
    answerWith();
    const posted = await call(
      app,
      "/api/chat.postMessage",
      { channel, text: "prompt", blocks: promptBlocks },
      botHeaders,
    );

    const response = await app.request(`${base}/_slack/simulate/block-actions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel, message_ts: posted.ts, action_id: "connect_here" }),
    });
    expect(await response.json()).toMatchObject({ ok: false, error: "interactivity_not_configured" });
  });

  async function openModal(app: SlackTestApp["app"]) {
    const trigger = await call(app, "/api/views.generateTriggerId", { user_id: "U000000001" }, botHeaders);
    const opened = await call(app, "/api/views.open", { trigger_id: trigger.trigger_id, view: modal }, botHeaders);
    return opened.view.id as string;
  }

  it("submits a modal with state built from its input blocks, and closes it on an empty answer", async () => {
    const { app, store } = installedApp();
    const capture = answerWith();
    const viewId = await openModal(app);

    const submitted = await call(app, "/_slack/simulate/view-submission", {
      view_id: viewId,
      values: { target: "beta", note: "hello" },
    });
    expect(submitted).toMatchObject({ ok: true, closed: true, response_action: null });

    const [payload] = capture.interactions();
    expect(payload).toMatchObject({
      type: "view_submission",
      api_app_id: "A0TESTAPP",
      user: { id: "U000000001" },
      view: {
        id: viewId,
        callback_id: "bind_channel",
        private_metadata: "C0TESTCHAN",
        state: {
          values: {
            target: { target_select: { type: "static_select", selected_option: { value: "beta" } } },
            note: { note_input: { type: "plain_text_input", value: "hello" } },
          },
        },
      },
    });
    expect(getSlackStore(store).views.findOneBy("view_id", viewId)).toBeUndefined();
  });

  it("keeps the modal open and returns the app's errors", async () => {
    const { app, store } = installedApp();
    answerWith({ response_action: "errors", errors: { target: "Not allowed" } });
    const viewId = await openModal(app);

    const submitted = await call(app, "/_slack/simulate/view-submission", {
      view_id: viewId,
      values: { target: "alpha" },
    });
    expect(submitted).toMatchObject({
      ok: true,
      closed: false,
      response_action: "errors",
      errors: { target: "Not allowed" },
    });
    expect(getSlackStore(store).views.findOneBy("view_id", viewId)).toBeDefined();
  });

  it("applies an update answer to the open view", async () => {
    const { app } = installedApp();
    answerWith({ response_action: "update", view: { ...modal, callback_id: "bind_done", blocks: [] } });
    const viewId = await openModal(app);

    const submitted = await call(app, "/_slack/simulate/view-submission", { view_id: viewId, values: {} });
    expect(submitted).toMatchObject({
      closed: false,
      response_action: "update",
      view: { id: viewId, callback_id: "bind_done", blocks: [] },
    });
  });

  it("refuses a value the input does not offer", async () => {
    const { app } = installedApp();
    answerWith();
    const viewId = await openModal(app);

    const response = await app.request(`${base}/_slack/simulate/view-submission`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ view_id: viewId, values: { target: "gamma" } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "no_option:target" });
  });

  it("honours view_trigger_ttl_seconds", async () => {
    const { app } = installedApp({ view_trigger_ttl_seconds: 600 });
    vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
    const trigger = await call(app, "/api/views.generateTriggerId", { user_id: "U000000001" }, botHeaders);
    expect(trigger.expires_at).toBe(1_750_000_600);
  });
});

describe("Slack plugin - event fidelity for an installed app", () => {
  it("names the app on the envelope and the conversation type on a message", async () => {
    const { app, webhooks, channel } = installedApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);

    await call(app, "/api/chat.postMessage", { channel, text: "hello" });

    expect(capture.jsonBodies()).toEqual([
      expect.objectContaining({
        api_app_id: "A0TESTAPP",
        authorizations: [expect.objectContaining({ team_id: "T000000001", user_id: "U0TESTBOT", is_bot: true })],
        event: expect.objectContaining({ type: "message", channel_type: "channel", text: "hello" }),
      }),
    ]);
  });

  it("sends app_mention when a person names the bot, and not for the bot's own post", async () => {
    const { app, webhooks, channel } = installedApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message", "app_mention"]);

    const posted = await call(app, "/api/chat.postMessage", { channel, text: "<@U0TESTBOT> help" });
    await call(app, "/api/chat.postMessage", { channel, text: "<@U0TESTBOT> is me" }, botHeaders);

    const events = (capture.jsonBodies() as Array<{ event: Record<string, unknown> }>).map((body) => body.event);
    expect(events.map((event) => event.type)).toEqual(["message", "app_mention", "message"]);
    expect(events[1]).toMatchObject({
      type: "app_mention",
      user: "U000000001",
      text: "<@U0TESTBOT> help",
      channel,
      ts: posted.ts,
      event_ts: posted.ts,
    });
    expect(events[1]).not.toHaveProperty("channel_type");
  });

  it("marks a bot's own post with its bot and app", async () => {
    const { app, webhooks, channel } = installedApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);

    const posted = await call(app, "/api/chat.postMessage", { channel, text: "from the bot" }, botHeaders);
    expect(posted.message).toMatchObject({ bot_id: "B0TESTBOT", app_id: "A0TESTAPP" });
    expect((capture.jsonBodies()[0] as { event: unknown }).event).toMatchObject({
      bot_id: "B0TESTBOT",
      app_id: "A0TESTAPP",
    });

    const history = await call(app, "/api/conversations.history", { channel });
    expect(history.messages[0]).toMatchObject({ bot_id: "B0TESTBOT" });
  });

  it("marks a post made as the bot user through a token that names no bot", async () => {
    const { app, store, channel } = installedApp();
    getSlackStore(store).tokens.insert({
      token: "xoxb-plain",
      token_type: "test",
      team_id: "T000000001",
      user_id: "U0TESTBOT",
      scopes: ["chat:write"],
    });
    const posted = await call(
      app,
      "/api/chat.postMessage",
      { channel, text: "still the bot" },
      {
        Authorization: "Bearer xoxb-plain",
        "Content-Type": "application/json",
      },
    );
    expect(posted.message).toMatchObject({ bot_id: "B0TESTBOT", app_id: "A0TESTAPP" });
  });

  it.each([
    [false, "channel_left"],
    [true, "group_left"],
  ])("tells the app its bot was removed (private: %s)", async (isPrivate, expected) => {
    const { app, store, webhooks, channel } = installedApp();
    const ss = getSlackStore(store);
    ss.channels.update(ss.channels.findOneBy("channel_id", channel)!.id, {
      is_private: isPrivate,
      is_channel: !isPrivate,
    });
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks);

    const kicked = await call(app, "/api/conversations.kick", { channel, user: "U0TESTBOT" });
    expect(kicked.ok).toBe(true);

    const events = (capture.jsonBodies() as Array<{ event: Record<string, unknown> }>).map((body) => body.event);
    expect(events.map((event) => event.type)).toEqual(["member_left_channel", expected]);
    expect(events[1]).toMatchObject({ channel, actor_id: "U000000001" });
  });
});

describe("Slack plugin - Slack Connect members", () => {
  it("seeds a member of another workspace and reports them as a stranger", async () => {
    const { app } = installedApp({ users: [{ name: "guest", team_id: "T0PARTNER" }] });
    const users = await call(app, "/api/users.list", {});
    const guest = users.members.find((member: { name: string }) => member.name === "guest");
    expect(guest).toMatchObject({ team_id: "T0PARTNER", is_stranger: true });
  });

  it("carries the author's workspace on their messages, and marks the channel shared", async () => {
    const { app, store, webhooks, channel } = installedApp({ users: [{ name: "guest", team_id: "T0PARTNER" }] });
    const ss = getSlackStore(store);
    const guest = ss.users.findOneBy("name", "guest")!;
    ss.tokens.insert({
      token: "xoxp-guest",
      token_type: "user",
      team_id: "T000000001",
      user_id: guest.user_id,
      scopes: ["chat:write"],
    });

    const invited = await call(app, "/api/conversations.invite", { channel, users: guest.user_id });
    expect(invited.channel).toMatchObject({ is_ext_shared: true });

    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);
    await call(
      app,
      "/api/chat.postMessage",
      { channel, text: "from outside" },
      {
        Authorization: "Bearer xoxp-guest",
        "Content-Type": "application/json",
      },
    );
    await call(app, "/api/chat.postMessage", { channel, text: "from inside" });

    const [outside, inside] = (capture.jsonBodies() as Array<{ team_id: string; event: Record<string, unknown> }>).map(
      (body) => body,
    );
    expect(outside.team_id).toBe("T000000001");
    expect(outside.event).toMatchObject({ user_team: "T0PARTNER", source_team: "T0PARTNER" });
    expect(inside.event).not.toHaveProperty("user_team");
  });
});

describe("Slack plugin - admin.conversations convert", () => {
  it("converts a channel to private and back, posting the message members see", async () => {
    const { app, webhooks, channel } = installedApp();
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks, ["message"]);

    expect(await call(app, "/api/admin.conversations.convertToPrivate", { channel_id: channel })).toEqual({ ok: true });
    const info = await call(app, "/api/conversations.info", { channel });
    expect(info.channel).toMatchObject({ is_private: true, is_channel: false, is_group: true });

    expect(await call(app, "/api/admin.conversations.convertToPublic", { channel_id: channel })).toEqual({ ok: true });
    // Already public: nothing changes and nothing is posted.
    expect(await call(app, "/api/admin.conversations.convertToPublic", { channel_id: channel })).toEqual({ ok: true });

    const events = (capture.jsonBodies() as Array<{ event: Record<string, unknown> }>).map((body) => body.event);
    expect(events.map((event) => event.subtype)).toEqual(["channel_convert_to_private", "channel_convert_to_public"]);
    expect(events[0]).toMatchObject({ type: "message", channel, user: "U000000001", channel_type: "group" });
  });

  it("refuses #general, direct messages and callers who are not admins", async () => {
    const { app, store, channel } = installedApp();
    const ss = getSlackStore(store);
    const general = ss.channels.findOneBy("name", "general")!.channel_id;
    expect(await call(app, "/api/admin.conversations.convertToPrivate", { channel_id: general })).toMatchObject({
      error: "default_org_wide_channel",
    });
    expect(await call(app, "/api/admin.conversations.convertToPrivate", { channel_id: "C0MISSING" })).toMatchObject({
      error: "channel_not_found",
    });
    expect(
      await call(app, "/api/admin.conversations.convertToPrivate", { channel_id: channel }, botHeaders),
    ).toMatchObject({ error: "not_an_admin" });
  });
});

describe("Slack plugin - apps.uninstall", () => {
  it("revokes the app's tokens and sends both lifecycle events", async () => {
    const { app, store, webhooks, tokenMap } = installedApp();
    const ss = getSlackStore(store);
    const capture = captureFetchRequests();
    registerSlackEventSubscription(webhooks);

    const result = await call(
      app,
      "/api/apps.uninstall",
      { client_id: "client-1", client_secret: "secret-1" },
      botHeaders,
    );
    expect(result).toEqual({ ok: true });

    const bodies = capture.jsonBodies() as Array<{ api_app_id: string; event: Record<string, unknown> }>;
    expect(bodies.map((body) => body.event.type)).toEqual(["app_uninstalled", "tokens_revoked"]);
    expect(bodies.every((body) => body.api_app_id === "A0TESTAPP")).toBe(true);
    expect(bodies[1].event.tokens).toEqual({ oauth: [], bot: ["U0TESTBOT"] });

    expect(ss.tokens.findOneBy("token", botToken)).toBeUndefined();
    expect(tokenMap.has(botToken)).toBe(false);
    expect(ss.installations.all()).toEqual([]);
  });

  it("checks the client credentials", async () => {
    const { app } = installedApp();
    expect(
      await call(app, "/api/apps.uninstall", { client_id: "nope", client_secret: "secret-1" }, botHeaders),
    ).toMatchObject({ error: "invalid_client_id" });
    expect(
      await call(app, "/api/apps.uninstall", { client_id: "client-1", client_secret: "wrong" }, botHeaders),
    ).toMatchObject({ error: "bad_client_secret" });
  });
});

describe("Slack plugin - event retry", () => {
  it("redelivers an event with the same event_id and Slack's retry headers", async () => {
    const { app, webhooks, channel } = installedApp();
    const capture = answerWith();
    registerSlackEventSubscription(webhooks, ["message"]);
    await call(app, "/api/chat.postMessage", { channel, text: "once" });
    const eventId = (JSON.parse(capture.requests[0].body) as { event_id: string }).event_id;

    const first = await call(app, "/_slack/simulate/event-retry", { event_id: eventId });
    const second = await call(app, "/_slack/simulate/event-retry", { event_id: eventId, reason: "http_error" });
    expect(first).toMatchObject({ ok: true, retry_num: 1, retry_reason: "http_timeout" });
    expect(second).toMatchObject({ ok: true, retry_num: 2, retry_reason: "http_error" });

    expect(capture.requests.map((request) => request.body)).toEqual(Array(3).fill(capture.requests[0].body));
    expect(capture.requests[1].headers).toMatchObject({
      "X-Slack-Retry-Num": "1",
      "X-Slack-Retry-Reason": "http_timeout",
      "X-Slack-Signature": expect.stringMatching(/^v0=/),
    });
    expect(capture.requests[2].headers["X-Slack-Retry-Num"]).toBe("2");
    expect(webhooks.getDeliveries().map((delivery) => delivery.redelivery_of)).toEqual([undefined, 1, 1]);
  });

  it("answers 404 for an event that was never delivered", async () => {
    const { app } = installedApp();
    const response = await app.request(`${base}/_slack/simulate/event-retry`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event_id: "EvMissing" }),
    });
    expect(response.status).toBe(404);
  });
});
