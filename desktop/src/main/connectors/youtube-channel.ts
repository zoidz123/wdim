import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { YouTubeTranscriptCue } from "@what-did-i-miss/shared";
import type { AppStore } from "../store";
import type { ConnectorHealth, SourceConnection, SourceConnector, SourceCursor, SourceEvent, SourceScanContext } from "./types";
import { makeSourceConnectionId } from "./types";

const execFileAsync = promisify(execFile);
const DISCOVERY_LIMIT = 20;
export const MAX_YOUTUBE_CHANNEL_SOURCES = 10;
const YOUTUBE_PIPELINE_VERSION = "summary-v2";
const FIRST_SCAN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

type YtDlpRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

type YouTubeChannel = {
  kind: "channel";
  id: string;
  label: string;
  url: string;
  videosUrl: string;
};

type YouTubeVideo = {
  kind: "video";
  id: string;
  label: string;
  url: string;
};

type YouTubeSourceConfig = YouTubeChannel | YouTubeVideo;

type VideoEntry = {
  id: string;
  title: string;
  url: string;
  channel?: string;
  channelUrl?: string;
  uploadDate?: string;
  timestamp?: number;
  duration?: number;
  viewCount?: number;
  description?: string;
};

export class YouTubeChannelConnector implements SourceConnector {
  readonly source = "youtube" as const;
  readonly backend = "local" as const;
  private readonly runYtDlp: YtDlpRunner;

  constructor(
    private readonly store: AppStore,
    private readonly now: () => Date = () => new Date(),
    runYtDlp?: YtDlpRunner,
    ytDlpBinary?: string
  ) {
    this.runYtDlp = runYtDlp ?? ((args) => defaultYtDlpRunner(args, ytDlpBinary));
  }

  async addChannel(input: string): Promise<SourceConnection> {
    const source = parseYouTubeSource(input);
    if (source.kind === "channel") {
      const channelCount = (await this.listConnections())
        .filter((connection) => connection.enabled && connection.config?.kind === "channel")
        .length;
      if (channelCount >= MAX_YOUTUBE_CHANNEL_SOURCES) {
        throw new Error(`You can monitor up to ${MAX_YOUTUBE_CHANNEL_SOURCES} YouTube channels.`);
      }
    }
    const now = this.now().toISOString();
    const connection: SourceConnection = {
      id: makeSourceConnectionId("youtube", "local", source.id.toLowerCase()),
      source: "youtube",
      backend: "local",
      label: source.label,
      accountIdentifier: source.label,
      externalAccountId: null,
      enabled: true,
      config: source.kind === "channel"
        ? {
            kind: "channel",
            url: source.url,
            videosUrl: source.videosUrl
          }
        : {
            kind: "video",
            videoId: source.id,
            url: source.url
          },
      connectedAt: now,
      updatedAt: now
    };
    await this.store.saveSourceConnection(connection);
    return connection;
  }

  async listConnections(): Promise<SourceConnection[]> {
    return (await this.store.listSourceConnections())
      .filter((connection) =>
        connection.source === "youtube"
        && connection.backend === "local"
        && (connection.config?.kind === "channel" || connection.config?.kind === "video")
      );
  }

  async scan(connection: SourceConnection, context?: SourceScanContext): Promise<{
    events: SourceEvent[];
    cursors: SourceCursor[];
    health: ConnectorHealth;
  }> {
    const now = this.now().toISOString();
    try {
      const source = sourceFromConnection(connection);
      const cursorKey = source.kind === "channel"
        ? `channel:last_video_at:${YOUTUBE_PIPELINE_VERSION}`
        : `video:scanned:${YOUTUBE_PIPELINE_VERSION}`;
      const cursor = await this.store.getSourceCursor(connection.id, cursorKey);
      const events = source.kind === "channel"
        ? await this.scanChannel(source, connection.id, cursor?.cursorValue, context)
        : await this.scanVideo(source, connection.id, cursor?.cursorValue, context);
      const newestAt = newestReceivedAt(events);
      return {
        events,
        cursors: (newestAt || (source.kind === "video" && events.length)) ? [{
          connectionId: connection.id,
          cursorKey,
          cursorValue: newestAt ?? now,
          updatedAt: now
        }] : [],
        health: {
          connectionId: connection.id,
          status: "ready",
          detail: "YouTube channel source ready",
          checkedAt: now
        }
      };
    } catch (error) {
      return {
        events: [],
        cursors: [],
        health: {
          connectionId: connection.id,
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: now
        }
      };
    }
  }

