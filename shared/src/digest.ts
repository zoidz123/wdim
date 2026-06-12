// Digest cards: the per-source, per-run output unit of WDIM.
//
// Every loop run, each synthesis source (Twitter, Gmail, Telegram) produces ONE
// card with at most MAX_DIGEST_BULLETS bullets plus a receipt of how much was
// read and skipped. This replaces the old per-item findings feed. YouTube keeps
// its per-video summary and is adapted into a DigestCard by the desktop app.

export const MAX_DIGEST_BULLETS = 5;

// Prompt size guards. A Twitter run can fetch 300 posts; untruncated,
// pretty-printed JSON balloons past the Codex turn timeout. Keep the newest
// events, truncate each item's text, and stay under a total character budget
// (~30k tokens at 4 chars/token).
export const MAX_DIGEST_PROMPT_EVENTS = 300;
export const DIGEST_EVENT_TEXT_LIMIT = 500;
export const DIGEST_PROMPT_CHAR_BUDGET = 120_000;

export type DigestSource = "gmail" | "telegram" | "youtube" | "twitter";

export type DigestBullet = {
  title: string; // bold headline: what happened
  detail: string; // regular text: why it matters / context
  attribution?: string; // who: e.g. "@sama", "Maya in Launch", "maya@acme.com"
  recipient?: string; // context-aware target, e.g. Gmail account that received the email
  timestamp?: string; // when: ISO timestamp of the underlying item
  sourceUrl?: string; // deep link to the underlying item
};

export type DigestCard = {
  id: string;
  scanId: string;
  source: DigestSource;
  windowStart: string;
  windowEnd: string;
  fetchedCount: number; // raw items read this run
  surfacedCount: number; // bullets.length (or video count for YouTube)
  skippedCount: number; // fetchedCount - surfacedCount
  skippedSummary?: string; // "sports bets, memecoin shills, ~6 bait threads"
  bullets: DigestBullet[];
  generatedAt: string;
};

// Minimal event shape the digest prompt needs. The desktop app maps its richer
// RawEvent types down to this before building the prompt.
export type DigestPromptEvent = {
  id: string;
  text: string;
  author?: string;
  recipient?: string;
  url?: string;
  receivedAt?: string;
  metrics?: Record<string, number>;
};

export type DigestWindow = { start: string; end: string };

const SOURCE_LABEL: Record<DigestSource, string> = {
  twitter: "X / Twitter",
  youtube: "YouTube",
  gmail: "Gmail",
  telegram: "Telegram"
};

// Source-specific guidance. The shared rules (cap, consensus signal, receipt,
// skip honesty) live in buildDigestCardPrompt; these add per-source nuance.
function sourceGuidance(source: DigestSource): string[] {
  switch (source) {
    case "twitter":
      return [
        "These are posts from the user's X / Twitter For You timeline.",
        "Treat how many distinct accounts are talking about the same topic as useful context, but lead with the substantive thing that happened.",
        "Ignore engagement bait, memecoin shilling, sports/betting flexes, generic takes, and low-context personal posts."
      ];
    case "youtube":
      return [
        "These are new videos from the user's monitored channels, with episode summaries.",
        "Treat agreement across channels as an importance signal, e.g. 'three of your channels converged on <topic>'.",
        "Lead with the substance of what was said, not the video titles."
      ];
    case "gmail":
      return [
        "These are emails from the user's inbox.",
        "Surface genuine obligations, deadlines, approvals, and decisions; ignore newsletters, promotions, and receipts unless they are clearly important.",
        "When several emails concern the same thread or topic, say so."
      ];
    case "telegram":
      return [
        "These are messages from the user's selected Telegram chats and channels.",
        "Summarize meaningful conversations at the chat/topic level; do not echo individual messages.",
        "Call out direct asks, mentions, decisions, and deadlines."
      ];
  }
}

// Newest events first, per-event text truncated, total payload capped. Counts
// in the prompt header still reflect everything fetched so the receipt is honest.
export function compactDigestEventsForPrompt(events: DigestPromptEvent[]): DigestPromptEvent[] {
  const newestFirst = [...events]
    .sort((a, b) => digestEventMs(b) - digestEventMs(a))
    .slice(0, MAX_DIGEST_PROMPT_EVENTS)
    .map((event) => ({
      ...event,
      text: truncateDigestText(event.text, DIGEST_EVENT_TEXT_LIMIT)
    }));

  const compacted: DigestPromptEvent[] = [];
  let usedChars = 0;
  for (const event of newestFirst) {
    const eventChars = JSON.stringify(event).length + 1;
    if (compacted.length && usedChars + eventChars > DIGEST_PROMPT_CHAR_BUDGET) break;
    compacted.push(event);
    usedChars += eventChars;
  }
  return compacted;
}

