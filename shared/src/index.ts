export * from "./digest";

export type YouTubeTranscriptCue = {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
};

export type YouTubeSummaryAnchor = {
  label: string;
  startSec: number;
  endSec?: number;
  url: string;
};

export type GmailEvent = {
  id: string;
  threadId?: string;
  accountEmail?: string;
  from: string;
  subject: string;
  snippet?: string;
  body: string;
  receivedAt: string;
  sourceUrl?: string;
  read?: boolean;
  labels?: string[];
};

export type TelegramEvent = {
  id: string;
  chatId?: string;
  chat: string;
  sender: string;
  text: string;
  sentAt: string;
  mentionedMe?: boolean;
  direct?: boolean;
  sourceUrl?: string;
};

export type YouTubeEvent = {
  id: string;
  title: string;
  body: string;
  actor?: string;
  url?: string;
  receivedAt: string;
  channel?: string;
  channelUrl?: string;
  duration?: number;
  viewCount?: number;
  transcript?: string;
  transcriptCues?: YouTubeTranscriptCue[];
  transcriptCharCount?: number;
  transcriptSource?: "manual" | "auto" | "none";
  episodeSummary?: string;
  youtubeAnchors?: YouTubeSummaryAnchor[];
};

export type TwitterEvent = {
  id: string;
  title: string;
  body: string;
  actor?: string;
  url?: string;
  receivedAt: string;
  authorId?: string;
  username?: string;
  displayName?: string;
  conversationId?: string;
  publicMetrics?: Record<string, number>;
  referencedTweets?: Array<{ type: string; id: string }>;
};

export type RawEvents = {
  gmail?: GmailEvent[];
  telegram?: TelegramEvent[];
  youtube?: YouTubeEvent[];
  twitter?: TwitterEvent[];
};

export type RawEvent = GmailEvent | TelegramEvent | YouTubeEvent | TwitterEvent;

export type GroupSignal =
  | "direct_message"
  | "directly_addressed"
  | "mention"
  | "reply_to_user"
  | "assigned_to_user"
  | "review_requested"
  | "direct_email_recipient"
  | "deadline_keyword"
  | "urgent_keyword"
  | "risk_keyword"
  | "money_keyword"
  | "access_security_keyword"
  | "question_or_request";

export type EventGroup = {
  id: string;
  source: "gmail" | "telegram" | "youtube" | "twitter";
  title: string;
  sourceLabel: string;
  events: RawEvent[];
  eventCount: number;
  latestAt: string;
  participants: string[];
  sourceUrl?: string;
  signals: GroupSignal[];
  score: number;
  estimatedTokens: number;
};

export type ScanRoute = "default" | "overflow";

export type ScanPlan = {
  route: ScanRoute;
  estimatedTokens: number;
  rawEventCount: number;
  groupCount: number;
  batches: EventGroup[][];
  oversizedGroupCount: number;
};

const PROMPT_GMAIL_BODY_LIMIT = 1500;
const PROMPT_TELEGRAM_TEXT_LIMIT = 1000;
const PROMPT_GENERIC_BODY_LIMIT = 1200;
const PROMPT_YOUTUBE_TRANSCRIPT_LIMIT = 16_000;
const PROMPT_GMAIL_EVENT_LIMIT = 40;
const PROMPT_TELEGRAM_EVENT_LIMIT = 80;
const PROMPT_YOUTUBE_EVENT_LIMIT = 24;
const PROMPT_TWITTER_EVENT_LIMIT = 80;
export const DEFAULT_TRIAGE_TOKEN_LIMIT = 25_000;
export const DEFAULT_BATCH_TOKEN_LIMIT = 18_000;

