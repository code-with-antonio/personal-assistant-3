import { timingSafeEqual } from "node:crypto";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { hasProPlan, upgradeUrl } from "./billing.js";
import { findChannelLink, linkIdempotencyKey } from "./db/channel-links.js";
import type { Platform } from "./db/schema.js";
import type { linkChannelAccount } from "./trigger/link-account.js";

// What every channel webhook does once it has verified and parsed a platform's message: only
// messages from users linked to a Clerk account on the Pro plan reach the agent. Unlinked users are
// sent a sign-in link, linked users without Pro an upgrade link

export const secretMatches = (received: string | undefined, expected: string | undefined) => {
  // Webhook secrets aren't configured in local dev, so verification is skipped there
  if (!expected) return true;
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const upgradeMessage = () =>
  [
    "The assistant is available on the Pro plan.",
    "",
    `Upgrade here, then send me a message again: ${upgradeUrl()}`,
  ].join("\n");

export type GateResult =
  // An account-linking run is (or already was) messaging the user a sign-in link
  | { status: "linking" }
  // Linked, but not on Pro: the webhook replies with upgradeMessage() its own way
  | { status: "upgrade" }
  | { status: "allowed"; clerkUserId: string };

// Throws when the plan check fails, so the webhook can answer with a non-2xx and the platform
// redelivers instead of the message being dropped
export const gateInbound = async ({
  platform,
  externalUserId,
  chatId,
}: {
  platform: Platform;
  externalUserId: string;
  chatId: string;
}): Promise<GateResult> => {
  const link = await findChannelLink(platform, externalUserId);

  if (!link) {
    await tasks.trigger<typeof linkChannelAccount>(
      "link-channel-account",
      { platform, externalUserId, chatId },
      {
        idempotencyKey: await idempotencyKeys.create(linkIdempotencyKey(platform, externalUserId), {
          scope: "global",
        }),
        // Matches the device code's lifetime; the run also clears the key as soon as it ends
        idempotencyKeyTTL: "10m",
        tags: [`${platform}-user:${externalUserId}`],
      }
    );
    return { status: "linking" };
  }

  // Team members and testers listed in PRO_BYPASS_USER_IDS (comma-separated platform user ids)
  // get the agent without a Pro subscription
  if (process.env.PRO_BYPASS_USER_IDS?.includes(externalUserId)) {
    return { status: "allowed", clerkUserId: link.clerkUserId };
  }

  return (await hasProPlan(link.clerkUserId))
    ? { status: "allowed", clerkUserId: link.clerkUserId }
    : { status: "upgrade" };
};

// Hands an allowed message to the channel's Trigger.dev webhook endpoint, with the Clerk user id
// attached. Returns false on failure so the webhook answers non-2xx and the platform redelivers;
// the Trigger endpoint dedupes redeliveries on the platform's own event id
export const forwardToTrigger = async ({
  url,
  secretHeader,
  secret,
  body,
}: {
  url: string;
  secretHeader: string;
  secret: string;
  body: Record<string, unknown> & { clerkUserId: string };
}) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", [secretHeader]: secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Forwarding to ${url} failed: ${res.status} ${await res.text()}`);
  }
  return res.ok;
};
