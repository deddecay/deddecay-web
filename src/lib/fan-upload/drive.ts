// Google Drive REST クライアント（依存ライブラリなし）。
// 認証: オーナーの OAuth リフレッシュトークン（スコープは drive.file のみ）。
// drive.file は「このアプリが作成したファイル」だけを扱えるため、ルートフォルダもアプリ自身が作成し、
// appProperties の role=fanroot で見つける。フォルダ・ファイルは共有設定を一切変更しない（非公開のまま）。

const FOLDER_MIME = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ROOT_FOLDER_NAME = "DD UPLOAD";

export type DriveConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export const loadDriveConfig = (env: NodeJS.ProcessEnv = process.env): DriveConfig | null => {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
};

export type DriveFile = {
  id: string;
  name: string;
  size: number;
  parents: string[];
  description: string;
  appProperties: Record<string, string>;
};

export class DriveError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type FetchLike = typeof fetch;

const escapeQuery = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export class DriveClient {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private folderCache = new Map<string, { id: string; at: number }>();
  private usageCache: { bytes: number; at: number } | null = null;

  private readonly config: DriveConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(config: DriveConfig, fetchImpl: FetchLike = fetch, now: () => number = Date.now) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > this.now() + 60_000) {
      return this.accessToken.value;
    }
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new DriveError(`token refresh failed (${res.status})`, res.status);
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new DriveError("token refresh: no access_token", 500);
    this.accessToken = {
      value: data.access_token,
      expiresAt: this.now() + (data.expires_in ?? 3600) * 1000,
    };
    return this.accessToken.value;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new DriveError(`drive ${init.method ?? "GET"} failed (${res.status})`, res.status);
    }
    return res;
  }

  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    return (await this.request(url, init)).json() as Promise<T>;
  }

  private async listAll(query: string, fields: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: query,
        fields: `nextPageToken,files(${fields})`,
        pageSize: "1000",
        spaces: "drive",
        orderBy: "createdTime",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.json<{ files?: Record<string, unknown>[]; nextPageToken?: string }>(
        `${API}/files?${params}`
      );
      out.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  private async createFolder(name: string, parentId: string | null, role?: string): Promise<string> {
    const body = {
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
      appProperties: { app: "fanupload", ...(role ? { role } : {}) },
    };
    const created = await this.json<{ id: string }>(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return created.id;
  }

  private async ensureRoot(): Promise<string> {
    const cached = this.folderCache.get("");
    if (cached && cached.at > this.now() - 300_000) return cached.id;
    const found = await this.listAll(
      `mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='role' and value='fanroot' }`,
      "id"
    );
    const id = (found[0]?.id as string | undefined) ?? (await this.createFolder(ROOT_FOLDER_NAME, null, "fanroot"));
    this.folderCache.set("", { id, at: this.now() });
    return id;
  }

  // ルート配下に segments の順でフォルダを（無ければ）作り、最後のフォルダ ID を返す
  async ensureFolderPath(segments: readonly string[]): Promise<string> {
    let parentId = await this.ensureRoot();
    let key = "";
    for (const segment of segments) {
      key = `${key}/${segment}`;
      const cached = this.folderCache.get(key);
      if (cached && cached.at > this.now() - 300_000) {
        parentId = cached.id;
        continue;
      }
      const found = await this.listAll(
        `mimeType='${FOLDER_MIME}' and trashed=false and name='${escapeQuery(segment)}' and '${parentId}' in parents and appProperties has { key='app' and value='fanupload' }`,
        "id"
      );
      parentId = (found[0]?.id as string | undefined) ?? (await this.createFolder(segment, parentId));
      this.folderCache.set(key, { id: parentId, at: this.now() });
    }
    return parentId;
  }

  clearFolderCache() {
    this.folderCache.clear();
  }

  // ブラウザから直接 PUT するための resumable セッション URI を作る。
  // Origin を付けて作成すると、そのオリジンからの CORS アップロードが許可される。
  async createResumableSession(params: {
    name: string;
    parentId: string;
    size: number;
    mimeType: string;
    description: string;
    appProperties: Record<string, string>;
    origin: string;
  }): Promise<string> {
    const res = await this.request(`${UPLOAD_API}/files?uploadType=resumable&fields=id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": params.mimeType,
        "X-Upload-Content-Length": String(params.size),
        Origin: params.origin,
      },
      body: JSON.stringify({
        name: params.name,
        parents: [params.parentId],
        mimeType: params.mimeType,
        description: params.description,
        appProperties: params.appProperties,
      }),
    });
    const location = res.headers.get("location");
    if (!location || !location.startsWith("https://www.googleapis.com/")) {
      throw new DriveError("resumable session: no valid Location", 502);
    }
    return location;
  }

  // ── R2 → Drive 転送用（Fan moments） ───────────────────
  // 保存先: マイドライブの「Fan moments」（アプリが作成し、オーナーが 03_media へ 1 回だけ移動する）。
  // フォルダは名前ではなく appProperties で見つける（移動・改名しても同じフォルダを使い続ける）。

  private async ensureChildFolder(
    parentId: string | null,
    match: Record<string, string>,
    name: string
  ): Promise<string> {
    const cacheKey = `${parentId ?? ""}|${JSON.stringify(match)}`;
    const cached = this.folderCache.get(cacheKey);
    if (cached && cached.at > this.now() - 300_000) return cached.id;

    const conditions = Object.entries(match).map(
      ([k, v]) => `appProperties has { key='${escapeQuery(k)}' and value='${escapeQuery(v)}' }`
    );
    const query = [
      `mimeType='${FOLDER_MIME}'`,
      "trashed=false",
      ...(parentId ? [`'${parentId}' in parents`] : []),
      ...conditions,
    ].join(" and ");

    const find = async () => (await this.listAll(query, "id"))[0]?.id as string | undefined;
    let id = await find();
    if (!id) {
      const body = {
        name,
        mimeType: FOLDER_MIME,
        ...(parentId ? { parents: [parentId] } : {}),
        appProperties: { app: "fanupload", ...match },
      };
      const created = await this.json<{ id: string }>(`${API}/files?fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // 同時実行で 2 つ作られた場合は、作成日時が最も早いものに揃え、自分のものは（空なので）ゴミ箱へ
      const earliest = await find();
      if (earliest && earliest !== created.id) {
        await this.trash(created.id).catch(() => {});
        id = earliest;
      } else {
        id = created.id;
      }
    }
    this.folderCache.set(cacheKey, { id, at: this.now() });
    return id;
  }

  ensureFanMomentsRoot(): Promise<string> {
    return this.ensureChildFolder(null, { role: "fmroot" }, "Fan moments");
  }

  async ensureLiveFolder(liveId: string, name: string): Promise<string> {
    const root = await this.ensureFanMomentsRoot();
    return this.ensureChildFolder(root, { role: "live", liveId }, name);
  }

  async ensureOtherFolder(): Promise<string> {
    const root = await this.ensureFanMomentsRoot();
    return this.ensureChildFolder(root, { role: "other" }, "その他");
  }

  // 日付単位のフォルダ（LIVE フォルダ / その他）の下の photo / movie フォルダ
  ensureMediaFolder(parentId: string, media: "photo" | "movie"): Promise<string> {
    return this.ensureChildFolder(parentId, { role: "media", media }, media);
  }

  async findByKey(ddKey: string): Promise<{ id: string; size: number; md5: string }[]> {
    const rows = await this.listAll(
      `trashed=false and appProperties has { key='ddKey' and value='${escapeQuery(ddKey)}' }`,
      "id,size,md5Checksum"
    );
    return rows.map((row) => ({
      id: String(row.id),
      size: Number(row.size ?? 0),
      md5: String(row.md5Checksum ?? ""),
    }));
  }

  // 実ファイルの存在・サイズ・ゴミ箱の状態の再確認（R2 を消す前に使う）
  async getFileInfo(
    fileId: string
  ): Promise<{ id: string; size: number; trashed: boolean; md5: string; ddKey: string } | null> {
    try {
      const data = await this.json<{
        id: string;
        size?: string;
        trashed?: boolean;
        md5Checksum?: string;
        appProperties?: Record<string, string>;
      }>(`${API}/files/${encodeURIComponent(fileId)}?fields=id,size,trashed,md5Checksum,appProperties`);
      return {
        id: data.id,
        size: Number(data.size ?? 0),
        trashed: data.trashed === true,
        md5: data.md5Checksum ?? "",
        ddKey: data.appProperties?.ddKey ?? "",
      };
    } catch (err) {
      if (err instanceof DriveError && err.status === 404) return null;
      throw err;
    }
  }

  // サーバーから送る resumable セッション（ブラウザ用の Origin は付けない）
  async createTransferSession(params: {
    name: string;
    parentId: string;
    size: number;
    mimeType: string;
    description: string;
    appProperties: Record<string, string>;
  }): Promise<string> {
    // 完了時の応答に size / md5Checksum を含めるため fields を指定する（転送成功の判定に使う）
    const res = await this.request(`${UPLOAD_API}/files?uploadType=resumable&fields=id,size,md5Checksum`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": params.mimeType,
        "X-Upload-Content-Length": String(params.size),
      },
      body: JSON.stringify({
        name: params.name,
        parents: [params.parentId],
        mimeType: params.mimeType,
        description: params.description,
        appProperties: { app: "fanupload", ...params.appProperties },
      }),
    });
    const location = res.headers.get("location");
    if (!location || !location.startsWith("https://www.googleapis.com/")) {
      throw new DriveError("resumable session: no valid Location", 502);
    }
    return location;
  }

  // 1 チャンクを送る。start はこのチャンクの先頭オフセット、total はファイル全体のサイズ。
  // 308 は「続きを送れ」、200/201 は完了。308 のリダイレクトを fetch に追わせないため redirect: "manual"
  async putChunk(
    sessionUrl: string,
    bytes: Uint8Array,
    start: number,
    total: number
  ): Promise<{ done: false; next: number } | { done: true; id: string; size: number; md5: string }> {
    const end = start + bytes.byteLength - 1;
    const res = await this.fetchImpl(sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(bytes.byteLength),
        "Content-Range": `bytes ${start}-${end}/${total}`,
      },
      body: bytes as unknown as BodyInit,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    return this.readChunkResponse(res, total);
  }

  // セッションが受け取り済みのオフセットを問い合わせる（通信断のあとの再開用）
  async queryOffset(sessionUrl: string, total: number): Promise<{ done: false; next: number } | { done: true; id: string; size: number; md5: string }> {
    const res = await this.fetchImpl(sessionUrl, {
      method: "PUT",
      headers: { "Content-Length": "0", "Content-Range": `bytes */${total}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    return this.readChunkResponse(res, total);
  }

  private async readChunkResponse(res: Response, total: number) {
    if (res.status === 308) {
      const range = res.headers.get("range"); // 例: bytes=0-33554431
      const m = range ? /bytes=0-(\d+)/.exec(range) : null;
      return { done: false as const, next: m ? Number(m[1]) + 1 : 0 };
    }
    if (res.status === 200 || res.status === 201) {
      const data = (await res.json()) as { id?: string; size?: string; md5Checksum?: string };
      if (!data.id) throw new DriveError("chunk upload: no file id", 502);
      return { done: true as const, id: data.id, size: Number(data.size ?? total), md5: data.md5Checksum ?? "" };
    }
    throw new DriveError(`drive chunk upload failed (${res.status})`, res.status);
  }

  async listPostFiles(postId: string): Promise<DriveFile[]> {
    const rows = await this.listAll(
      `trashed=false and appProperties has { key='postId' and value='${escapeQuery(postId)}' }`,
      "id,name,size,parents,description,appProperties"
    );
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      size: Number(row.size ?? 0),
      parents: (row.parents as string[] | undefined) ?? [],
      description: String(row.description ?? ""),
      appProperties: (row.appProperties as Record<string, string> | undefined) ?? {},
    }));
  }

  async readHead(fileId: string, length = 32): Promise<Uint8Array> {
    const res = await this.request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Range: `bytes=0-${length - 1}` },
    });
    return new Uint8Array(await res.arrayBuffer());
  }

  async trash(fileId: string): Promise<void> {
    await this.request(`${API}/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  }

  async markNotified(fileId: string): Promise<void> {
    await this.request(`${API}/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appProperties: { notified: "1" } }),
    });
  }

  // アカウント全体の空き容量
  async storage(): Promise<{ limit: number | null; usage: number }> {
    const data = await this.json<{ storageQuota?: { limit?: string; usage?: string } }>(
      `${API}/about?fields=storageQuota`
    );
    const limit = data.storageQuota?.limit;
    return { limit: limit ? Number(limit) : null, usage: Number(data.storageQuota?.usage ?? 0) };
  }

  // このアプリが保存した容量の合計（5 分キャッシュ）
  async appUsageBytes(): Promise<number> {
    if (this.usageCache && this.usageCache.at > this.now() - 300_000) return this.usageCache.bytes;
    const rows = await this.listAll(
      `trashed=false and mimeType!='${FOLDER_MIME}' and appProperties has { key='app' and value='fanupload' }`,
      "size"
    );
    const bytes = rows.reduce((sum, row) => sum + Number(row.size ?? 0), 0);
    this.usageCache = { bytes, at: this.now() };
    return bytes;
  }

  // 新しい投稿を受け付けられるか
  async hasCapacity(
    incomingBytes: number,
    opts: { appCapBytes: number; reserveBytes: number }
  ): Promise<boolean> {
    const [app, storage] = await Promise.all([this.appUsageBytes(), this.storage()]);
    if (app + incomingBytes > opts.appCapBytes) return false;
    if (storage.limit !== null && storage.usage + incomingBytes + opts.reserveBytes > storage.limit) return false;
    return true;
  }
}

let shared: DriveClient | null = null;

export const getDriveClient = (): DriveClient | null => {
  const config = loadDriveConfig();
  if (!config) return null;
  shared ??= new DriveClient(config);
  return shared;
};
