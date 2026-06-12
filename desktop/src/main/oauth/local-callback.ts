import http from "node:http";
import { AddressInfo } from "node:net";

export type OAuthCallbackResult = {
  code: string;
  state: string;
};

export type OAuthCallbackServer = {
  redirectUri: string;
  result: Promise<OAuthCallbackResult>;
  close(): Promise<void>;
};

export async function startOAuthCallbackServer(options: {
  expectedState: string;
  host?: string;
  port?: number;
  path?: string;
  successHtml?: string;
  errorHtml?: string;
}): Promise<OAuthCallbackServer> {
  const host = options.host ?? "127.0.0.1";
  const callbackPath = options.path ?? "/oauth/callback";
  let settled = false;
  let resolveResult!: (result: OAuthCallbackResult) => void;
  let rejectResult!: (error: Error) => void;

  const result = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    const oauthError = requestUrl.searchParams.get("error");

    const finish = (status: number, body: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
      void closeServer(server);
    };

    // Stray requests (favicon, browser preconnect, port probes) must not settle
    // the flow or close the server before the real redirect arrives.
    if (requestUrl.pathname !== callbackPath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    if (settled) {
      finish(409, options.errorHtml ?? "OAuth callback already completed.");
      return;
    }

    settled = true;
    if (oauthError) {
      rejectResult(new Error(`OAuth provider returned an error: ${oauthError}`));
      finish(400, options.errorHtml ?? "Sign-in failed. You can close this window.");
      return;
    }
    if (!code) {
      rejectResult(new Error("OAuth callback did not include a code."));
      finish(400, options.errorHtml ?? "Sign-in failed. You can close this window.");
      return;
    }
    if (state !== options.expectedState) {
      rejectResult(new Error("OAuth state did not match."));
      finish(400, options.errorHtml ?? "Sign-in failed. You can close this window.");
      return;
    }

    resolveResult({ code, state });
    finish(200, options.successHtml ?? "Sign-in complete. You can close this window.");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const redirectUri = `http://${host}:${address.port}${callbackPath}`;
  return {
    redirectUri,
    result,
    close: () => closeServer(server)
  };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}
