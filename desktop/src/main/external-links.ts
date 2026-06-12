export type SetupLinkId = "google-cloud-console" | "gmail-api" | "oauth-clients";

const SETUP_LINKS: Record<SetupLinkId, string> = {
  "google-cloud-console": "https://console.cloud.google.com/",
  "gmail-api": "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  "oauth-clients": "https://console.cloud.google.com/apis/credentials"
};

export function setupLinkUrl(linkId: SetupLinkId): string {
  const url = SETUP_LINKS[linkId];
  if (!url) throw new Error("Unknown setup link.");
  return url;
}

export function assertAllowedSourceUrl(url: string): URL {
  const parsed = new URL(url);
  const isGmail = parsed.protocol === "https:" && parsed.hostname === "mail.google.com";
  const isTwitter = parsed.protocol === "https:" && (parsed.hostname === "x.com" || parsed.hostname === "twitter.com");
  const isYouTube = parsed.protocol === "https:" && (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com" || parsed.hostname === "youtu.be");
  const isTelegram = parsed.protocol === "tg:";
  if (!isGmail && !isTwitter && !isYouTube && !isTelegram) {
    throw new Error("Only Gmail, X/Twitter, YouTube, and Telegram links can be opened from findings.");
  }
  return parsed;
}
