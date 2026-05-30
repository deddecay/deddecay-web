import { createClient } from "microcms-js-sdk";
import type { MicroCMSListContent } from "microcms-js-sdk";

// ── Types ─────────────────────────────────────────────

export type EntryType = "news" | "live";

export type EntryExternalLink = {
  fieldId: string;
  url: string;
  label: string;
};

export type EntryAttachment = {
  fieldId: string;
  url: string;
  label?: string;
};

export type Entry = MicroCMSListContent & {
  title: string;
  slug?: string;
  type: EntryType | EntryType[];
  body?: string;
  thumbnail?: { url: string; width: number; height: number };
  externalLinks?: EntryExternalLink[];
  attachments?: EntryAttachment[]; // Phase2
  eventDate?: string;
};

export type EntryNav = {
  id: string;
  title: string;
};

export type Biography = {
  photo?: { url: string; width: number; height: number };
  title: string;
  body: string;
};

export type DiscographyRelease = MicroCMSListContent & {
  cover?: { url: string; width: number; height: number };
  title: string;
  subtitle?: string;
  releaseDate?: string;
  subscriptionUrl?: string;
  buyUrl?: string;
  body?: string;
};

// ── Helpers ───────────────────────────────────────────

const getClient = () => {
  const serviceDomain = process.env.MICROCMS_SERVICE_DOMAIN;
  const apiKey = process.env.MICROCMS_API_KEY;
  if (!serviceDomain || !apiKey) return null;
  return createClient({ serviceDomain, apiKey });
};