  private async scanChannel(
    channel: YouTubeChannel,
    connectionId: string,
    cursorValue: string | undefined,
    context?: SourceScanContext
  ): Promise<SourceEvent[]> {
    const since = latestIso([
      cursorValue,
      cursorValue ? context?.since : undefined,
      new Date(this.now().getTime() - FIRST_SCAN_LOOKBACK_MS).toISOString()
    ]);
    const maxVideos = maxVideosFromContext(context);
    console.info("[youtube] channel scan start", {
      connectionId,
      channel: channel.label,
      since,
      discoveryLimit: DISCOVERY_LIMIT,
      maxVideos
    });
    const videos = await this.fetchChannelVideos(channel);
    console.info("[youtube] channel discovery complete", { connectionId, channel: channel.label, discovered: videos.length });
    return this.enrichRecentVideos(videos, connectionId, since, maxVideos);
  }

  private async scanVideo(video: YouTubeVideo, connectionId: string, cursorValue: string | undefined, context?: SourceScanContext): Promise<SourceEvent[]> {
    if (cursorValue) {
      console.info("[youtube] explicit video already scanned", { connectionId, videoId: video.id, cursorValue });
      return [];
    }
    if (maxVideosFromContext(context) <= 0) {
      console.info("[youtube] explicit video skipped by scan budget", { connectionId, videoId: video.id });
      return [];
    }
    console.info("[youtube] explicit video scan start", { connectionId, videoId: video.id, url: video.url });
    const details = await this.fetchVideoDetails({
      id: video.id,
      title: video.label,
      url: video.url
    }).catch((error) => {
      console.warn("[youtube] explicit video detail failed", {
        connectionId,
        videoId: video.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    });
    if (!details) return [];
    const enriched = { ...details.video, id: details.video.id || video.id, title: details.video.title || video.label, url: details.video.url || video.url };
    console.info("[youtube] explicit video scan complete", {
      connectionId,
      videoId: enriched.id,
      title: enriched.title,
      transcriptSource: details.transcriptSource,
      transcriptChars: details.transcript.length
    });
    return [this.sourceEventFromVideo(enriched, details, connectionId)];
  }

  private async fetchChannelVideos(channel: YouTubeChannel): Promise<VideoEntry[]> {
    const { stdout } = await this.runYtDlp([
      "--dump-json",
      "--flat-playlist",
      "--playlist-end",
      String(DISCOVERY_LIMIT),
      channel.videosUrl
    ]);
    return parseJsonLines(stdout)
      .map((item) => videoEntryFromYtDlp(item, channel))
      .filter((video): video is VideoEntry => Boolean(video))
      .sort((a, b) => new Date(videoReceivedAt(b)).getTime() - new Date(videoReceivedAt(a)).getTime());
  }

  private async enrichRecentVideos(videos: VideoEntry[], connectionId: string, since: string, maxVideos = Number.POSITIVE_INFINITY): Promise<SourceEvent[]> {
    const events: SourceEvent[] = [];
    for (const video of videos) {
      if (events.length >= maxVideos) {
        console.info("[youtube] channel scan budget exhausted", { connectionId, maxVideos });
        break;
      }
      if (hasKnownReceivedAt(video) && new Date(videoReceivedAt(video)).getTime() < new Date(since).getTime()) break;
      const details = await this.fetchVideoDetails(video).catch((error) => {
        console.warn("[youtube] video detail failed", {
          connectionId,
          videoId: video.id,
          error: error instanceof Error ? error.message : String(error)
        });
        return { video, transcript: "", transcriptSource: "none" as const };
      });
      const enriched = { ...video, ...details.video };
      if (new Date(videoReceivedAt(enriched)).getTime() < new Date(since).getTime()) break;
      console.info("[youtube] recent video enriched", {
        connectionId,
        videoId: enriched.id,
        title: enriched.title,
        receivedAt: videoReceivedAt(enriched),
        transcriptSource: details.transcriptSource,
        transcriptChars: details.transcript.length
      });
      events.push(this.sourceEventFromVideo(enriched, details, connectionId));
    }
    return events;
  }

  private sourceEventFromVideo(
    video: VideoEntry,
    details: { transcript: string; transcriptCues?: YouTubeTranscriptCue[]; transcriptSource: "manual" | "auto" | "none" },
    connectionId: string
  ): SourceEvent {
    return {
      source: "youtube",
      connectionId,
      id: `youtube:${video.id}`,
      title: video.title,
      body: buildVideoBody(video, details.transcript),
      actor: video.channel,
      url: video.url,
      receivedAt: videoReceivedAt(video),
      channel: video.channel,
      channelUrl: video.channelUrl,
      duration: video.duration,
      viewCount: video.viewCount,
      transcript: details.transcript,
      transcriptCues: details.transcriptCues,
      transcriptCharCount: details.transcript.length,
      transcriptSource: details.transcriptSource
    };
  }

  private async fetchVideoDetails(video: VideoEntry): Promise<{ video: VideoEntry; transcript: string; transcriptCues: YouTubeTranscriptCue[]; transcriptSource: "manual" | "auto" | "none" }> {
    console.info("[youtube] video metadata start", { videoId: video.id, url: video.url });
    const { stdout } = await this.runYtDlp([
      "--dump-json",
      "--skip-download",
      video.url
    ]);
    const [raw] = parseJsonLines(stdout);
    const detail = videoEntryFromYtDlp(raw, {
      kind: "channel",
      id: video.id,
      label: video.channel ?? "YouTube",
      url: video.url,
      videosUrl: video.url
    }) ?? video;
    const transcriptDetails: { transcript: string; transcriptCues: YouTubeTranscriptCue[]; transcriptSource: "manual" | "auto" | "none" } = raw
      ? await fetchTranscriptFromInfo(raw, detail.id)
      : { transcript: "", transcriptCues: [], transcriptSource: "none" as const };
    console.info("[youtube] video metadata complete", {
      videoId: detail.id,
      title: detail.title,
      channel: detail.channel,
      uploadDate: detail.uploadDate,
      timestamp: detail.timestamp,
      transcriptSource: transcriptDetails.transcriptSource,
      transcriptChars: transcriptDetails.transcript.length
    });
    return {
      video: { ...video, ...detail },
      transcript: transcriptDetails.transcript,
      transcriptCues: transcriptDetails.transcriptCues,
      transcriptSource: transcriptDetails.transcriptSource
    };
  }
}

export function parseYouTubeSource(input: string): YouTubeSourceConfig {
  return parseYouTubeVideo(input) ?? parseYouTubeChannel(input);
}

export function parseYouTubeChannel(input: string): YouTubeChannel {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value.startsWith("http") ? value : `https://www.youtube.com/${value}`);
  } catch {
    throw new Error("Enter a YouTube channel URL like https://www.youtube.com/@allin.");
  }
  if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
    throw new Error("Enter a YouTube channel URL like https://www.youtube.com/@allin.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  if (!first || first === "watch" || first === "shorts") {
    throw new Error("Enter a YouTube channel URL like https://www.youtube.com/@allin.");
  }
  const channelPath = first === "channel" || first === "c" || first === "user"
    ? `/${first}/${parts[1] ?? ""}`
    : `/${first}`;
  if (channelPath.endsWith("/")) throw new Error("Enter a YouTube channel URL like https://www.youtube.com/@allin.");
  const baseUrl = `https://www.youtube.com${channelPath}`;
  const label = channelPath.split("/").filter(Boolean).join("/") || first;
  return {
    kind: "channel",
    id: label,
    label,
    url: baseUrl,
    videosUrl: `${baseUrl}/videos`
  };
}