export const sampleGmailEvents: GmailEvent[] = [
  {
    id: "sample_work_approval",
    threadId: "sample_thread_work_approval",
    accountEmail: "work@example.com",
    from: "maya@example.com",
    subject: "Approval needed today",
    snippet: "Can you approve the launch checklist today?",
    body: "Can you approve the launch checklist today? The rollout is blocked until we have your sign-off.",
    receivedAt: "2026-06-02T10:00:00.000Z",
    sourceUrl: "https://mail.google.com/mail/u/?authuser=work%40example.com#search/rfc822msgid%3Asample_work_approval%40example.com",
    read: false,
    labels: ["INBOX", "UNREAD"]
  },
  {
    id: "sample_personal_schedule",
    threadId: "sample_thread_personal_schedule",
    accountEmail: "personal@example.com",
    from: "alex@example.com",
    subject: "Dinner newsletter",
    snippet: "Here are this week's restaurant recommendations.",
    body: "Here are this week's restaurant recommendations and a few general updates.",
    receivedAt: "2026-06-02T09:00:00.000Z",
    sourceUrl: "https://mail.google.com/mail/u/?authuser=personal%40example.com#search/rfc822msgid%3Asample_personal_schedule%40example.com",
    read: true,
    labels: ["INBOX"]
  }
];

export function buildTriagePrompt(events: RawEvents): string {
  return buildGroupedTriagePrompt(groupEvents(events));
}

export function buildGroupedTriagePrompt(groups: EventGroup[]): string {
  return [
    "You are an attention triage agent for the product 'What Did I Miss?'.",
    "",
    "Gmail task: find important missed obligations.",
    "Telegram task: summarize the selected group/channel conversations and call out anything important.",
    "YouTube task: preserve supplied episode summaries for monitored videos/podcasts; YouTube rows are for catch-up, not obligation tracking.",
    "Twitter/X task: find meaningful catch-up from the user's timeline: launches, incidents, deadlines, major updates, high-signal analysis, market/company/product news, and follow-up-worthy posts.",
    "For Telegram groups/channels, create concise chat-level catch-up findings when there is meaningful conversation to summarize, even if there is no direct ask.",
    "For Telegram DMs, mentions, blocked people, decisions, deadlines, trades/market-moving context, production/user issues, and explicit asks, make the importance/action items very clear.",
    "Do not summarize every individual Telegram message. Group related messages by chat/channel and topic.",
    "Ignore newsletters, generic updates, promotions, spam, and low-signal chatter.",
    "For Twitter/X, ignore memes, generic takes, engagement bait, low-context personal updates, and repetitive posts unless they are clearly useful catch-up context.",
    "For YouTube, do not invent transcript details. Use the supplied episode summary when present, and omit videos only when no useful summary was supplied.",
    "When unsure whether a Gmail item matters, omit it. When unsure whether a Telegram thread matters, include it only if it helps the user catch up on a selected chat.",
    "Return {\"findings\":[]} when nothing is important.",
    "Return at most 10 findings.",
    "Also create source-level insight summaries for sources with meaningful scanned events. These summaries are separate from findings and should explain what the raw events add up to.",
    "",
    "Priority rules:",
    "- high: someone is blocked, a production/user issue needs attention, an approval is needed today, or a deadline is imminent.",
    "- medium: direct ask, scheduling request, follow-up, review request, assigned issue, decision, notable Telegram conversation, or important catch-up context that is not immediately blocking.",
    "- low: useful Telegram context that can wait; omit Gmail items that do not require action.",
    "- For YouTube, priority means summary value: high = unusually important or dense with insight, medium = worth reading, low = optional background.",
    "",
    "Telegram output rules:",
    "- Prefer one finding per selected chat/topic, not one finding per message.",
    "- Put the conversation summary in `why`.",
    "- Put decisions, action items, open questions, deadlines, or 'No action needed' in `suggestedAction`.",
    "- Use `evidence` only for raw source excerpt text that helps the user inspect the original context. Include speaker/sender names and 2-5 relevant adjacent messages or lines when available.",
    "- Do not use `evidence` to repeat the title, summary, action, source label, or timestamp.",
    "- Set `accountEmail` to a readable source label like `Telegram · <chat name>` when possible.",
    "",
    "YouTube output rules:",
    "- Use `accountEmail` as `YouTube · <channel>`.",
    "- Use `sourceUrl` for the video URL.",
    "- Put the supplied episode summary in `why`, preserving its useful bullets and specifics.",
    "- Write `why` so the user can understand the substance without watching the video. Do not merely restate the description, title, or chapter list.",
    "- Aim for a useful read, roughly 120-220 words for dense podcasts. Prefer specific claims over generic framing.",
    "- Set `suggestedAction` to `No action needed.` because YouTube is for catch-up, not obligation tracking.",
    "- Use `evidence` only for a few optional supporting timestamps or quotes. The main value belongs in `why`, not in a hidden transcript/context section.",
    "",
    "Twitter/X output rules:",
    "- Prefer one finding per high-signal post or related thread.",
    "- Use `accountEmail` as a readable source label like `X · @username`.",
    "- Use `sourceUrl` when provided so the desktop app can open the original post.",
    "- Use `evidence` for the raw tweet text and only useful metrics/context, not for metadata already shown in the card header.",
    "",
    "Return a concise digest with priority, source, source id, account email/source label when available, source URL when available, why it matters, suggested next action, and evidence.",
    "For sourceInsights, synthesize across raw events for that source. Discover patterns, differences, similarities, repeated complaints, development direction, unresolved risks, or notable shifts. Prefer 2-3 concrete themes with named repos, chats, accounts, issues, PRs, releases, or topics when available. Do not list every item. Keep each summary 50-90 words unless extra context is truly necessary, and never exceed 150 words.",
    "Never invent source ids, account emails, source URLs, or timestamps.",
    "Only include findings that map back to one of the provided events.",
    "Use the original source id and account email/source label exactly as provided so the desktop app can link findings back to the right source.",
    "",
    "Event groups JSON:",
    JSON.stringify(compactGroupsForPrompt(groups), null, 2)
  ].join("\n");
}