export const formatEntryDate = (publishedAt: string | undefined): string =>
  publishedAt
    ? new Date(publishedAt)
        .toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" })
        .replace(/\//g, ".")
    : "";

const NEW_ENTRY_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export const isNewEntry = (publishedAt: string | undefined): boolean => {
  if (!publishedAt) return false;
  const publishedTime = new Date(publishedAt).getTime();
  const now = Date.now();
  if (Number.isNaN(publishedTime)) return false;
  if (publishedTime > now) return false;
  return now - publishedTime < NEW_ENTRY_THRESHOLD_MS;
};

export const formatLiveDate = (entry: Pick<Entry, "eventDate" | "publishedAt">): string =>
  formatEntryDate(entry.eventDate ?? entry.publishedAt);

// ── Fetch ─────────────────────────────────────────────

export const getEntriesByType = async (
  type: "news" | "live",
  page: number,
  limit: number
): Promise<{ contents: Entry[]; totalCount: number }> => {
  const client = getClient();
  if (!client) return { contents: [], totalCount: 0 };
  try {
    const data = await client.getList<Entry>({
      endpoint: "entries",
      queries: {
        filters: `type[contains]${type}`,
        orders: "-publishedAt",
        limit,
        offset: (page - 1) * limit,
      },
    });
    return { contents: data.contents, totalCount: data.totalCount };
  } catch {
    return { contents: [], totalCount: 0 };
  }
};

export const getTopNews = async (): Promise<Entry[]> => {
  const client = getClient();
  if (!client) return [];
  try {
    const data = await client.getList<Entry>({
      endpoint: "entries",
      queries: {
        filters: "type[contains]news",
        orders: "-publishedAt",
        limit: 5,
      },
    });
    return data.contents;
  } catch {
    return [];
  }
};

export const getAdjacentEntries = async (
  publishedAt: string
): Promise<{ prev: EntryNav | null; next: EntryNav | null }> => {
  const client = getClient();
  if (!client) return { prev: null, next: null };
  const base = "type[contains]news";
  try {
    const [prevData, nextData] = await Promise.all([
      client.getList<Entry>({
        endpoint: "entries",
        queries: {
          filters: `${base}[and]publishedAt[greater_than]${publishedAt}`,
          orders: "publishedAt",
          limit: 1,
          fields: "id,title",
        },
      }),
      client.getList<Entry>({
        endpoint: "entries",
        queries: {
          filters: `${base}[and]publishedAt[less_than]${publishedAt}`,
          orders: "-publishedAt",
          limit: 1,
          fields: "id,title",
        },
      }),
    ]);
    return {
      prev: prevData.contents[0] ? { id: prevData.contents[0].id, title: prevData.contents[0].title } : null,
      next: nextData.contents[0] ? { id: nextData.contents[0].id, title: nextData.contents[0].title } : null,
    };
  } catch {
    return { prev: null, next: null };
  }
};

export const getTopLives = async (): Promise<Entry[]> => {
  const client = getClient();
  if (!client) return [];
  try {
    const data = await client.getList<Entry>({
      endpoint: "entries",
      queries: {
        filters: "type[contains]live",
        orders: "eventDate",
        limit: 5,
      },
    });
    return data.contents;
  } catch {
    return [];
  }
};

export const getLiveList = async (): Promise<Entry[]> => {
  const client = getClient();
  if (!client) return [];
  try {
    const data = await client.getList<Entry>({
      endpoint: "entries",
      queries: {
        filters: "type[contains]live",
        orders: "eventDate",
        limit: 20,
      },
    });
    return data.contents;
  } catch {
    return [];
  }
};

export const getLiveById = async (contentId: string): Promise<Entry | null> => {
  const client = getClient();
  if (!client) return null;
  try {
    const entry = await client.getListDetail<Entry>({
      endpoint: "entries",
      contentId,
    });
    const isLive = Array.isArray(entry.type) ? entry.type.includes("live") : entry.type === "live";
    if (!isLive) return null;
    return entry;
  } catch {
    return null;
  }
};

export const getAdjacentLiveEntries = async (
  publishedAt: string
): Promise<{ prev: EntryNav | null; next: EntryNav | null }> => {
  const client = getClient();
  if (!client) return { prev: null, next: null };
  const base = "type[contains]live";
  try {
    const [prevData, nextData] = await Promise.all([
      client.getList<Entry>({
        endpoint: "entries",
        queries: {
          filters: `${base}[and]publishedAt[greater_than]${publishedAt}`,
          orders: "publishedAt",
          limit: 1,
          fields: "id,title",
        },
      }),
      client.getList<Entry>({
        endpoint: "entries",
        queries: {
          filters: `${base}[and]publishedAt[less_than]${publishedAt}`,
          orders: "-publishedAt",
          limit: 1,
          fields: "id,title",
        },
      }),
    ]);
    return {
      prev: prevData.contents[0] ? { id: prevData.contents[0].id, title: prevData.contents[0].title } : null,
      next: nextData.contents[0] ? { id: nextData.contents[0].id, title: nextData.contents[0].title } : null,
    };
  } catch {
    return { prev: null, next: null };
  }
};

export const getDiscography = async (): Promise<DiscographyRelease[]> => {
  const client = getClient();
  if (!client) return [];
  try {
    const data = await client.getList<DiscographyRelease>({
      endpoint: "discography",
      queries: { orders: "-releaseDate", limit: 20 },
    });
    return data.contents.sort((a, b) => {
      const ad = a.releaseDate ?? a.publishedAt ?? "";
      const bd = b.releaseDate ?? b.publishedAt ?? "";
      return bd.localeCompare(ad);
    });
  } catch {
    return [];
  }
};

export const getDiscographyById = async (contentId: string): Promise<DiscographyRelease | null> => {
  const client = getClient();
  if (!client) return null;
  try {
    return await client.getListDetail<DiscographyRelease>({
      endpoint: "discography",
      contentId,
    });
  } catch {
    return null;
  }
};

export const getBiography = async (): Promise<Biography | null> => {
  const client = getClient();
  if (!client) return null;
  try {
    return await client.getObject<Biography>({ endpoint: "biography" });
  } catch {
    return null;
  }
};

export const getEntryById = async (contentId: string): Promise<Entry | null> => {
  const client = getClient();
  if (!client) return null;
  try {
    return await client.getListDetail<Entry>({
      endpoint: "entries",
      contentId,
    });
  } catch {
    return null;
  }
};
