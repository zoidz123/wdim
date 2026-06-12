import { describe, expect, test } from "bun:test";
import { buildTriagePrompt, compactEventsForPrompt, groupEvents, planGroupedScan, sampleGmailEvents } from ".";

describe("shared triage context", () => {
  test("builds a prompt with Gmail and Telegram context", () => {
    const prompt = buildTriagePrompt({
      gmail: [{ id: "gm_1", threadId: "thread_1", accountEmail: "work@example.com", from: "a@example.com", subject: "Approve today", snippet: "Please approve today.", body: "Please approve today.", receivedAt: "2026-06-02T10:00:00-04:00" }],
      telegram: [{ id: "tg_1", chat: "Launch", sender: "Maya", text: "We are blocked.", sentAt: "2026-06-02T11:00:00-04:00", mentionedMe: true }]
    });

    expect(prompt).toContain("What Did I Miss?");
    expect(prompt).toContain("Approve today");
    expect(prompt).toContain("thread_1");
    expect(prompt).toContain("work@example.com");
    expect(prompt).toContain("We are blocked.");
  });

  test("prompt asks for empty findings when nothing is important", () => {
    const prompt = buildTriagePrompt({
      gmail: [{ id: "gm_news", from: "news@example.com", subject: "Weekly newsletter", body: "Links and general updates.", receivedAt: "2026-06-02T10:00:00-04:00", read: true }]
    });

    expect(prompt).toContain("Return {\"findings\":[]} when nothing is important");
    expect(prompt).toContain("Do not summarize every individual Telegram message");
    expect(prompt).toContain("When unsure whether a Gmail item matters, omit it");
  });

  test("prompt asks Telegram to summarize selected chat conversations", () => {
    const prompt = buildTriagePrompt({
      telegram: [
        { id: "tg_1", chat: "Traders", sender: "Maya", text: "People are rotating into SOL beta this morning.", sentAt: "2026-06-02T11:00:00-04:00" },
        { id: "tg_2", chat: "Traders", sender: "Alex", text: "Main action item is to watch the unlock at noon.", sentAt: "2026-06-02T11:01:00-04:00" }
      ]
    });

    expect(prompt).toContain("Telegram task: summarize the selected group/channel conversations");
    expect(prompt).toContain("Prefer one finding per selected chat/topic");
    expect(prompt).toContain("Put the conversation summary in `why`");
    expect(prompt).toContain("No action needed");
  });

  test("builds a prompt with Twitter timeline context", () => {
    const prompt = buildTriagePrompt({
      twitter: [{
        id: "1801576800000000000",
        title: "X post by @zoidz123: WDIM shipped Twitter timeline monitoring.",
        body: "WDIM shipped Twitter timeline monitoring.",
        actor: "@zoidz123",
        url: "https://x.com/zoidz123/status/1801576800000000000",
        receivedAt: "2026-06-04T10:04:00.000Z",
        username: "zoidz123",
        conversationId: "1801576800000000000",
        publicMetrics: { like_count: 42 }
      }]
    });

    expect(prompt).toContain("Twitter/X task");
    expect(prompt).toContain("ignore memes, generic takes, engagement bait");
    expect(prompt).toContain("\"source\": \"twitter\"");
    expect(prompt).toContain("\"sourceLabel\": \"X · @zoidz123\"");
    expect(prompt).toContain("https://x.com/zoidz123/status/1801576800000000000");
  });

  test("builds a YouTube prompt around generated episode summaries", () => {
    const episodeSummary = "- AI found several classes of vulnerabilities.\n- Defenders need faster automation loops.";
    const prompt = buildTriagePrompt({
      youtube: [{
        id: "youtube:video_1",
        title: "Palo Alto CEO on AI security",
        body: "Episode summary:\n" + episodeSummary,
        actor: "All-In Podcast",
        url: "https://www.youtube.com/watch?v=video_1",
        receivedAt: "2026-06-08T20:06:00.000Z",
        channel: "All-In Podcast",
        episodeSummary,
        transcriptSource: "auto"
      }]
    });

    expect(prompt).toContain("YouTube task: preserve supplied episode summaries for monitored videos/podcasts");
    expect(prompt).toContain("supplied episode summary");
    expect(prompt).toContain("understand the substance without watching");
    expect(prompt).toContain("roughly 120-220 words");
    expect(prompt).toContain("Palo Alto CEO on AI security");
    expect(prompt).toContain("AI found several classes of vulnerabilities");
  });

  test("keeps YouTube episode summaries in prompt context while dropping raw transcripts", () => {
    const transcript = "y".repeat(5000);
    const episodeSummary = "- Important point from the full transcript.";
    const compacted = compactEventsForPrompt({
      youtube: [{
        id: "youtube:long_video",
        title: "Long podcast",
        body: "Description.",
        receivedAt: "2026-06-08T20:06:00.000Z",
        transcript,
        episodeSummary,
        transcriptSource: "auto"
      }]
    });

    expect(compacted.youtube?.[0]?.transcript).toBe("");
    expect(compacted.youtube?.[0]?.episodeSummary).toBe(episodeSummary);
  });

  test("prompt requires findings to map back to source events", () => {
    const prompt = buildTriagePrompt({
      gmail: [{ id: "gm_1", accountEmail: "work@example.com", from: "a@example.com", subject: "Approve today", body: "Please approve today.", receivedAt: "2026-06-02T10:00:00-04:00" }]
    });

    expect(prompt).toContain("Return at most 10 findings");
    expect(prompt).toContain("Never invent source ids");
    expect(prompt).toContain("Only include findings that map back");
  });

  test("prompt compacts long message bodies while preserving source metadata", () => {
    const body = "a".repeat(2000);
    const prompt = buildTriagePrompt({
      gmail: [{ id: "gm_long", accountEmail: "work@example.com", from: "a@example.com", subject: "Long body", body, receivedAt: "2026-06-02T10:00:00-04:00" }]
    });

    expect(prompt).toContain("gm_long");
    expect(prompt).toContain("work@example.com");
    expect(prompt).toContain("[truncated 500 chars]");
    expect(prompt).not.toContain(body);
  });

  test("compacts Telegram text before prompt serialization", () => {
    const text = "b".repeat(1200);
    const compacted = compactEventsForPrompt({
      telegram: [{ id: "tg_long", chat: "Launch", sender: "Maya", text, sentAt: "2026-06-02T11:00:00-04:00" }]
    });

    expect(compacted.telegram?.[0]?.id).toBe("tg_long");
    expect(compacted.telegram?.[0]?.text).toContain("[truncated 200 chars]");
  });

  test("caps prompt event volume to the newest Gmail and Telegram items", () => {
    const compacted = compactEventsForPrompt({
      gmail: Array.from({ length: 50 }, (_, index) => ({
        id: `gm_${index}`,
        from: "a@example.com",
        subject: `Message ${index}`,
        body: "Please review.",
        receivedAt: new Date(Date.UTC(2026, 5, 2, 10, index)).toISOString()
      })),
      telegram: Array.from({ length: 90 }, (_, index) => ({
        id: `tg_${index}`,
        chat: "Launch",
        sender: "Maya",
        text: "Please review.",
        sentAt: new Date(Date.UTC(2026, 5, 2, 11, index)).toISOString()
      }))
    });

    expect(compacted.gmail).toHaveLength(40);
    expect(compacted.telegram).toHaveLength(80);
    expect(compacted.gmail?.[0]?.id).toBe("gm_49");
    expect(compacted.telegram?.[0]?.id).toBe("tg_89");
  });

  test("balances Telegram prompt volume across chats", () => {
    const compacted = compactEventsForPrompt({
      telegram: [
        ...Array.from({ length: 100 }, (_, index) => ({
          id: `busy_${index}`,
          chatId: "busy",
          chat: "Busy chat",
          sender: "Maya",
          text: "Busy chat update.",
          sentAt: new Date(Date.UTC(2026, 5, 2, 12, index)).toISOString()
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `quiet_${index}`,
          chatId: "quiet",
          chat: "Quiet chat",
          sender: "Alex",
          text: "Quiet chat update.",
          sentAt: new Date(Date.UTC(2026, 5, 2, 10, index)).toISOString()
        }))
      ]
    });

    expect(compacted.telegram).toHaveLength(80);
    expect(compacted.telegram?.some((event) => event.chatId === "quiet")).toBe(true);
  });

  test("prompt defines high priority as blocked or time-sensitive", () => {
    const prompt = buildTriagePrompt({
      gmail: [{ id: "gm_1", accountEmail: "work@example.com", from: "a@example.com", subject: "Approve today", body: "Please approve today.", receivedAt: "2026-06-02T10:00:00-04:00" }]
    });

    expect(prompt).toContain("high: someone is blocked");
    expect(prompt).toContain("medium: direct ask");
    expect(prompt).toContain("low: useful Telegram context");
  });

  test("sample Gmail events include inbox labels and source links for smoke tests", () => {
    expect(sampleGmailEvents).toHaveLength(2);
    expect(sampleGmailEvents.map((event) => event.accountEmail).sort()).toEqual(["personal@example.com", "work@example.com"]);
    expect(sampleGmailEvents.every((event) => event.threadId)).toBe(true);
    expect(sampleGmailEvents.every((event) => event.snippet)).toBe(true);
    expect(sampleGmailEvents.some((event) => event.sourceUrl?.startsWith("https://mail.google.com/"))).toBe(true);
  });

  test("groups source events by the natural conversation unit", () => {
    const groups = groupEvents({
      gmail: [
        { id: "gm_1", threadId: "thread_1", accountEmail: "work@example.com", from: "a@example.com", subject: "Approve", body: "Can you approve?", receivedAt: "2026-06-02T10:00:00.000Z" },
        { id: "gm_2", threadId: "thread_1", accountEmail: "work@example.com", from: "b@example.com", subject: "Re: Approve", body: "This is blocked.", receivedAt: "2026-06-02T10:05:00.000Z" }
      ],
      telegram: [
        { id: "tg_1", chatId: "chat_1", chat: "Launch", sender: "Maya", text: "Can you review?", sentAt: "2026-06-02T10:06:00.000Z" },
        { id: "tg_2", chatId: "chat_1", chat: "Launch", sender: "Ari", text: "Need it today.", sentAt: "2026-06-02T10:07:00.000Z" }
      ]
    });

    expect(groups).toContainEqual(expect.objectContaining({ source: "gmail", eventCount: 2, id: "gmail:work@example.com:thread_1" }));
    expect(groups).toContainEqual(expect.objectContaining({ source: "telegram", eventCount: 2, sourceLabel: "Telegram · Launch" }));
  });

  test("adds local signals before Codex triage", () => {
    const [group] = groupEvents({
      telegram: [{
        id: "tg_review",
        chatId: "chat_ops",
        chat: "Ops",
        sender: "Maya",
        text: "Can you review? Production checkout is failing and users are blocked today.",
        sentAt: "2026-06-02T10:00:00.000Z",
        mentionedMe: true
      }]
    });

    expect(group?.signals).toEqual(expect.arrayContaining([
      "mention",
      "risk_keyword",
      "urgent_keyword",
      "question_or_request"
    ]));
    expect(group?.score).toBeGreaterThan(8);
  });

  test("plans default and overflow grouped scan routes without dropping groups", () => {
    const smallGroups = groupEvents({
      gmail: [{ id: "gm_1", from: "a@example.com", subject: "Short", body: "Please review.", receivedAt: "2026-06-02T10:00:00.000Z" }]
    });
    const defaultPlan = planGroupedScan(smallGroups, { defaultTokenLimit: 100_000, batchTokenLimit: 50_000 });

    expect(defaultPlan.route).toBe("default");
    expect(defaultPlan.groupCount).toBe(1);
    expect(defaultPlan.rawEventCount).toBe(1);

    const largeGroups = groupEvents({
      telegram: Array.from({ length: 6 }, (_, index) => ({
        id: `tg_${index}`,
        chatId: `chat_${index}`,
        chat: `Chat ${index}`,
        sender: "Maya",
        text: `Need review today. ${"x".repeat(800)}`,
        sentAt: new Date(Date.UTC(2026, 5, 2, 10, index)).toISOString()
      }))
    });
    const overflowPlan = planGroupedScan(largeGroups, { defaultTokenLimit: 100, batchTokenLimit: 800 });

    expect(overflowPlan.route).toBe("overflow");
    expect(overflowPlan.rawEventCount).toBe(6);
    expect(overflowPlan.batches.flat()).toHaveLength(6);
    expect(new Set(overflowPlan.batches.flat().map((group) => group.id)).size).toBe(6);
  });

  test("splits a single oversized conversation group into chronological chunks", () => {
    const [group] = groupEvents({
      telegram: Array.from({ length: 5 }, (_, index) => ({
        id: `tg_big_${index}`,
        chatId: "busy_chat",
        chat: "Busy chat",
        sender: `User ${index}`,
        text: `Important update ${index}. ${"x".repeat(1200)}`,
        sentAt: new Date(Date.UTC(2026, 5, 2, 10, index)).toISOString()
      }))
    });
    const plan = planGroupedScan(group ? [group] : [], { defaultTokenLimit: 100, batchTokenLimit: 500 });
    const chunks = plan.batches.flat();

    expect(plan.route).toBe("overflow");
    expect(plan.oversizedGroupCount).toBe(1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((chunk) => chunk.events.map((event) => event.id))).toEqual([
      "tg_big_0",
      "tg_big_1",
      "tg_big_2",
      "tg_big_3",
      "tg_big_4"
    ]);
  });
});