export function buildSynthesisPrompt(batchResults: unknown[]): string {
  return [
    "You are the final synthesis pass for What Did I Miss?.",
    "Merge, rank, and dedupe candidate findings from prior batch triage passes.",
    "Merge sourceInsights by source into a concise latest summary for each source when possible.",
    "Keep only the most important items. Preserve source ids, source URLs, timestamps, and raw evidence excerpts exactly when available.",
    "Return JSON only with {\"findings\":[],\"sourceInsights\":[]} using the same shapes as the batch results.",
    "",
    "Batch results JSON:",
    JSON.stringify(batchResults, null, 2)
  ].join("\n");
}

export function compactEventsForPrompt(events: RawEvents): RawEvents {
  return {
    ...events,
    gmail: newestEvents(events.gmail ?? [], (event) => event.receivedAt, PROMPT_GMAIL_EVENT_LIMIT).map((event) => ({
      ...event,
      body: truncateText(event.body, PROMPT_GMAIL_BODY_LIMIT)
    })),
    telegram: balancedNewestTelegramEvents(events.telegram ?? [], PROMPT_TELEGRAM_EVENT_LIMIT).map((event) => ({
      ...event,
      text: truncateText(event.text, PROMPT_TELEGRAM_TEXT_LIMIT)
    })),
    youtube: newestEvents(events.youtube ?? [], (event) => event.receivedAt, PROMPT_YOUTUBE_EVENT_LIMIT).map((event) => ({
      ...event,
      body: truncateText(event.body, PROMPT_GENERIC_BODY_LIMIT),
      episodeSummary: truncateText(event.episodeSummary ?? "", PROMPT_YOUTUBE_TRANSCRIPT_LIMIT),
      transcript: "",
      transcriptCues: []
    })),
    twitter: newestEvents(events.twitter ?? [], (event) => event.receivedAt, PROMPT_TWITTER_EVENT_LIMIT).map((event) => ({
      ...event,
      body: truncateText(event.body, PROMPT_GENERIC_BODY_LIMIT)
    }))
  };
}

