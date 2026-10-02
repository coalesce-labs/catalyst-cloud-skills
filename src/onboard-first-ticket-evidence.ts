import { createHash } from "node:crypto";
import { firstTicketLaunch, type FirstTicketReceipt } from "./onboard-first-ticket.js";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The existing mirror fanout's tenant-length-prefixed SHA-256 UUID derivation. This only
 * identifies a comment to read; it grants no write or authority over that comment. */
export function firstTicketCommentId(account: string, eventId: string): string {
  const bytes = createHash("sha256").update(`${account.length}:${account}:${eventId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Current public comments are phase OUTCOME comments, not invented launch comments. A real
 * launched phase can therefore remain unconfirmed here until its comment is mirrored. Fleet
 * rows have no lease generation; they corroborate a launch already proven by the event/report. */
export function firstTicketCorroboration(input: {
  receipt: FirstTicketReceipt; events: unknown; execution: unknown; issue: unknown; fleet: unknown; now: number;
}): { linearComment: boolean; fleetActivity: boolean } {
  const no = { linearComment: false, fleetActivity: false };
  const { receipt, events, execution, issue, fleet, now } = input;
  const launch = firstTicketLaunch(receipt, events, execution);
  if (!launch || !receipt.ticket || !Array.isArray(events) || !time(now) || launch.at > now) return no;
  const launchedEvent = object(events.find(value => object(value)?.seq === launch.cursor));
  if (!launchedEvent || typeof launchedEvent.host !== "string" || !launchedEvent.host || launchedEvent.host.length > 256) return no;
  const detail = object(issue);
  let linearComment = false;
  if (detail?.id === receipt.ticket.id && detail.identifier === receipt.ticket.identifier && detail.team_id === receipt.intent.teamId &&
      Array.isArray(detail.comments) && detail.comments.length <= 1_000) {
    for (const value of events) {
      const event = object(value), attrs = object(event?.attributes);
      if (!event || !attrs || !time(event.seq) || event.seq <= launch.cursor ||
          (event.event_name !== `phase.${receipt.intent.phase}.complete` && event.event_name !== `phase.${receipt.intent.phase}.failed`) ||
          attrs.ticket !== receipt.ticket.identifier || attrs.nonce !== launch.nonce ||
          typeof event.event_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(event.event_id) ||
          typeof event.ts !== "string") continue;
      const at = Date.parse(event.ts);
      if (!time(at) || at < launch.at || at > now) continue;
      const expected = firstTicketCommentId(receipt.intent.account, event.event_id);
      const heading = event.event_name.endsWith(".complete") ? "**Phase complete**" : "**Phase FAILED**";
      if (detail.comments.some(value => {
        const comment = object(value);
        return comment?.id === expected && typeof comment.body === "string" && comment.body.length <= 100_000 &&
          comment.body.includes(heading) && comment.body.includes(`**Phase**: \`${receipt.intent.phase}\``) &&
          time(comment.created_at) && comment.created_at >= at && comment.created_at <= now;
      })) { linearComment = true; break; }
    }
  }
  const fleetActivity = Array.isArray(fleet) && fleet.length <= 5_000 && fleet.some(value => {
    const row = object(value);
    return row?.ticket === receipt.ticket!.identifier && row.host_id === launchedEvent.host &&
      time(row.last_event_ts) && row.last_event_ts >= launch.at && row.last_event_ts <= now &&
      (row.phase === receipt.intent.phase || time(row.started_at) && row.started_at >= launch.at && row.started_at <= row.last_event_ts);
  });
  return { linearComment, fleetActivity };
}