function digestEventMs(event: DigestPromptEvent): number {
  const ms = event.receivedAt ? new Date(event.receivedAt).getTime() : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function truncateDigestText(value: string, limit: number): string {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()} [truncated]`;
}

export function buildDigestCardPrompt(
  source: DigestSource,
  events: DigestPromptEvent[],
  window: DigestWindow
): string {
  const promptEvents = compactDigestEventsForPrompt(events);
  return [
    "You are a catch-up analyst for the product 'What Did I Miss?'.",
    `Source: ${SOURCE_LABEL[source]}.`,
    `Window: ${window.start} to ${window.end}.`,
    `Items fetched this run: ${events.length}.`,
    ...(promptEvents.length < events.length
      ? [`Showing the ${promptEvents.length} most recent items below; the rest were older or overflow.`]
      : []),
    "",
    "Your job is to read everything and return only what would have been worth the user's time.",
    "You maximize exclusion, not coverage. A feed shows everything; you show the few things that matter and admit what you ignored.",
    "",
    ...sourceGuidance(source),
    "",
    "Each bullet has two parts, like an analyst's note:",
    "- title: a short, bold headline stating WHAT happened (the substantive thing, not 'N people discussed X').",
    "- detail: one or two sentences on WHY it matters / what the takeaway is.",
    "Lead with the substance. Do NOT frame bullets as 'X accounts are talking about Y' — the user cares what happened and why it's worth knowing, not the head-count. If broad agreement across sources is itself the point, you may mention it inside detail, but never as the headline.",
    "",
    "Also attribute each bullet:",
    "- attribution: WHO said or sent it — the key account, sender, or author (e.g. '@sama', 'Maya in Launch', 'maya@acme.com'). If it spans several, name the most relevant one.",
    "- timestamp: WHEN — the ISO timestamp of the underlying item.",
    "",
    "Output rules:",
    `- Return at most ${MAX_DIGEST_BULLETS} bullets. Fewer is better. Return zero bullets if nothing was worth surfacing.`,
    "- Include a sourceUrl when one is available so the user can open the original.",
    "- Provide a skippedSummary: a short phrase describing the kinds of low-signal items you ignored (e.g. 'promos, memes, ~30 routine posts').",
    "",
    "Return JSON only with this shape:",
    '{"bullets":[{"title":"...","detail":"...","attribution":"...","timestamp":"...","sourceUrl":"..."}],"skippedSummary":"..."}',
    "Never invent source URLs, authors, timestamps, or facts not present in the items.",
    "",
    "Items JSON:",
    JSON.stringify(promptEvents)
  ].join("\n");
}

export function capDigestBullets(bullets: DigestBullet[] | undefined): DigestBullet[] {
  if (!bullets || !bullets.length) return [];
  return bullets.slice(0, MAX_DIGEST_BULLETS);
}

export type DigestResponse = {
  bullets: DigestBullet[];
  skippedSummary?: string;
};

// Parse a model response into a capped, validated digest. Tolerates code fences
// and surrounding prose by extracting the first JSON object.
export function parseDigestResponse(raw: string): DigestResponse {
  const parsed = extractJsonObject(raw);
  if (!parsed) return { bullets: [] };

  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets
        .map(normalizeBullet)
        .filter((bullet): bullet is DigestBullet => Boolean(bullet))
    : [];
  const skippedSummary = typeof parsed.skippedSummary === "string" && parsed.skippedSummary.trim()
    ? parsed.skippedSummary.trim()
    : undefined;

  return { bullets: capDigestBullets(bullets), skippedSummary };
}

function normalizeBullet(value: unknown): DigestBullet | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const detail = typeof record.detail === "string" ? record.detail.trim() : "";
  // A bullet needs at least a headline. Tolerate older single-field output by
  // promoting `text` into the title.
  const fallback = typeof record.text === "string" ? record.text.trim() : "";
  if (!title && !fallback) return null;
  const str = (key: string) => (typeof record[key] === "string" && record[key].trim() ? String(record[key]).trim() : undefined);
  return {
    title: title || fallback,
    detail: title ? detail : "",
    attribution: str("attribution"),
    recipient: str("recipient"),
    timestamp: str("timestamp"),
    sourceUrl: str("sourceUrl")
  };
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
