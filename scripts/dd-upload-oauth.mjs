#!/usr/bin/env node
// Fan moments: Google OAuth リフレッシュトークンの発行（ローカルで手動実行する運用ツール）。
//
// 秘密の扱い:
//   - OAuth クライアント JSON は repository の外に置く（既定: /Users/hayato/site/secrets/deddecay/dd-upload/google-oauth-client.json）。
//     パスは環境変数 DD_UPLOAD_OAUTH_CLIENT_JSON で変更できる。ファイル権限が 600 でなければ中断する
//   - クライアント ID / シークレット / トークンは、画面・ログ・ファイル・argv に一切出さない
//   - 取得したトークンは Vercel CLI の標準入力へ直接渡す（--no-deliver なら保存しない）
//
// 使い方:
//   node scripts/dd-upload-oauth.mjs --login-hint <google-account-email> [--no-deliver]

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const DEFAULT_CLIENT_JSON =
  "/Users/hayato/site/secrets/deddecay/dd-upload/google-oauth-client.json";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ALL_TARGETS = ["production", "preview"];

const args = process.argv.slice(2);
const deliver = !args.includes("--no-deliver");
// --targets preview のように登録先を絞れる（既定: production,preview）
const targetsIndex = args.indexOf("--targets");
const TARGETS =
  targetsIndex >= 0
    ? String(args[targetsIndex + 1] ?? "").split(",").filter((t) => ALL_TARGETS.includes(t))
    : ALL_TARGETS;
const hintIndex = args.indexOf("--login-hint");
const loginHint = hintIndex >= 0 ? args[hintIndex + 1] : undefined;

const b64url = (buf) => buf.toString("base64url");

const fail = (message) => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

const loadClient = () => {
  const path = process.env.DD_UPLOAD_OAUTH_CLIENT_JSON || DEFAULT_CLIENT_JSON;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    fail("OAuth クライアント JSON が見つかりません（パスは DD_UPLOAD_OAUTH_CLIENT_JSON で指定できます）");
  }
  if ((stat.mode & 0o077) !== 0) fail("OAuth クライアント JSON の権限が緩すぎます（chmod 600 にしてください）");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("OAuth クライアント JSON を読み取れません");
  }
  const body = parsed.installed ?? parsed.web;
  if (!body?.client_id || !body?.client_secret) fail("OAuth クライアント JSON に client_id / client_secret がありません");
  return { id: body.client_id, secret: body.client_secret };
};

// 127.0.0.1 の一時サーバーで認可コードを 1 回だけ受ける
const startCallbackServer = (state) =>
  new Promise((resolveReady) => {
    let resolveCode;
    let rejectCode;
    const code = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    const timer = setTimeout(() => {
      server.close();
      rejectCode(new Error("5 分以内に認証が完了しませんでした"));
    }, 5 * 60 * 1000);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const authCode = url.searchParams.get("code");
      const ok = url.searchParams.get("state") === state && authCode;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(ok ? "認証を受け取りました。このタブは閉じて構いません。" : "認証に失敗しました。ターミナルを確認してください。");
      clearTimeout(timer);
      server.close();
      if (ok) resolveCode(authCode);
      else rejectCode(new Error(url.searchParams.get("error") ?? "state が一致しません"));
    });
    server.listen(0, "127.0.0.1", () => {
      resolveReady({ port: server.address().port, code });
    });
  });

// Vercel CLI へ値を標準入力で渡す（argv にも画面にも出さない）
// preview は Git ブランチ未指定（空文字 = すべての Preview ブランチ）で登録する。
// 失敗時は CLI の標準エラー 1 行目だけを返す（CLI は値をエコーしない）。
const vercelEnvAdd = (name, value, target) =>
  new Promise((resolve) => {
    const argv = ["vercel", "env", "add", name, target];
    if (target === "preview") argv.push("");
    argv.push("--yes", "--force");
    const child = spawn("npx", argv, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += chunk;
    });
    child.on("error", () => resolve({ ok: false, note: "vercel CLI を起動できません" }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, note: stderr.split("\n").find((l) => l.trim())?.trim().slice(0, 140) ?? "" })
    );
    child.stdin.end(`${value}\n`);
  });

const main = async () => {
  const client = loadClient();

  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const { port, code } = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(loginHint ? { login_hint: loginHint } : {}),
  })}`;
  console.log("ブラウザで Google の認証画面を開きます。開かない場合は次の URL を開いてください:\n");
  console.log(`${authUrl}\n`);
  execFile("/usr/bin/open", [authUrl], () => {});

  const authCode = await code;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: authCode,
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) fail(`トークンを取得できませんでした (${data.error ?? res.status})`);
  if (!String(data.scope ?? "").split(" ").includes(SCOPE)) {
    fail("drive.file の許可が確認できませんでした。同意画面でチェックを外していないか確認してください");
  }
  console.log("✔ リフレッシュトークンを取得しました（値は表示しません）");

  if (!deliver) {
    console.log("--no-deliver のため、どこにも保存せず終了します");
    return;
  }

  const items = [
    ["GOOGLE_OAUTH_CLIENT_ID", client.id],
    ["GOOGLE_OAUTH_CLIENT_SECRET", client.secret],
    ["GOOGLE_OAUTH_REFRESH_TOKEN", data.refresh_token],
  ];
  for (const [name, value] of items) {
    for (const target of TARGETS) {
      const { ok, note } = await vercelEnvAdd(name, value, target);
      console.log(`${ok ? "✔" : "✖"} Vercel ${target}: ${name}${ok || !note ? "" : ` — ${note}`}`);
    }
  }
};

main().catch((err) => fail(err instanceof Error ? err.message : "失敗しました"));