function parseYouTubeVideo(input: string): YouTubeVideo | null {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value.startsWith("http") ? value : `https://www.youtube.com/watch?v=${value}`);
  } catch {
    return null;
  }
  const isWatchUrl = ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname) && url.pathname === "/watch";
  const isShortUrl = url.hostname === "youtu.be";
  if (!isWatchUrl && !isShortUrl) return null;
  const id = isWatchUrl ? url.searchParams.get("v") ?? "" : url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (!isYouTubeVideoId(id)) return null;
  return {
    kind: "video",
    id,
    label: `Video ${id}`,
    url: normalizedVideoUrl(id)
  };
}

function sourceFromConnection(connection: SourceConnection): YouTubeSourceConfig {
  if (connection.config?.kind === "video") {
    const url = stringValue(connection.config.url);
    const videoId = stringValue(connection.config.videoId) ?? videoIdFromUrl(url ?? "");
    if (!videoId) throw new Error("YouTube video source is missing video metadata.");
    return {
      kind: "video",
      id: videoId,
      label: connection.label || `Video ${videoId}`,
      url: normalizedVideoUrl(videoId, url)
    };
  }

  const url = stringValue(connection.config?.url);
  const videosUrl = stringValue(connection.config?.videosUrl);
  if (!url || !videosUrl) throw new Error("YouTube channel source is missing channel metadata.");
  return {
    kind: "channel",
    id: connection.accountIdentifier ?? connection.label,
    label: connection.label,
    url,
    videosUrl
  };
}

