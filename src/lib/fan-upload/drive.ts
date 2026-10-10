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