export function compactGroupsForPrompt(groups: EventGroup[]): EventGroup[] {
  return groups.map((group) => ({
    ...group,
    events: compactEventsForPrompt(rawEventsFromGroup(group))[group.source] ?? []
  }));
}

export function groupEvents(events: RawEvents): EventGroup[] {
  const groups = new Map<string, { source: EventGroup["source"]; events: RawEvent[] }>();
  const add = (source: EventGroup["source"], id: string, event: RawEvent) => {
    const key = `${source}:${id}`;
    const existing = groups.get(key);
    if (existing) existing.events.push(event);
    else groups.set(key, { source, events: [event] });
  };

  for (const event of events.gmail ?? []) {
    add("gmail", `${event.accountEmail ?? "unknown"}:${event.threadId ?? event.id}`, event);
  }
  for (const event of events.telegram ?? []) {
    add("telegram", event.chatId ?? event.chat, event);
  }
  for (const event of events.youtube ?? []) {
    add("youtube", event.id, event);
  }
  for (const event of events.twitter ?? []) {
    add("twitter", twitterGroupId(event), event);
  }

  return [...groups.entries()]
    .map(([id, group]) => buildEventGroup(id, group.source, group.events))
    .sort((a, b) => b.score - a.score || dateMs(b.latestAt) - dateMs(a.latestAt));
}

export function planGroupedScan(groups: EventGroup[], options: { defaultTokenLimit?: number; batchTokenLimit?: number } = {}): ScanPlan {
  const defaultTokenLimit = options.defaultTokenLimit ?? DEFAULT_TRIAGE_TOKEN_LIMIT;
  const batchTokenLimit = options.batchTokenLimit ?? DEFAULT_BATCH_TOKEN_LIMIT;
  const oversizedGroupCount = groups.filter((group) => group.events.length > 1 && group.estimatedTokens > batchTokenLimit).length;
  const normalizedGroups = splitOversizedGroups(groups, batchTokenLimit);
  const estimatedTokens = estimateTokens(compactGroupsForPrompt(normalizedGroups));
  if (estimatedTokens < defaultTokenLimit) {
    return {
      route: "default",
      estimatedTokens,
      rawEventCount: normalizedGroups.reduce((sum, group) => sum + group.eventCount, 0),
      groupCount: normalizedGroups.length,
      batches: [normalizedGroups],
      oversizedGroupCount
    };
  }

  const batches: EventGroup[][] = [];
  let current: EventGroup[] = [];
  let currentTokens = 0;
  for (const group of normalizedGroups) {
    const groupTokens = Math.max(1, group.estimatedTokens);
    if (current.length && currentTokens + groupTokens > batchTokenLimit) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(group);
    currentTokens += groupTokens;
  }
  if (current.length) batches.push(current);

  return {
    route: "overflow",
    estimatedTokens,
    rawEventCount: normalizedGroups.reduce((sum, group) => sum + group.eventCount, 0),
    groupCount: normalizedGroups.length,
    batches,
    oversizedGroupCount
  };
}

export function estimateTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

export function rawEventsFromGroups(groups: EventGroup[]): RawEvents {
  return groups.reduce<RawEvents>((acc, group) => mergeRawEvents(acc, rawEventsFromGroup(group)), {});
}

