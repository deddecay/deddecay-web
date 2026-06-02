import type { MetadataRoute } from "next";
import { getEntriesByType, getDiscography } from "@/src/lib/microcms";

export const revalidate = 3600;

const BASE_URL = "https://deddecay.tokyo";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [newsData, liveData, discographyItems] = await Promise.all([
    getEntriesByType("news", 1, 100),
    getEntriesByType("live", 1, 100),
    getDiscography(),
  ]);

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${BASE_URL}/entries?type=news`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/entries?type=live`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/live`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.6,
    },
  ];

  const toDate = (s: string | undefined): Date => (s ? new Date(s) : new Date());

  const newsRoutes: MetadataRoute.Sitemap = newsData.contents.map((item) => ({
    url: `${BASE_URL}/news/${item.id}`,
    lastModified: toDate(item.revisedAt ?? item.publishedAt),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const liveRoutes: MetadataRoute.Sitemap = liveData.contents.map((item) => ({
    url: `${BASE_URL}/live/${item.id}`,
    lastModified: toDate(item.revisedAt ?? item.publishedAt),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const discographyRoutes: MetadataRoute.Sitemap = discographyItems.map((item) => ({
    url: `${BASE_URL}/discography/${item.id}`,
    lastModified: toDate(item.revisedAt ?? item.publishedAt),
    changeFrequency: "yearly",
    priority: 0.8,
  }));

  return [...staticRoutes, ...newsRoutes, ...liveRoutes, ...discographyRoutes];
}
