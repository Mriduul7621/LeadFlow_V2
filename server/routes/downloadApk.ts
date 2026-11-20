/**
 * downloadApk.ts — GET /api/download-apk, the Android APK download route.
 * ------------------------------------------------------------------
 * The APK file users download carries the app name + version
 * (Mahadi 2026-11-21): "LeadFlow-V-1.0.0.1.apk" — that's
 * versionName.versionCode (see the workflow's Publish step in
 * .github/workflows/android.yml). Because the asset name changes with
 * every version, the web app's popup and login link do NOT point at
 * GitHub directly — they point at this route (one constant,
 * ANDROID_APK_DOWNLOAD_URL in src/native/androidPromo.ts), and this
 * route asks the GitHub Releases API for the `latest` release, picks
 * its newest .apk asset, and redirects to that asset's
 * browser_download_url, which serves the file under its friendly
 * stored name. The LeadFlow link therefore never changes when the
 * version does, and there is no window where a new version breaks
 * the link: before a dispatch the route serves the current release,
 * after it the new one.
 *
 * Rate limits: the GitHub API allows 60 unauthenticated
 * requests/hour per IP, and Vercel egress IPs are shared — so the
 * resolved URL is cached in memory for 10 minutes per instance.
 * (The repo is public, so no token is needed or used.)
 *
 * Failure mode: if GitHub is unreachable, the release has no APK
 * yet, or the API limit is hit, the route redirects to the releases
 * page instead of failing — the user taps the APK there (same file,
 * same friendly name). Never a dead end, never a 404.
 *
 * No database, no auth: this is a public redirect, registered
 * directly on both entrypoints (api/index.ts and server.ts) next to
 * the health/readiness endpoints — never inside the production
 * router, so it stays available on cold start without waiting for
 * DB init.
 */
import type { Request, Response } from 'express';

const REPO = 'Mriduul7621/LeadFlow_V2';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const GITHUB_API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

/** 10-minute in-memory cache (per instance) — see the header note. */
const CACHE_MS = 10 * 60 * 1000;
let cached: { url: string | null; at: number } = { url: null, at: 0 };

interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
  created_at?: string;
}

/** Test seam: drop the cached URL so the next call re-reads GitHub. */
export function resetDownloadApkCache(): void {
  cached = { url: null, at: 0 };
}

/**
 * The browser_download_url of the newest .apk asset in `latest`.
 * `fetchImpl` defaults to the runtime fetch; tests inject a stub.
 */
export async function resolveLatestApkUrl(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  if (cached.url && Date.now() - cached.at < CACHE_MS) return cached.url;
  const res = await fetchImpl(GITHUB_API_LATEST, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'leadflow' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const release = (await res.json()) as { assets?: GithubReleaseAsset[] };
  const apks = (release.assets || []).filter(
    (a) => typeof a.name === 'string' && a.name.endsWith('.apk'),
  );
  if (!apks.length) throw new Error('no APK asset in latest release');
  // `latest` should hold exactly one APK (the workflow deletes the
  // previous version's assets first) — newest-first is belt and
  // braces in case a stale one survives.
  apks.sort(
    (a, b) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
  );
  const url = apks[0].browser_download_url;
  if (!url) throw new Error('newest APK asset has no download URL');
  cached = { url, at: Date.now() };
  return url;
}

/**
 * GET /api/download-apk — 302 to the newest APK asset, or to the
 * releases page when GitHub cannot be asked (never a 404, never a
 * 500). Registered with app.get in both entrypoints, so non-GET
 * methods fall through to the API 404 handler like every other
 * GET-only route.
 */
export async function downloadApkHandler(_req: Request, res: Response): Promise<void> {
  try {
    const url = await resolveLatestApkUrl();
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    res.end();
  } catch (err: unknown) {
    console.error('download-apk redirect failed:', err instanceof Error ? err.message : err);
    res.writeHead(302, { Location: RELEASES_PAGE, 'Cache-Control': 'no-store' });
    res.end();
  }
}