async function defaultYtDlpRunner(args: string[], preferredBinary?: string): Promise<{ stdout: string; stderr: string }> {
  const binary = preferredBinary && existsSync(preferredBinary) ? preferredBinary : "yt-dlp";
  const result = await execFileAsync(binary, args, {
    timeout: 90_000,
    maxBuffer: 20 * 1024 * 1024
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr)
  };
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

function videoEntryFromYtDlp(item: Record<string, unknown> | undefined, channel: YouTubeChannel): VideoEntry | null {
  if (!item) return null;
  const id = stringValue(item.id) ?? videoIdFromUrl(stringValue(item.url) ?? stringValue(item.webpage_url) ?? "");
  const title = stringValue(item.title);
  if (!id || !title) return null;
  const url = normalizedVideoUrl(id, stringValue(item.webpage_url) ?? stringValue(item.url));
  return {
    id,
    title,
    url,
    channel: stringValue(item.channel) ?? stringValue(item.uploader) ?? channel.label,
    channelUrl: stringValue(item.channel_url) ?? channel.url,
    uploadDate: stringValue(item.upload_date),
    timestamp: numberValue(item.timestamp),
    duration: numberValue(item.duration),
    viewCount: numberValue(item.view_count),
    description: stringValue(item.description)
  };
}

function videoReceivedAt(video: VideoEntry): string {
  if (video.timestamp) return new Date(video.timestamp * 1000).toISOString();
  if (video.uploadDate && /^\d{8}$/.test(video.uploadDate)) {
    return `${video.uploadDate.slice(0, 4)}-${video.uploadDate.slice(4, 6)}-${video.uploadDate.slice(6, 8)}T00:00:00.000Z`;
  }
  return new Date().toISOString();
}

function hasKnownReceivedAt(video: VideoEntry): boolean {
  return Boolean(video.timestamp || (video.uploadDate && /^\d{8}$/.test(video.uploadDate)));
}

function maxVideosFromContext(context: SourceScanContext | undefined): number {
  if (typeof context?.maxVideos !== "number") return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(context.maxVideos)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(context.maxVideos));
}

function normalizedVideoUrl(id: string, rawUrl?: string): string {
  if (rawUrl?.startsWith("http")) return rawUrl;
  return `https://www.youtube.com/watch?v=${id}`;
}

function videoIdFromUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl.startsWith("http") ? rawUrl : `https://www.youtube.com/watch?v=${rawUrl}`);
    const id = url.hostname === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v") ?? undefined;
    return id && isYouTubeVideoId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function isYouTubeVideoId(value: string): boolean {
  return /^[A-Za-z0-9_-]{6,}$/.test(value);
}

