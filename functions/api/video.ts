// functions/api/video.ts
// Node/Vercel style serverless function
// - POST { action: "queue", duration: "5s"|"10s", imageDataUrl: "data:image/..", prompt?: string }
// - POST { action: "retrieve", model: string, queue_id: string }
//
// Uses Venice Video API:
//   POST https://api.venice.ai/api/v1/video/queue
//   POST https://api.venice.ai/api/v1/video/retrieve
//
// Docs:
//   /video/queue  + duration options 5s/10s + image_url supports data URL :contentReference[oaicite:6]{index=6}
//   /video/retrieve returns status PROCESSING or video when complete :contentReference[oaicite:7]{index=7}

type Json = Record<string, any>;

function json(res: any, status: number, data: Json) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function pickDuration(v: any): "5s" | "10s" {
  return v === "10s" ? "10s" : "5s";
}

function isDataUrl(s: any): boolean {
  return typeof s === "string" && s.startsWith("data:");
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method Not Allowed" });
  }

  const VENICE_API_KEY = process.env.VENICE_API_KEY;
  if (!VENICE_API_KEY) {
    return json(res, 500, { error: "Missing VENICE_API_KEY env var" });
  }

  let body: any = req.body;
  // Some runtimes deliver body as string
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {}
  }
  if (!body || typeof body !== "object") {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const action = body.action;

  const baseURL = "https://api.venice.ai/api/v1";
  const headers = {
    "Authorization": `Bearer ${VENICE_API_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    if (action === "queue") {
      const duration = pickDuration(body.duration);
      const imageDataUrl = body.imageDataUrl;

      if (!isDataUrl(imageDataUrl)) {
        return json(res, 400, { error: "imageDataUrl must be a data: URL" });
      }

      // Model from docs example (image-to-video)
      // :contentReference[oaicite:8]{index=8}
      const model = "grok-imagine-image-to-video";

      const userPrompt = (typeof body.prompt === "string" ? body.prompt.trim() : "");
      const prompt =
        userPrompt.length > 0
          ? userPrompt.slice(0, 2500)
          : "Animate this image into a short cinematic video. Smooth camera motion, natural movement.";

      const payload = {
        model,
        prompt,
        duration,                 // "5s" | "10s" :contentReference[oaicite:9]{index=9}
        image_url: imageDataUrl,  // data URL supported :contentReference[oaicite:10]{index=10}
        aspect_ratio: "16:9",
        resolution: "720p",
        audio: true,
        // optional negative prompt (Venice default exists, but you can override)
        negative_prompt: "low resolution, error, worst quality, low quality, defects",
      };

      const r = await fetch(`${baseURL}/video/queue`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return json(res, r.status, { error: data?.error || data?.detail || "Queue failed", detail: data });
      }

      // Response: { model, queue_id } :contentReference[oaicite:11]{index=11}
      return json(res, 200, { model: data.model, queue_id: data.queue_id });
    }

    if (action === "retrieve") {
      const model = body.model;
      const queue_id = body.queue_id;

      if (typeof model !== "string" || !model) return json(res, 400, { error: "Missing model" });
      if (typeof queue_id !== "string" || !queue_id) return json(res, 400, { error: "Missing queue_id" });

      const payload = {
        model,
        queue_id,
        delete_media_on_completion: true, // recommended cleanup :contentReference[oaicite:12]{index=12}
      };

      const r = await fetch(`${baseURL}/video/retrieve`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const ct = (r.headers.get("content-type") || "").toLowerCase();

      // If still processing, Venice returns JSON with status PROCESSING :contentReference[oaicite:13]{index=13}
      if (ct.includes("application/json")) {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          return json(res, r.status, { error: data?.error || data?.detail || "Retrieve failed", detail: data });
        }
        return json(res, 200, data);
      }

      // If completed, Venice returns the video file (binary) (content-type likely video/mp4)
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return json(res, r.status, { error: "Retrieve failed (non-json)", detail: errText });
      }

      const buf = Buffer.from(await r.arrayBuffer());
      const mime = ct && ct.includes("/") ? ct : "video/mp4";
      const b64 = buf.toString("base64");

      return json(res, 200, {
        status: "COMPLETED",
        video: { mime, b64 },
      });
    }

    return json(res, 400, { error: "Unknown action. Use 'queue' or 'retrieve'." });
  } catch (e: any) {
    return json(res, 500, { error: "Server error", detail: String(e?.message || e) });
  }
}

