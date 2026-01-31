// functions/api/video.ts
// Cloudflare Pages Functions

type QueueBody = {
  action: "queue";
  duration?: "5s" | "10s";
  imageDataUrl: string;
  prompt?: string;
  // 네가 원하면 모델도 프론트에서 넘겨서 쓰게 할 수 있음:
  model?: string;
};

type RetrieveBody = {
  action: "retrieve";
  model: string;
  queue_id: string;
};

function cors(origin?: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: any, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function pickDuration(v: any): "5s" | "10s" {
  return v === "10s" ? "10s" : "5s";
}

function isDataUrl(s: any): s is string {
  return typeof s === "string" && s.startsWith("data:");
}

function bestErrMsg(data: any, fallback: string) {
  return (
    (typeof data?.message === "string" && data.message) ||
    (typeof data?.error === "string" && data.error) ||
    (typeof data?.detail === "string" && data.detail) ||
    fallback
  );
}

// ✅ OPTIONS preflight
export const onRequestOptions: PagesFunction = async (ctx) => {
  const origin = ctx.request.headers.get("Origin") || undefined;
  return new Response(null, { status: 204, headers: cors(origin) });
};

export const onRequestPost: PagesFunction = async (ctx) => {
  const origin = ctx.request.headers.get("Origin") || undefined;

  let body: any;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400, headers: cors(origin) });
  }

  const apiKey = (ctx.env as any)?.VENICE_API_KEY;
  if (!apiKey) {
    return json({ error: "Missing VENICE_API_KEY" }, { status: 500, headers: cors(origin) });
  }

  const baseURL = "https://api.venice.ai/api/v1";
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    // ---------------------------
    // action: queue
    // ---------------------------
    if (body.action === "queue") {
      const b = body as QueueBody;
      const duration = pickDuration(b.duration);

      if (!isDataUrl(b.imageDataUrl)) {
        return json({ error: "imageDataUrl must be a data: URL" }, { status: 400, headers: cors(origin) });
      }

      // ✅ 모델은 두 가지 방식 중 하나로:
      // 1) 서버에서 고정
      // 2) 프론트에서 model 넘기면 그걸 사용
      // (원하는 모델을 “찾아 붙여넣기” 했으면, 아래 default를 네 모델로 바꾸면 됨)
      const model = (typeof b.model === "string" && b.model.trim()) || "wan-2.5-preview-image-to-video";

      const userPrompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
      const prompt =
        userPrompt.length > 0
          ? userPrompt.slice(0, 2500)
          : "Animate this image into a short cinematic video. Smooth camera motion, natural movement.";

      // Venice video queue payload
      // docs: POST /video/queue :contentReference[oaicite:2]{index=2}
      const payload = {
        model,
        prompt,
        duration,                  // "5s" | "10s"
        image_url: b.imageDataUrl, // URL or data URL (docs)
        aspect_ratio: "16:9",
        resolution: "720p",
        audio: true,
        negative_prompt: "low resolution, error, worst quality, low quality, defects",
      };

      const r = await fetch(`${baseURL}/video/queue`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const data = await r.json().catch(() => ({} as any));

      if (!r.ok) {
        return json(
          {
            error: bestErrMsg(data, "Queue failed"),
            code: data?.code || null,
            status: r.status,
            venice: data,
          },
          { status: r.status, headers: cors(origin) }
        );
      }

      // ✅ success: should include queue_id (docs)
      return json({ model: data.model || model, queue_id: data.queue_id }, { status: 200, headers: cors(origin) });
    }

    // ---------------------------
    // action: retrieve
    // ---------------------------
    if (body.action === "retrieve") {
      const b = body as RetrieveBody;

      if (!b.model || typeof b.model !== "string") {
        return json({ error: "Missing model" }, { status: 400, headers: cors(origin) });
      }
      if (!b.queue_id || typeof b.queue_id !== "string") {
        return json({ error: "Missing queue_id" }, { status: 400, headers: cors(origin) });
      }

      // docs: poll /video/retrieve with queue_id :contentReference[oaicite:3]{index=3}
      const payload = {
        model: b.model,
        queue_id: b.queue_id,
        delete_media_on_completion: true,
      };

      const r = await fetch(`${baseURL}/video/retrieve`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const ct = (r.headers.get("content-type") || "").toLowerCase();

      // 대부분 JSON (PROCESSING / COMPLETED with urls 등). JSON이면 그대로 전달
      if (ct.includes("application/json")) {
        const data = await r.json().catch(() => ({} as any));

        if (!r.ok) {
          return json(
            {
              error: bestErrMsg(data, "Retrieve failed"),
              code: data?.code || null,
              status: r.status,
              venice: data,
            },
            { status: r.status, headers: cors(origin) }
          );
        }

        return json(data, { status: 200, headers: cors(origin) });
      }

      // 만약 바이너리로 오는 케이스도 대비 (mp4 등)
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return json({ error: "Retrieve failed (non-json)", detail: txt, status: r.status }, { status: r.status, headers: cors(origin) });
      }

      const ab = await r.arrayBuffer();
      const mime = ct && ct.includes("/") ? ct : "video/mp4";

      // Cloudflare에서 안전한 base64 변환
      const bytes = new Uint8Array(ab);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);

      return json({ status: "COMPLETED", video: { mime, b64 } }, { status: 200, headers: cors(origin) });
    }

    return json({ error: "Unknown action. Use 'queue' or 'retrieve'." }, { status: 400, headers: cors(origin) });
  } catch (e: any) {
    return json({ error: "Server error", detail: String(e?.message || e) }, { status: 500, headers: cors(origin) });
  }
};
