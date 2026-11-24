import { NextRequest, NextResponse } from "next/server";

// Fallback candidate target URLs for backend API
function getBackendCandidates(): string[] {
  const candidates: string[] = [];

  // 1. Explicit Render blueprint or environment variable host
  if (process.env.BACKEND_HOST) {
    candidates.push(`https://${process.env.BACKEND_HOST}`);
  }
  if (process.env.BACKEND_URL) {
    candidates.push(process.env.BACKEND_URL.replace(/\/$/, ""));
  }
  if (
    process.env.NEXT_PUBLIC_API_URL &&
    !process.env.NEXT_PUBLIC_API_URL.includes("localhost")
  ) {
    candidates.push(process.env.NEXT_PUBLIC_API_URL.replace(/\/api\/?$/, ""));
  }

  // 2. Render private networking within same workspace/blueprint
  candidates.push("http://veritrace-backend:10000");

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
    const targetUrl = `${baseUrl}/api/${path}${query}`;
    const isRenderPublicUrl = baseUrl.includes("onrender.com");
    const attemptDeadline =
      isRenderPublicUrl ? Date.now() + 50000 : Date.now() + 8000;

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
          isRenderPublicUrl ? 15000 : 6000
        );

        const response = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: bodyBuffer,
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeoutId);

        const contentType = response.headers.get("content-type") || "";
        if (
          (response.status === 502 ||
            response.status === 503 ||
            response.status === 504 ||
            (response.status === 404 &&
              contentType.includes("text/html"))) &&
          isRenderPublicUrl
        ) {
          lastError = new Error(`Backend returned HTTP ${response.status}`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
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
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  // All candidates failed or timed out (typical during Render free-tier cold starts)
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
