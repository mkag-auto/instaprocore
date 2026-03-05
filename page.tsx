"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type FeedItem = {
  id: number | string;
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

type FeedResponse = {
  meta: { generatedAt: string; daysBack: number; projects: number; images: number };
  data: FeedItem[];
};

const POLL_MS = Number(process.env.NEXT_PUBLIC_POLL_MS ?? 30_000);
const SLIDE_MS = Number(process.env.NEXT_PUBLIC_SLIDE_MS ?? 8_000);
const NEW_BURST_MS = Number(process.env.NEXT_PUBLIC_NEW_BURST_MS ?? 15_000);

function fmt(dt?: string | null) {
  if (!dt) return "—";
  try {
    const d = new Date(dt);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return String(dt);
  }
}

function safe(v?: string | null) {
  if (!v) return "—";
  return v;
}

export default function Page() {
  const feedRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] = useState<string>("Loading…");
  const [counter, setCounter] = useState<string>("");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [firstId, setFirstId] = useState<string | number | null>(null);

  const state = useMemo(() => {
    const currentIndex = Number(localStorage.getItem("pf_currentIndex") || "0");
    const resumeIndex = Number(localStorage.getItem("pf_resumeIndex") || "0");
    const burstUntil = Number(localStorage.getItem("pf_burstUntil") || "0");
    return { currentIndex, resumeIndex, burstUntil };
  }, []);

  const persist = (currentIndex: number, resumeIndex: number, burstUntil: number) => {
    localStorage.setItem("pf_currentIndex", String(currentIndex));
    localStorage.setItem("pf_resumeIndex", String(resumeIndex));
    localStorage.setItem("pf_burstUntil", String(burstUntil));
  };

  const clampIndex = (idx: number, length: number) => {
    if (length <= 0) return 0;
    return Math.max(0, Math.min(idx, length - 1));
  };

  const scrollToIndex = (idx: number) => {
    const root = feedRef.current;
    if (!root) return;
    const cards = root.querySelectorAll<HTMLElement>(".card");
    const el = cards[idx];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const updateCounter = (idx: number, length: number) => {
    if (!length) {
      setCounter("");
      return;
    }
    setCounter(`Photo ${idx + 1} / ${length}`);
  };

  const load = async () => {
    try {
      setStatus("Updating…");
      const r = await fetch("/api/feed", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as FeedResponse;

      const next = Array.isArray(j.data) ? j.data : [];
      if (!next.length) {
        setItems([]);
        setStatus("No images found in the last 14 days.");
        setCounter("");
        return;
      }

      const nextFirst = next[0]?.id ?? null;
      let currentIndex = clampIndex(state.currentIndex, next.length);
      let resumeIndex = clampIndex(state.resumeIndex, next.length);
      let burstUntil = state.burstUntil;

      if (firstId !== null && nextFirst !== firstId) {
        const oldIds = new Set(items.map((x) => x.id));
        let newCount = 0;
        for (const x of next) {
          if (!oldIds.has(x.id)) newCount++;
          else break;
        }
        resumeIndex = clampIndex(currentIndex + newCount, next.length);
        currentIndex = 0;
        burstUntil = Date.now() + NEW_BURST_MS;
      }

      setItems(next);
      setFirstId(nextFirst);

      if (Date.now() < burstUntil) {
        setStatus("New photo(s) — showing newest…");
        scrollToIndex(0);
        updateCounter(0, next.length);
      } else {
        setStatus(`Last updated: ${fmt(j.meta?.generatedAt)}`);
        scrollToIndex(currentIndex);
        updateCounter(currentIndex, next.length);
      }

      persist(currentIndex, resumeIndex, burstUntil);
    } catch (e) {
      console.error(e);
      setStatus("Error loading feed. Check server logs.");
    }
  };

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!items.length) return;

      let currentIndex = Number(localStorage.getItem("pf_currentIndex") || "0");
      let resumeIndex = Number(localStorage.getItem("pf_resumeIndex") || "0");
      let burstUntil = Number(localStorage.getItem("pf_burstUntil") || "0");

      if (Date.now() < burstUntil) {
        currentIndex = 0;
        persist(currentIndex, resumeIndex, burstUntil);
        scrollToIndex(0);
        updateCounter(0, items.length);
        return;
      }

      if (resumeIndex && currentIndex === 0) {
        currentIndex = clampIndex(resumeIndex, items.length);
        resumeIndex = 0;
        persist(currentIndex, resumeIndex, burstUntil);
        scrollToIndex(currentIndex);
        updateCounter(currentIndex, items.length);
        return;
      }

      currentIndex = clampIndex(currentIndex + 1, items.length);
      if (currentIndex >= items.length - 1) currentIndex = 0;

      persist(currentIndex, resumeIndex, burstUntil);
      scrollToIndex(currentIndex);
      updateCounter(currentIndex, items.length);
    }, SLIDE_MS);

    return () => clearInterval(timer);
  }, [items]);

  return (
    <div className="wrap">
      <header>
        <div className="title">Procore Photo Feed</div>
        <div className="meta">
          <span className="dot" />
          Auto-scroll • New-photo jump • Updates every {Math.round(POLL_MS / 1000)}s
        </div>
      </header>

      <div id="feed" ref={feedRef}>
        {items.map((x) => {
          const caption = x.commentText?.trim() ? x.commentText : x.description;
          return (
            <div className="card" key={`${x.projectId}:${x.id}`} data-id={x.id}>
              <div className="cardHeader">
                <div className="left">
                  <div className="project">{safe(x.projectName)}</div>
                  <div className="sub">
                    Taken: {fmt(x.takenAt)} • Uploaded: {fmt(x.createdAt)} • By: {safe(x.uploaderName)}
                  </div>
                </div>
                <div className="chips">
                  <div className="chip">Location: {safe(x.locationName)}</div>
                </div>
              </div>

              <div className="imgWrap">
                {/* Use <img> so we don't fight remote domain constraints */}
                <img src={x.imageUrl} alt="" loading="lazy" />
              </div>

              <div className="body">
                <div className="commentLabel">Description / Comment</div>
                <div className="caption">{safe(caption)}</div>
              </div>
            </div>
          );
        })}
      </div>

      <footer>
        <div>{status}</div>
        <div>{counter}</div>
      </footer>
    </div>
  );
}
