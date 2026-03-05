import { NextResponse } from "next/server";

type ProcoreProject = { id: number; name: string };
type ProcoreUser = { name?: string; login?: string };
type ProcoreLocation = { name?: string };

type ProcoreComment = {
  body?: string | null;
  created_at?: string | null;
  user?: ProcoreUser | null;
};

type ProcoreImage = {
  id: number;
  url?: string | null;
  thumbnail_url?: string | null;
  created_at?: string | null;
  taken_at?: string | null;
  description?: string | null;
  uploader?: ProcoreUser | null;
  location?: ProcoreLocation | null;
  comments?: ProcoreComment[] | null; // present with serializer_view mobile/mobile_feed/android
};

type FeedItem = {
  id: number;
  projectId: number;
  projectName: string;
  imageUrl: string;
  takenAt?: string | null;
  createdAt?: string | null;
  uploaderName?: string | null;
  locationName?: string | null;
  description?: string | null;
  commentText?: string | null;
};

const BASE_URL = (process.env.PROCORE_BASE_URL || "https://api.procore.com").replace(/\/+$/, "");
const ACCESS_TOKEN = process.env.PROCORE_ACCESS_TOKEN || "";
const COMPANY_ID = Number(process.env.PROCORE_COMPANY_ID || "0");
const DAYS_BACK = Number(process.env.DAYS_BACK || "14");
const PER_PAGE = Number(process.env.PER_PAGE || "100");
const PROJECTS_PER_PAGE = Number(process.env.PROJECTS_PER_PAGE || "300");
const MAX_PROJECTS = Number(process.env.MAX_PROJECTS || "0"); // 0 = no cap
const CONCURRENCY = Number(process.env.CONCURRENCY || "6");
const SERIALIZER_VIEW = process.env.SERIALIZER_VIEW || "mobile_feed"; // best for feed comments

function mustEnv() {
  if (!ACCESS_TOKEN) throw new Error("Missing PROCORE_ACCESS_TOKEN");
  if (!COMPANY_ID) throw new Error("Missing PROCORE_COMPANY_ID");
}

function headers() {
  return {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    "Procore-Company-Id": String(COMPANY_ID),
    Accept: "application/json"
  } as Record<string, string>;
}

function isoRangeDaysBack(days: number) {
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const toIsoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${toIsoZ(start)}...${toIsoZ(now)}`;
}

async function procoreGet<T>(path: string, qs: Record<string, string | number | undefined>) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(qs)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }

  const r = await fetch(url.toString(), { headers: headers() });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${path} failed: HTTP ${r.status} ${text}`);
  }
  return (await r.json()) as T;
}

async function listProjects(): Promise<ProcoreProject[]> {
  const out: ProcoreProject[] = [];
  let page = 1;

  while (true) {
    const chunk = await procoreGet<ProcoreProject[]>("/rest/v1.0/projects", {
      company_id: COMPANY_ID,
      per_page: PROJECTS_PER_PAGE,
      page,
      "filters[by_status]": "Active"
    });

    if (!Array.isArray(chunk) || chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < PROJECTS_PER_PAGE) break;
    page += 1;

    if (MAX_PROJECTS > 0 && out.length >= MAX_PROJECTS) break;
  }

  return MAX_PROJECTS > 0 ? out.slice(0, MAX_PROJECTS) : out;
}

async function listImagesForProject(project: ProcoreProject): Promise<FeedItem[]> {
  const createdRange = isoRangeDaysBack(DAYS_BACK);

  const imgs = await procoreGet<ProcoreImage[]>("/rest/v1.0/images", {
    project_id: project.id,
    per_page: PER_PAGE,
    sort: "-created_at",
    "filters[created_at]": createdRange,
    serializer_view: SERIALIZER_VIEW
  });

  if (!Array.isArray(imgs)) return [];

  const pickUrl = (i: ProcoreImage) => i.url || i.thumbnail_url || "";
  const uploader = (u?: ProcoreUser | null) => (u?.name || u?.login || null);

  const latestCommentText = (comments?: ProcoreComment[] | null) => {
    if (!Array.isArray(comments) || comments.length === 0) return null;
    // Choose most recent by created_at if present; else take last.
    const sorted = [...comments].sort((a, b) => {
      const at = a.created_at ? Date.parse(a.created_at) : 0;
      const bt = b.created_at ? Date.parse(b.created_at) : 0;
      return bt - at;
    });
    const body = sorted[0]?.body ?? null;
    return body ? String(body) : null;
  };

  return imgs
    .map((i) => ({
      id: i.id,
      projectId: project.id,
      projectName: project.name,
      imageUrl: pickUrl(i),
      takenAt: i.taken_at ?? null,
      createdAt: i.created_at ?? null,
      uploaderName: uploader(i.uploader),
      locationName: i.location?.name ?? null,
      description: i.description ?? null,
      commentText: latestCommentText(i.comments)
    }))
    .filter((x) => x.imageUrl);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  }

  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export async function GET() {
  try {
    mustEnv();

    const projects = await listProjects();
    const all = await mapLimit(projects, CONCURRENCY, (p) => listImagesForProject(p));

    const merged: FeedItem[] = all.flat();

    merged.sort((a, b) => {
      const at = a.takenAt ? Date.parse(a.takenAt) : 0;
      const bt = b.takenAt ? Date.parse(b.takenAt) : 0;
      if (bt !== at) return bt - at;

      const ac = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bc = b.createdAt ? Date.parse(b.createdAt) : 0;
      return bc - ac;
    });

    const res = NextResponse.json({
      meta: {
        generatedAt: new Date().toISOString(),
        daysBack: DAYS_BACK,
        projects: projects.length,
        images: merged.length,
        serializerView: SERIALIZER_VIEW
      },
      data: merged
    });

    // Vercel CDN cache to reduce Procore load; UI still polls.
    res.headers.set("Cache-Control", "s-maxage=20, stale-while-revalidate=60");
    return res;
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
