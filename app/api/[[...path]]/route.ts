import { NextRequest, NextResponse } from "next/server";

// Dynamic candidate target URLs for backend API
function getBackendCandidates(): string[] {
  const candidates: string[] = [];

  const addCandidate = (raw?: string) => {
    if (!raw) return;
    const trimmed = raw.trim().replace(/\/$/, "");
    if (!trimmed) return;

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      candidates.push(trimmed);
      return;
    }

    // If it's a domain name (contains a dot like .onrender.com)
    if (trimmed.includes(".")) {
      candidates.push(`https://${trimmed}`);
      candidates.push(`http://${trimmed}`);
    } else {
      // Private network hostname (e.g. veritrace-backend or veritrace-backend:10000)
      if (trimmed.includes(":")) {
        candidates.push(`http://${trimmed}`);
      } else {
        candidates.push(`http://${trimmed}:10000`);
        candidates.push(`http://${trimmed}:3001`);
        candidates.push(`http://${trimmed}`);
      }
    }
  };

  // 1. Explicit Render blueprint or environment variable host
  addCandidate(process.env.BACKEND_HOST);
  addCandidate(process.env.BACKEND_URL);

  if (process.env.BACKEND_HOST && process.env.BACKEND_PORT) {
    candidates.push(`http://${process.env.BACKEND_HOST.trim()}:${process.env.BACKEND_PORT.trim()}`);
  }

  if (
    process.env.NEXT_PUBLIC_API_URL &&
    !process.env.NEXT_PUBLIC_API_URL.includes("localhost")
  ) {
    addCandidate(process.env.NEXT_PUBLIC_API_URL.replace(/\/api\/?$/, ""));
  }

  // 2. Render private networking within same workspace/blueprint
  candidates.push("http://veritrace-backend:10000");
  candidates.push("http://veritrace-backend");

  // 3. Known Render public endpoints
  candidates.push("https://veritrace-backend.onrender.com");

  // 4. Local machine development
  candidates.push("http://127.0.0.1:3001");
  candidates.push("http://localhost:3001");

  // Return unique non-empty URLs
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function proxyRequest(
  req: NextRequest,
  context: { params: Promise<{ path?: string[] }> | { path?: string[] } }
) {
  const resolvedParams = "then" in context.params ? await context.params : context.params;
  const path = resolvedParams?.path ? resolvedParams.path.join("/") : "";
  const searchParams = req.nextUrl.searchParams.toString();
  const query = searchParams ? `?${searchParams}` : "";

  // Handle CORS preflight if called directly
  if (req.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // Quick diagnostics check without proxying
  if (path === "proxy-health") {
    return NextResponse.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      env: {
        BACKEND_HOST: process.env.BACKEND_HOST || null,
        BACKEND_PORT: process.env.BACKEND_PORT || null,
        BACKEND_URL: process.env.BACKEND_URL || null,
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || null,
      },
      candidates: getBackendCandidates(),
    });
  }

  const candidateUrls = getBackendCandidates();
  let lastError: Error | null = null;

  // Read request body once if needed
  let bodyBuffer: ArrayBuffer | undefined = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      bodyBuffer = await req.arrayBuffer();
    } catch {
      bodyBuffer = undefined;
    }
  }

  for (const baseUrl of candidateUrls) {
    const targetUrl = path ? `${baseUrl}/api/${path}${query}` : `${baseUrl}/api${query}`;
    const isRenderPublicUrl = baseUrl.includes("onrender.com");
    // Shorter deadline so users don't hang if a URL is invalid
    const attemptDeadline = isRenderPublicUrl ? Date.now() + 20000 : Date.now() + 4000;

    while (Date.now() < attemptDeadline) {
      try {
        const headers = new Headers();
        req.headers.forEach((value, key) => {
          const lowerKey = key.toLowerCase();
          if (
            lowerKey !== "host" &&
            lowerKey !== "connection" &&
            lowerKey !== "content-length"
          ) {
            headers.set(key, value);
          }
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          isRenderPublicUrl ? 10000 : 3500
        );

        const response = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: bodyBuffer,
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeoutId);

        // Only retry if Render specifically gives a 502/503/504 cold-start response
        if (
          (response.status === 502 || response.status === 503 || response.status === 504) &&
          isRenderPublicUrl
        ) {
          lastError = new Error(`Backend returned HTTP ${response.status}`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        // If the candidate returns 404 HTML (e.g. an incorrect service host on Render), skip to next candidate
        const contentType = response.headers.get("content-type") || "";
        if (response.status === 404 && contentType.includes("text/html")) {
          lastError = new Error(`Candidate ${baseUrl} returned 404 HTML`);
          break; // Try next candidate immediately
        }

        const responseBody = await response.arrayBuffer();
        const resHeaders = new Headers();
        response.headers.forEach((value, key) => {
          const lowerKey = key.toLowerCase();
          if (lowerKey !== "transfer-encoding") {
            resHeaders.set(key, value);
          }
        });

        return new NextResponse(responseBody, {
          status: response.status,
          statusText: response.statusText,
          headers: resHeaders,
        });
      } catch (err: any) {
        lastError = err;
        if (!isRenderPublicUrl) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  // All candidates failed or timed out
  return NextResponse.json(
    {
      error: "Backend Unavailable",
      message:
        "The backend service is currently waking up on Render free tier (cold starts take 30–50 seconds). Please wait a moment and try again.",
      details: lastError?.message || "All backend connection candidates failed",
    },
    { status: 503 }
  );
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
export const OPTIONS = proxyRequest;
export const HEAD = proxyRequest;