function buildEventGroup(id: string, source: EventGroup["source"], events: RawEvent[]): EventGroup {
  const sortedEvents = [...events].sort((a, b) => eventTime(a) - eventTime(b));
  const latest = sortedEvents.at(-1);
  const signals = groupSignals(source, sortedEvents);
  const group: Omit<EventGroup, "estimatedTokens"> = {
    id,
    source,
    title: groupTitle(source, sortedEvents),
    sourceLabel: groupSourceLabel(source, sortedEvents),
    events: sortedEvents,
    eventCount: sortedEvents.length,
    latestAt: latest ? eventTimestamp(latest) : new Date(0).toISOString(),
    participants: groupParticipants(source, sortedEvents),
    sourceUrl: groupSourceUrl(sortedEvents),
    signals,
    score: groupScore(signals, sortedEvents.length)
  };
  return {
    ...group,
    estimatedTokens: estimateTokens(group)
  };
}

function splitOversizedGroups(groups: EventGroup[], maxTokens: number): EventGroup[] {
  return groups.flatMap((group) => {
    if (group.estimatedTokens <= maxTokens || group.events.length <= 1) return [group];
    const chunks: RawEvent[][] = [];
    let current: RawEvent[] = [];
    for (const event of group.events) {
      const candidate = [...current, event];
      const candidateGroup = buildEventGroup(`${group.id}:chunk:${chunks.length + 1}`, group.source, candidate);
      if (current.length && candidateGroup.estimatedTokens > maxTokens) {
        chunks.push(current);
        current = [event];
      } else {
        current = candidate;
      }
    }
    if (current.length) chunks.push(current);
    return chunks.map((chunk, index) => buildEventGroup(`${group.id}:chunk:${index + 1}`, group.source, chunk));
  });
}

function groupSignals(source: EventGroup["source"], events: RawEvent[]): GroupSignal[] {
  const signals = new Set<GroupSignal>();
  const text = events.map(eventSearchText).join("\n").toLowerCase();

  if (source === "telegram" && events.some((event) => "direct" in event && event.direct)) signals.add("direct_message");
  if (events.some((event) => "mentionedMe" in event && event.mentionedMe)) signals.add("mention");
  if (hasAny(text, ["urgent", "asap", "today", "tonight", "eod", "deadline", "blocked", "blocking", "stuck", "overdue"])) signals.add("urgent_keyword");
  if (hasAny(text, ["deadline", "today", "tonight", "eod", "overdue"])) signals.add("deadline_keyword");
  if (hasAny(text, ["issue", "bug", "broken", "failing", "outage", "down", "incident", "production", "error", "alert"])) signals.add("risk_keyword");
  if (hasAny(text, ["security", "password", "login", "verification", "code", "2fa", "permission", "access", "approval", "invite", "credentials", "compromised", "suspicious"])) signals.add("access_security_keyword");
  if (hasAny(text, ["invoice", "payment", "refund", "charge", "balance", "credits", "budget", "renewal", "contract", "deal", "customer", "user complaint"])) signals.add("money_keyword");
  if (hasAny(text, ["can you", "could you", "please", "need", "needs", "ask", "request", "follow up", "reply", "review", "approve", "confirm", "decide", "send", "share"]) || text.includes("?")) signals.add("question_or_request");
  if (hasAny(text, ["assigned", "review requested", "mentioned you", "waiting on you", "your input", "thoughts", "feedback"])) signals.add("directly_addressed");

  return [...signals];
}

function groupScore(signals: GroupSignal[], eventCount: number): number {
  const weights: Partial<Record<GroupSignal, number>> = {
    direct_message: 4,
    mention: 4,
    directly_addressed: 4,
    assigned_to_user: 5,
    review_requested: 5,
    access_security_keyword: 4,
    urgent_keyword: 3,
    deadline_keyword: 3,
    risk_keyword: 3,
    money_keyword: 2,
    question_or_request: 2
  };
  return signals.reduce((sum, signal) => sum + (weights[signal] ?? 1), 0) + Math.min(eventCount, 5);
}

function eventSearchText(event: RawEvent): string {
  if ("subject" in event) return [event.from, event.subject, event.snippet, event.body].filter(Boolean).join("\n");
  if ("text" in event) return [event.sender, event.chat, event.text].filter(Boolean).join("\n");
  return [event.title, event.body, event.actor].filter(Boolean).join("\n");
}

