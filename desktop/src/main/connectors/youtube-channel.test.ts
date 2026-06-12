import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { AppStore } from "../store";
import { MAX_YOUTUBE_CHANNEL_SOURCES, parseYouTubeChannel, parseYouTubeSource, YouTubeChannelConnector } from "./youtube-channel";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("YouTubeChannelConnector", () => {
  test("parses YouTube channel URLs and handles", () => {
    expect(parseYouTubeChannel("https://www.youtube.com/@allin")).toMatchObject({
      id: "@allin",
      label: "@allin",
      url: "https://www.youtube.com/@allin",
      videosUrl: "https://www.youtube.com/@allin/videos"
    });
    expect(parseYouTubeChannel("@allin")).toMatchObject({
      id: "@allin",
      videosUrl: "https://www.youtube.com/@allin/videos"
    });
    expect(parseYouTubeChannel("https://www.youtube.com/channel/UC123/videos")).toMatchObject({
      id: "channel/UC123",
      url: "https://www.youtube.com/channel/UC123"
    });
    expect(() => parseYouTubeChannel("https://example.com/@allin")).toThrow("YouTube channel URL");
    expect(() => parseYouTubeChannel("https://www.youtube.com/watch?v=abc")).toThrow("YouTube channel URL");
  });

  test("parses direct YouTube video URLs as video sources", () => {
    expect(parseYouTubeSource("https://www.youtube.com/watch?v=N-pust8qtGI")).toMatchObject({
      kind: "video",
      id: "N-pust8qtGI",
      label: "Video N-pust8qtGI",
      url: "https://www.youtube.com/watch?v=N-pust8qtGI"
    });
    expect(parseYouTubeSource("https://youtu.be/vQwXgxJxwnw?si=abc")).toMatchObject({
      kind: "video",
      id: "vQwXgxJxwnw",
      url: "https://www.youtube.com/watch?v=vQwXgxJxwnw"
    });
  });

  test("adds channel sources and scans recent videos with transcript context", async () => {
    const root = path.join(os.tmpdir(), `wdim-youtube-${Date.now()}-${Math.random()}`);
    const store = new AppStore(path.join(root, "state.json"));
    const calls: string[][] = [];
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      return new Response([
        "WEBVTT",
        "",
        "1",
        "00:00:00.000 --> 00:00:02.000",
        "<c>Markets are repricing AI infrastructure.</c>",
        "",
        "2",
        "00:00:02.000 --> 00:00:04.000",
        "The key quote is durable demand, not hype.",
        "",
        "3",
        "00:00:04.000 --> 00:00:06.000",
        "Everybody wants access to these private",
        "Everybody wants access to these private markets &amp; AI liquidity.",
        "",
        "4",
        "00:00:06.000 --> 00:00:08.000",
        "The repeated line should only appear once.",
        "",
        "5",
        "00:00:08.000 --> 00:00:10.000",
        "The repeated line should only appear once."
      ].join("\n"), { status: 200 });
    }) as typeof fetch;
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args.includes("--flat-playlist")) {
        return {
          stderr: "",
          stdout: [
            JSON.stringify({
              id: "new-video",
              title: "AI podcast: what changed this week",
              url: "https://www.youtube.com/watch?v=new-video",
              channel: "All-In Podcast",
              channel_url: "https://www.youtube.com/@allin",
              timestamp: 1767351600
            }),
            JSON.stringify({
              id: "old-video",
              title: "Older upload",
              url: "https://www.youtube.com/watch?v=old-video",
              channel: "All-In Podcast",
              timestamp: 1766660400
            })
          ].join("\n")
        };
      }

      if (args.includes("--dump-json")) {
        return {
          stderr: "",
          stdout: JSON.stringify({
            id: "new-video",
            title: "AI podcast: what changed this week",
            webpage_url: "https://www.youtube.com/watch?v=new-video",
            channel: "All-In Podcast",
            channel_url: "https://www.youtube.com/@allin",
            timestamp: 1767351600,
            duration: 3600,
            view_count: 42000,
            description: "Weekly tech and markets conversation.",
            automatic_captions: {
              "en-orig": [{ ext: "vtt", url: "https://captions.example/new-video.en-orig.vtt" }],
              en: [{ ext: "vtt", url: "https://captions.example/new-video.en.vtt" }]
            }
          })
        };
      }

      const pathsIndex = args.indexOf("--paths");
      const tempDir = args[pathsIndex + 1];
      await mkdir(tempDir, { recursive: true });
      await writeFile(path.join(tempDir, "new-video.en.vtt"), [
        "WEBVTT",
        "",
        "00:00:00.000 --> 00:00:02.000",
        "Translated captions should lose to original English."
      ].join("\n"));
      await writeFile(path.join(tempDir, "new-video.en-orig.vtt"), [
        "WEBVTT",
        "",
        "1",
        "00:00:00.000 --> 00:00:02.000",
        "<c>Markets are repricing AI infrastructure.</c>",
        "",
        "2",
        "00:00:02.000 --> 00:00:04.000",
        "The key quote is durable demand, not hype.",
        "",
        "3",
        "00:00:04.000 --> 00:00:06.000",
        "Everybody wants access to these private",
        "Everybody wants access to these private markets &amp; AI liquidity.",
        "",
        "4",
        "00:00:06.000 --> 00:00:08.000",
        "The repeated line should only appear once.",
        "",
        "5",
        "00:00:08.000 --> 00:00:10.000",
        "The repeated line should only appear once."
      ].join("\n"));
      return {
        stderr: "",
        stdout: ""
      };
    };
    const connector = new YouTubeChannelConnector(store, () => new Date("2026-01-02T12:00:00.000Z"), runner);

    const connection = await connector.addChannel("https://www.youtube.com/@allin");
    const result = await connector.scan(connection, { since: "2026-01-02T00:00:00.000Z" });

    expect(result.health.status).toBe("ready");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      source: "youtube",
      connectionId: connection.id,
      id: "youtube:new-video",
      title: "AI podcast: what changed this week",
      channel: "All-In Podcast",
      url: "https://www.youtube.com/watch?v=new-video",
      duration: 3600,
      viewCount: 42000,
      transcriptSource: "auto"
    });
    const transcript = "transcript" in result.events[0] ? result.events[0].transcript ?? "" : "";
    expect(transcript).toContain("Markets are repricing AI infrastructure.");
    expect(transcript).toContain("The key quote is durable demand, not hype.");
    expect(transcript).toContain("Everybody wants access to these private markets & AI liquidity.");
    expect(transcript.match(/The repeated line should only appear once\./g)).toHaveLength(1);
    expect("body" in result.events[0] ? result.events[0].body : "").toContain("Weekly tech and markets conversation.");
    expect(result.cursors[0]).toMatchObject({
      cursorKey: "channel:last_video_at:summary-v2",
      cursorValue: "2026-01-02T11:00:00.000Z"
    });
    expect(calls[0]).toEqual([
      "--dump-json",
      "--flat-playlist",
      "--playlist-end",
      "20",
      "https://www.youtube.com/@allin/videos"
    ]);
    expect(calls[1]).toEqual([
      "--dump-json",
      "--skip-download",
      "https://www.youtube.com/watch?v=new-video"
    ]);
    expect(calls).toHaveLength(2);
    expect(fetchedUrls).toEqual(["https://captions.example/new-video.en-orig.vtt"]);
  });

  test("caps monitored YouTube channels", async () => {
    const root = path.join(os.tmpdir(), `wdim-youtube-cap-${Date.now()}-${Math.random()}`);
    const store = new AppStore(path.join(root, "state.json"));
    const connector = new YouTubeChannelConnector(store);

    for (let index = 0; index < MAX_YOUTUBE_CHANNEL_SOURCES; index += 1) {
      await connector.addChannel(`https://www.youtube.com/@channel${index}`);
    }

    await expect(connector.addChannel("https://www.youtube.com/@one-too-many"))
      .rejects
      .toThrow(`up to ${MAX_YOUTUBE_CHANNEL_SOURCES} YouTube channels`);

    await expect(connector.addChannel("https://www.youtube.com/watch?v=N-pust8qtGI"))
      .resolves
      .toMatchObject({ config: { kind: "video" } });
  });

  test("uses a seven day first scan window and honors the video budget", async () => {
    const root = path.join(os.tmpdir(), `wdim-youtube-window-${Date.now()}-${Math.random()}`);
    const store = new AppStore(path.join(root, "state.json"));
    const calls: string[][] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response([
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "A recent transcript is available."
    ].join("\n"), { status: 200 })) as typeof fetch;
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args.includes("--flat-playlist")) {
        return {
          stderr: "",
          stdout: [
            JSON.stringify({
              id: "two-days-old",
              title: "Two days old",
              url: "https://www.youtube.com/watch?v=two-days-old",
              timestamp: 1780819200
            }),
            JSON.stringify({
              id: "three-days-old",
              title: "Three days old",
              url: "https://www.youtube.com/watch?v=three-days-old",
              timestamp: 1780732800
            })
          ].join("\n")
        };
      }

      const videoId = args.at(-1)?.split("v=").at(-1) ?? "unknown";
      return {
        stderr: "",
        stdout: JSON.stringify({
          id: videoId,
          title: videoId,
          webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
          timestamp: videoId === "two-days-old" ? 1780819200 : 1780732800,
          automatic_captions: {
            "en-orig": [{ ext: "vtt", url: `https://captions.example/${videoId}.vtt` }]
          }
        })
      };
    };
    const connector = new YouTubeChannelConnector(store, () => new Date("2026-06-09T00:00:00.000Z"), runner);
    const connection = await connector.addChannel("https://www.youtube.com/@allin");

    const result = await connector.scan(connection, {
      since: "2026-06-08T00:00:00.000Z",
      maxVideos: 1
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: "youtube:two-days-old" });
    expect(calls.filter((args) => args.includes("--skip-download"))).toHaveLength(1);
  });

  test("stops fetching YouTube details once detailed upload dates are outside the scan window", async () => {
    const root = path.join(os.tmpdir(), `wdim-youtube-old-${Date.now()}-${Math.random()}`);
    const store = new AppStore(path.join(root, "state.json"));
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args.includes("--flat-playlist")) {
        return {
          stderr: "",
          stdout: [
            JSON.stringify({
              id: "old-karpathy-video",
              title: "Andrej Karpathy — old interview",
              url: "https://www.youtube.com/watch?v=old-karpathy-video",
              channel: "Dwarkesh Patel"
            }),
            JSON.stringify({
              id: "older-video",
              title: "Older interview",
              url: "https://www.youtube.com/watch?v=older-video",
              channel: "Dwarkesh Patel"
            })
          ].join("\n")
        };
      }

      return {
        stderr: "",
        stdout: JSON.stringify({
          id: "old-karpathy-video",
          title: "Andrej Karpathy — old interview",
          webpage_url: "https://www.youtube.com/watch?v=old-karpathy-video",
          channel: "Dwarkesh Patel",
          upload_date: "20251017",
          timestamp: 1760721345
        })
      };
    };
    const connector = new YouTubeChannelConnector(store, () => new Date("2026-06-08T12:00:00.000Z"), runner);

    const connection = await connector.addChannel("https://www.youtube.com/@DwarkeshPatel");
    const result = await connector.scan(connection, { since: "2026-06-01T12:00:00.000Z" });

    expect(result.health.status).toBe("ready");
    expect(result.events).toEqual([]);
    expect(result.cursors).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([
      "--dump-json",
      "--skip-download",
      "https://www.youtube.com/watch?v=old-karpathy-video"
    ]);
  });

  test("scans explicit video URLs once and falls back across caption tracks", async () => {
    const root = path.join(os.tmpdir(), `wdim-youtube-video-${Date.now()}-${Math.random()}`);
    const store = new AppStore(path.join(root, "state.json"));
    const calls: string[][] = [];
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("manual")) {
        return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
      }
      return new Response([
        "WEBVTT",
        "",
        "00:00:00.000 --> 00:00:02.000",
        "The transcript comes from fallback automatic captions."
      ].join("\n"), { status: 200 });
    }) as typeof fetch;
    const runner = async (args: string[]) => {
      calls.push(args);
      return {
        stderr: "",
        stdout: JSON.stringify({
          id: "N-pust8qtGI",
          title: "SpaceX IPO, Iran War Fallout, Quantum Bitcoin Hack, The Space Opportunity",
          webpage_url: "https://www.youtube.com/watch?v=N-pust8qtGI",
          channel: "All-In Podcast",
          channel_url: "https://www.youtube.com/@allin",
          timestamp: 1775252957,
          duration: 4831,
          subtitles: {
            en: [{ ext: "vtt", url: "https://captions.example/manual.en.vtt" }]
          },
          automatic_captions: {
            "en-orig": [{ ext: "vtt", url: "https://captions.example/auto.en-orig.vtt" }]
          }
        })
      };
    };
    const connector = new YouTubeChannelConnector(store, () => new Date("2026-06-09T12:00:00.000Z"), runner);

    const connection = await connector.addChannel("https://www.youtube.com/watch?v=N-pust8qtGI");
    expect(connection).toMatchObject({
      id: "youtube:local:n-pust8qtgi",
      label: "Video N-pust8qtGI",
      config: {
        kind: "video",
        videoId: "N-pust8qtGI",
        url: "https://www.youtube.com/watch?v=N-pust8qtGI"
      }
    });

    const result = await connector.scan(connection, { since: "2026-06-09T00:00:00.000Z" });

    expect(result.health.status).toBe("ready");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      source: "youtube",
      id: "youtube:N-pust8qtGI",
      title: "SpaceX IPO, Iran War Fallout, Quantum Bitcoin Hack, The Space Opportunity",
      channel: "All-In Podcast",
      transcriptSource: "auto"
    });
    expect("transcript" in result.events[0] ? result.events[0].transcript : "").toContain("fallback automatic captions");
    expect(result.cursors[0]).toMatchObject({
      cursorKey: "video:scanned:summary-v2",
      cursorValue: "2026-04-03T21:49:17.000Z"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "--dump-json",
      "--skip-download",
      "https://www.youtube.com/watch?v=N-pust8qtGI"
    ]);
    expect(fetchedUrls).toEqual([
      "https://captions.example/manual.en.vtt",
      "https://captions.example/auto.en-orig.vtt"
    ]);

    await store.saveSourceCursors(result.cursors);
    const second = await connector.scan(connection, { since: "2026-06-09T00:00:00.000Z" });
    expect(second.events).toEqual([]);
  });
});
