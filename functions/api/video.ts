// functions/api/video.ts
export interface Env {
  VENICE_API_KEY: string;
}

function withCors(headers: HeadersInit = {}) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCors({
      "Content-Type": "application/json; charset=utf-8",
    }),
  });
}

function isDataUrlImage(s: unknown): s is string {
  if (typeof s !== "string") return false;
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s.trim());
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // ⚠️ 큰 영상이면 메모리 부담이 큼. 일단 “돌아가게” 용으로 유지.
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export const onRequestOptions = async () => {
  return new Response(null, { status: 204, headers: withCors() });
};

type VeniceQueueResponse = { queue_id?: string } & Record<string, any>;
type VeniceRetrieveJson = { status?: string; video_url?: string; media_url?: string } & Record<string, any>;

function isProcessingStatus(s: unknown) {
  const v = String(s || "").toUpperCase();
  // Venice가 어떤 상태를 쓰든 여기서 넓게 처리
  return (
    v === "PROCESSING" ||
    v === "QUEUED" ||
    v === "PENDING" ||
    v === "STARTING" ||
    v === "RUNNING" ||
    v === "IN_PROGRESS"
  );
}

function isTerminalErrorStatus(s: unknown) {
  const v = String(s || "").toUpperCase();
  return v === "FAILED" || v === "ERROR" || v === "CANCELED" || v === "CANCELLED";
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { request, env } = context;

    if (!env.VENICE_API_KEY) {
      return json({ error: "Missing VENICE_API_KEY in environment secrets." }, 500);
    }

    const body = await request.json().catch(() => null);

    // ✅ 이 엔드포인트는 2가지 모드 지원:
    // (A) { image, duration, prompt, quality } -> queue 만들고 완료까지 시도
    // (B) { queue_id } -> 해당 queue_id로 retrieve만 시도 (프론트 폴링용)
    const queueIdFromClient = body?.queue_id;

    const model = "grok-imagine-image-to-video";
    const resolution =
      body?.quality === "480p" || body?.quality === "720p" || body?.quality === "1080p"
        ? body.quality
        : "480p";

    // -----------------------------
    // (B) Poll-only mode
    // -----------------------------
    if (typeof queueIdFromClient === "string" && queueIdFromClient.trim()) {
      const queueId = queueIdFromClient.trim();
      return await retrieveUntilDone({
        env,
        model,
        queueId,
        // poll-only 모드는 짧게: 25초 정도만 붙잡고, 아니면 202로 계속 폴링 유도
        maxWaitMs: 25_000,
        pollEveryMs: 2_000,
      });
    }

    // -----------------------------
    // (A) Queue + try wait
    // -----------------------------
    const image = body?.image; // data URL string
    const durationRaw = body?.duration; // 5 | 10
    const promptRaw = body?.prompt;

    if (!isDataUrlImage(image)) {
      return json(
        {
          error: "Image required as data URL (e.g. data:image/png;base64,...)",
          receivedType: typeof image,
        },
        400
      );
    }

    const prompt =
      typeof promptRaw === "string" && promptRaw.trim()
        ? promptRaw.trim()
        : "Animate this image into a short cinematic clip.";

    const durNum =
      typeof durationRaw === "number"
        ? String(durationRaw)
        : typeof durationRaw === "string"
          ? durationRaw.trim()
          : "5";

    const dur = durNum === "5" ? "5s" : durNum === "10" ? "10s" : null;
    if (!dur) {
      return json(
        {
          error: "Unsupported duration. Supported: 5, 10",
          supported: [5, 10],
          received: durationRaw,
        },
        400
      );
    }

    // 1) Queue
    const queueRes = await fetch("https://api.venice.ai/api/v1/video/queue", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        duration: dur,
        image_url: image,
        aspect_ratio: "16:9",
        resolution,
        audio: false,
      }),
    });

    const queueText = await queueRes.text().catch(() => "");
    if (!queueRes.ok) {
      return json(
        {
          error: "Venice queue failed",
          status: queueRes.status,
          details: queueText,
        },
        502
      );
    }

    let queueJson: VeniceQueueResponse | null = null;
    try {
      queueJson = JSON.parse(queueText);
    } catch {
      queueJson = null;
    }

    const queueId = queueJson?.queue_id;
    if (!queueId) {
      return json({ error: "Venice queue response missing queue_id", details: queueText }, 502);
    }

    // 2) Try retrieve while keeping the request (짧게만)
    // ⚠️ 플랫폼 타임아웃 때문에 3분 붙잡지 말고,
    //     25~30초 정도만 기다렸다가 202로 queue_id를 줘서 프론트가 이어서 폴링하게 함.
    return await retrieveUntilDone({
      env,
      model,
      queueId,
      maxWaitMs: 25_000,
      pollEveryMs: 2_000,
    });
  } catch (e: any) {
    return json({ error: "Unhandled server error", details: String(e?.message || e) }, 500);
  }
};