async function fetchTranscriptFromInfo(item: Record<string, unknown>, videoId: string): Promise<{ transcript: string; transcriptCues: YouTubeTranscriptCue[]; transcriptSource: "manual" | "auto" | "none" }> {
  const captions = preferredCaptionUrls(item);
  console.info("[youtube] caption candidates", {
    videoId,
    candidates: captions.map((caption) => ({ source: caption.source, language: caption.language }))
  });
  if (!captions.length) return { transcript: "", transcriptCues: [], transcriptSource: "none" };
  for (const caption of captions) {
    console.info("[youtube] caption fetch start", { videoId, source: caption.source, language: caption.language });
    try {
      const response = await fetch(caption.url);
      if (!response.ok) {
        console.warn("[youtube] caption fetch failed", {
          videoId,
          source: caption.source,
          language: caption.language,
          status: response.status,
          statusText: response.statusText
        });
        continue;
      }
      const raw = await response.text();
      const cues = parseVttCues(raw);
      const transcript = cleanTranscriptFromCues(cues);
      console.info("[youtube] caption fetch complete", {
        videoId,
        source: caption.source,
        language: caption.language,
        rawChars: raw.length,
        cueCount: cues.length,
        transcriptChars: transcript.length
      });
      if (transcript) return { transcript, transcriptCues: cues, transcriptSource: caption.source };
    } catch (error) {
      console.warn("[youtube] caption fetch error", {
        videoId,
        source: caption.source,
        language: caption.language,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { transcript: "", transcriptCues: [], transcriptSource: "none" };
}

function preferredCaptionUrls(item: Record<string, unknown>): Array<{ url: string; source: "manual" | "auto"; language: string }> {
  return [
    ...preferredCaptionUrlsFromMap(objectValue(item.subtitles), "manual"),
    ...preferredCaptionUrlsFromMap(objectValue(item.automatic_captions), "auto")
  ];
}

function preferredCaptionUrlsFromMap(captions: Record<string, unknown> | null, source: "manual" | "auto"): Array<{ url: string; source: "manual" | "auto"; language: string }> {
  if (!captions) return [];
  const languageKeys = [
    "en-orig",
    "en",
    ...Object.keys(captions).filter((key) => key.startsWith("en.") || key.startsWith("en-"))
  ];
  const results: Array<{ url: string; source: "manual" | "auto"; language: string }> = [];
  for (const key of [...new Set(languageKeys)]) {
    const entries = Array.isArray(captions[key]) ? captions[key] : [];
    for (const entry of entries) {
      const value = objectValue(entry);
      if (value?.ext !== "vtt" || typeof value.url !== "string" || !value.url) continue;
      results.push({ url: value.url, source, language: key });
    }
  }
  return results;
}

function parseVttCues(raw: string): YouTubeTranscriptCue[] {
  const cues: YouTubeTranscriptCue[] = [];
  const blocks = raw.split(/\r?\n\s*\r?\n/);

  for (const block of blocks) {
    if (!block.includes("-->")) continue;
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;

    const [startRaw, endRaw] = lines[timingIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const startSec = parseVttTime(startRaw ?? "");
    const endSec = parseVttTime(endRaw ?? "");
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) continue;

    const text = lines
      .slice(timingIndex + 1)
      .filter((line) =>
        line &&
        !line.startsWith("WEBVTT") &&
        !line.startsWith("Kind:") &&
        !line.startsWith("Language:") &&
        !line.startsWith("NOTE") &&
        !/^\d+$/.test(line)
      )
      .map((line) => decodeHtmlEntities(line.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");

    if (!text) continue;
    const previous = cues.at(-1);
    if (previous?.text === text) continue;
    cues.push({
      id: `c${cues.length + 1}`,
      startSec,
      endSec,
      text
    });
  }

  return cues;
}

function parseVttTime(value: string): number {
  const match = value.match(/^(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return Number.NaN;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

function cleanTranscriptFromCues(cues: YouTubeTranscriptCue[]): string {
  const lines: string[] = [];
  for (const cue of cues) {
    if (cue.text && lines.at(-1) !== cue.text) lines.push(cue.text);
  }

  const paragraphs: string[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    buffer.push(line);
    const paragraph = buffer.join(" ");
    if (paragraph.length > 500 && /[.!?]$/.test(line)) {
      paragraphs.push(paragraph);
      buffer = [];
    }
  }
  if (buffer.length) paragraphs.push(buffer.join(" "));

  return paragraphs.join("\n\n");
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[lower] ?? match;
  });
}

function transcriptSourceFromInfo(item: Record<string, unknown> | undefined): "manual" | "auto" | "none" {
  if (!item) return "none";
  if (item.subtitles && Object.keys(objectValue(item.subtitles) ?? {}).length) return "manual";
  if (item.automatic_captions && Object.keys(objectValue(item.automatic_captions) ?? {}).length) return "auto";
  return "none";
}

function buildVideoBody(video: VideoEntry, transcript: string): string {
  const parts = [
    video.description ? `Description: ${video.description}` : "",
    transcript ? `Transcript: ${transcript}` : "Transcript unavailable."
  ];
  return parts.filter(Boolean).join("\n\n");
}

function newestReceivedAt(events: SourceEvent[]): string | undefined {
  return events
    .filter((event) => event.source === "youtube")
    .map((event) => event.receivedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
}

function latestIso(values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? new Date(0).toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}