function groupTitle(source: EventGroup["source"], events: RawEvent[]): string {
  const latest = events.at(-1);
  if (!latest) return source;
  if ("subject" in latest) return latest.subject || "Gmail thread";
  if ("text" in latest) return "chat" in latest ? latest.chat : source;
  return latest.title || source;
}

function groupSourceLabel(source: EventGroup["source"], events: RawEvent[]): string {
  const latest = events.at(-1);
  if (!latest) return source;
  if ("accountEmail" in latest && latest.accountEmail) return latest.accountEmail;
  if ("chat" in latest) return `Telegram · ${latest.chat}`;
  if (source === "youtube") {
    const channel = "channel" in latest ? latest.channel : undefined;
    return channel ? `YouTube · ${channel}` : "YouTube";
  }
  if (source === "twitter") {
    const username = "username" in latest ? latest.username : undefined;
    const actor = "actor" in latest ? latest.actor : undefined;
    return username ? `X · @${username}` : actor ? `X · ${actor}` : "X / Twitter";
  }
  return source;
}

function groupParticipants(source: EventGroup["source"], events: RawEvent[]): string[] {
  const values = events.map((event) => {
    if ("from" in event) return event.from;
    if ("sender" in event) return event.sender;
    if ("actor" in event) return event.actor;
    return source;
  }).filter((value): value is string => Boolean(value));
  return [...new Set(values)].slice(0, 12);
}

function groupSourceUrl(events: RawEvent[]): string | undefined {
  for (const event of events) {
    const sourceUrl = sourceUrlValue(event);
    if (sourceUrl) return sourceUrl;
  }
  return undefined;
}

function sourceUrlValue(event: RawEvent): string | undefined {
  if ("sourceUrl" in event && event.sourceUrl) return event.sourceUrl;
  if ("url" in event && event.url) return event.url;
  return undefined;
}

function eventTimestamp(event: RawEvent): string {
  if ("receivedAt" in event) return event.receivedAt;
  return event.sentAt;
}

function eventTime(event: RawEvent): number {
  return dateMs(eventTimestamp(event));
}

function twitterGroupId(event: TwitterEvent): string {
  return event.conversationId || event.id;
}

function rawEventsFromGroup(group: EventGroup): RawEvents {
  return {
    [group.source]: group.events
  };
}

function mergeRawEvents(a: RawEvents, b: RawEvents): RawEvents {
  return {
    gmail: [...(a.gmail ?? []), ...(b.gmail ?? [])],
    telegram: [...(a.telegram ?? []), ...(b.telegram ?? [])],
    youtube: [...(a.youtube ?? []), ...(b.youtube ?? [])],
    twitter: [...(a.twitter ?? []), ...(b.twitter ?? [])]
  };
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function newestEvents<T>(events: T[], timestamp: (event: T) => string, limit: number): T[] {
  return [...events]
    .sort((a, b) => dateMs(timestamp(b)) - dateMs(timestamp(a)))
    .slice(0, limit);
}

function balancedNewestTelegramEvents(events: TelegramEvent[], limit: number): TelegramEvent[] {
  const groups = new Map<string, TelegramEvent[]>();
  for (const event of events) {
    const key = event.chatId || event.chat;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  const orderedGroups = [...groups.values()].map((group) =>
    group.sort((a, b) => dateMs(b.sentAt) - dateMs(a.sentAt))
  );
  const selected: TelegramEvent[] = [];
  for (let index = 0; selected.length < limit; index += 1) {
    let added = false;
    for (const group of orderedGroups) {
      const event = group[index];
      if (!event) continue;
      selected.push(event);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }

  return selected.sort((a, b) => dateMs(b.sentAt) - dateMs(a.sentAt));
}

function dateMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}\n[truncated ${value.length - limit} chars]`;
}