async function retrieveUntilDone(opts: {
  env: Env;
  model: string;
  queueId: string;
  maxWaitMs: number;
  pollEveryMs: number;
}) {
  const { env, model, queueId, maxWaitMs, pollEveryMs } = opts;

  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const r = await fetch("https://api.venice.ai/api/v1/video/retrieve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        queue_id: queueId,
        delete_media_on_completion: true,
      }),
    });

    // ✅ 먼저 ok 체크 (실패면 text로 읽어 에러 반환)
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return json(
        { error: "Venice retrieve failed", status: r.status, details: t, queue_id: queueId },
        502
      );
    }

    const ct = (r.headers.get("content-type") || "").toLowerCase();

    // JSON이면 상태 응답일 가능성
    if (ct.includes("application/json")) {
      const j = (await r.json().catch(() => null)) as VeniceRetrieveJson | null;
      const status = j?.status;

      // ✅ 계속 처리중이면 대기
      if (isProcessingStatus(status)) {
        await sleep(pollEveryMs);
        continue;
      }

      // ✅ JSON에 url이 포함돼 오는 타입이면(벤더에 따라 가능) 그걸 사용
      const maybeUrl = j?.video_url || j?.media_url;
      if (typeof maybeUrl === "string" && maybeUrl.startsWith("http")) {
        return json({ videoUrl: maybeUrl, queue_id: queueId, status: status || "DONE" }, 200);
      }

      if (isTerminalErrorStatus(status)) {
        return json({ error: "Venice reported terminal failure", queue_id: queueId, details: j }, 502);
      }

      // 그 외: 알 수 없는 JSON
      return json(
        { error: "Venice retrieve returned unexpected JSON", queue_id: queueId, details: j },
        502
      );
    }

    // JSON이 아니면 영상 바이너리라고 보고 처리
    const videoBuf = await r.arrayBuffer();

    // 너무 큰 영상은 base64로 터질 수 있음 (일단 가드)
    const maxBytes = 12 * 1024 * 1024; // 12MB
    if (videoBuf.byteLength > maxBytes) {
      return json(
        {
          error: "Video too large to return as data URL. Use storage + URL approach.",
          queue_id: queueId,
          bytes: videoBuf.byteLength,
        },
        502
      );
    }

    const videoB64 = arrayBufferToBase64(videoBuf);
    const videoMime = ct.startsWith("video/") ? ct.split(";")[0] : "video/mp4";
    const videoDataUrl = `data:${videoMime};base64,${videoB64}`;

    return json({ videoUrl: videoDataUrl, queue_id: queueId }, 200);
  }

  // ✅ 짧게 기다렸는데 아직이면 202로 queue_id 반환 (프론트 폴링 유도)
  return json(
    { status: "PROCESSING", queue_id: queueId, message: "Still generating. Poll with {queue_id}." },
    202
  );
}
