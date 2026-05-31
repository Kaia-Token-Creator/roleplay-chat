// functions/api/video2.ts
// Cloudflare Pages Functions
//
// PayPal payment verification is preserved.
// Video generation flow:
// 1) Verify PayPal order for selected duration.
// 2) Try ModelsLab video queue first.
// 3) If ModelsLab queue fails, fallback to Venice video.
// 4) Retrieve supports both ModelsLab and Venice queue IDs.

type QueueBody = {
  action: "queue";
  orderID: string;
  duration?: "5s" | "10s";
  imageDataUrl: string;
  prompt?: string;
  // Venice model override only. If omitted, Venice default is used for Venice fallback.
  model?: string;
};

type RetrieveBody = {
  action: "retrieve";
  model: string;
  queue_id: string;
};

type Provider = "modelslab" | "venice";

const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const VENICE_DEFAULT_VIDEO_MODEL = "wan-2-7-image-to-video";

// ModelsLab Ultra is required for real 5s/10s style output.
// Normal img2video is too frame-limited and produces very short clips.
const MODELSLAB_IMG2VIDEO_ULTRA_URL = "https://modelslab.com/api/v6/video/img2video_ultra";
const MODELSLAB_FETCH_VIDEO_URL_BASE = "https://modelslab.com/api/v6/video/fetch";
const MODELSLAB_BASE64_TO_URL = "https://modelslab.com/api/v6/base64_to_url";

// Optional Cloudflare env override: MODELSLAB_VIDEO_MODEL_ID
const MODELSLAB_DEFAULT_VIDEO_MODEL = "wan2.2";

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

function pickModelsLabVideoSettings(duration: "5s" | "10s") {
  if (duration === "10s") {
    // ModelsLab Ultra currently rejects num_frames > 120.
    // fps <= 16 is allowed, so use 12 fps for the long option.
    // 120 frames / 12 fps = 10 seconds.
    return {
      frames: 120,
      fps: 12,
      expectedSeconds: 10,
    };
  }

  // 80 frames / 16 fps = 5 seconds.
  return {
    frames: 80,
    fps: 16,
    expectedSeconds: 5,
  };
}

function isDataUrl(s: any): s is string {
  return typeof s === "string" && s.startsWith("data:");
}

function isHttpUrl(s: any): s is string {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

function stripDataUrlPrefix(dataUrl: string) {
  return String(dataUrl || "").replace(/^data:[^;]+;base64,/i, "").trim();
}

function bestErrMsg(data: any, fallback: string) {
  return (
    (typeof data?.message === "string" && data.message) ||
    (typeof data?.error === "string" && data.error) ||
    (typeof data?.detail === "string" && data.detail) ||
    (typeof data?.messege === "string" && data.messege) ||
    fallback
  );
}

function serializeErr(e: any) {
  if (!e) return { message: "unknown error" };

  if (typeof e === "object") {
    const out: any = {};
    for (const k of Object.keys(e)) out[k] = e[k];

    if (e instanceof Error) {
      out.name = e.name;
      out.message = e.message;
      out.stack = e.stack;
    } else if (out.message == null) {
      out.message = String(e?.message || "error");
    }

    return out;
  }

  return { message: String(e) };
}

function providerQueueId(provider: Provider, rawId: string) {
  return `${provider}:${rawId}`;
}

function parseProviderQueueId(model: string, queue_id: string): { provider: Provider; rawId: string } {
  const q = String(queue_id || "");
  const m = String(model || "");

  if (q.startsWith("modelslab:")) {
    return { provider: "modelslab", rawId: q.slice("modelslab:".length) };
  }

  if (q.startsWith("venice:")) {
    return { provider: "venice", rawId: q.slice("venice:".length) };
  }

  if (m.startsWith("modelslab:")) {
    return { provider: "modelslab", rawId: q };
  }

  if (m.startsWith("venice:")) {
    return { provider: "venice", rawId: q };
  }

  // Backward compatibility:
  // Old unprefixed queue IDs are treated as Venice IDs.
  return { provider: "venice", rawId: q };
}

function guessVideoMimeFromUrl(url: string) {
  const clean = String(url || "").split("?")[0].toLowerCase();

  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".mov")) return "video/quicktime";
  if (clean.endsWith(".mp4")) return "video/mp4";

  return "video/mp4";
}

function arrayBufferToBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function fetchUrlAsBase64(url: string, kind: "video" | "image" = "video") {
  let lastErr: any = null;

  // ModelsLab CDN/R2 links can appear before the file is actually readable.
  for (let i = 0; i < 8; i++) {
    if (i > 0) await sleep(1500);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": kind === "video" ? "video/mp4,video/webm,video/*,*/*;q=0.8" : "image/*,*/*;q=0.8",
      },
    });

    if (res.ok) {
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
      const mime = ct && ct.includes("/") ? ct : kind === "video" ? guessVideoMimeFromUrl(url) : "image/jpeg";
      const ab = await res.arrayBuffer();

      return {
        mime,
        b64: arrayBufferToBase64(ab),
      };
    }

    lastErr = {
      where: `${kind}_url_download`,
      status: res.status,
      statusText: res.statusText,
      url,
      attempt: i + 1,
    };

    if (res.status !== 404 && res.status !== 403 && res.status !== 429) break;
  }

  throw lastErr || {
    where: `${kind}_url_download`,
    message: "unknown download error",
    url,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ✅ PayPal payment verification.
// This throws on failure; if it returns, payment is verified.
async function verifyPaypalOrder(
  orderID: string,
  duration: "5s" | "10s",
  ctx: any
) {
  if (!orderID || typeof orderID !== "string") {
    throw new Error("Missing PayPal orderID");
  }

  const env = (ctx.env || {}) as any;

  // ⚠️ Put these in Cloudflare Pages env vars, never frontend code.
  const PAYPAL_ENV = (env.PAYPAL_ENV || "sandbox").toLowerCase(); // "sandbox" | "live"
  const PAYPAL_CLIENT_ID = env.PAYPAL_CLIENT_ID;
  const PAYPAL_CLIENT_SECRET = env.PAYPAL_CLIENT_SECRET;
  const PAYPAL_MERCHANT_ID = env.PAYPAL_MERCHANT_ID;

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in env");
  }

  if (!PAYPAL_MERCHANT_ID) {
    throw new Error("Missing PAYPAL_MERCHANT_ID in env");
  }

  const base =
    PAYPAL_ENV === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

  const expectedValue = duration === "10s" ? "2.00" : "1.50";
  const expectedCurrency = "USD";

  // --- 1) Get PayPal access token ---
  const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const tokenJson: any = await tokenRes.json().catch(() => ({}));

  if (!tokenRes.ok || !tokenJson?.access_token) {
    const msg = tokenJson?.error_description || tokenJson?.error || "PayPal token failed";
    throw new Error(`${msg} (status=${tokenRes.status})`);
  }

  const accessToken = tokenJson.access_token as string;

  // --- 2) Fetch order details ---
  const orderRes = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderID)}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const order: any = await orderRes.json().catch(() => ({}));

  if (!orderRes.ok) {
    const msg = order?.message || order?.name || "PayPal order lookup failed";
    throw new Error(`${msg} (status=${orderRes.status})`);
  }

  // --- 3) Validate status ---
  const status = String(order?.status || "");

  if (status !== "COMPLETED") {
    throw new Error(`PayPal order not COMPLETED (status=${status})`);
  }

  // --- 4) Validate amount/currency ---
  const pu0 = Array.isArray(order?.purchase_units) ? order.purchase_units[0] : null;

  const amountObj =
    pu0?.amount ||
    pu0?.payments?.captures?.[0]?.amount ||
    null;

  const currency = String(amountObj?.currency_code || "");

  const value = typeof amountObj?.value === "string"
    ? amountObj.value
    : amountObj?.value != null
      ? String(amountObj.value)
      : "";

  const norm = (v: string) => {
    const n = Number(v);
    if (!isFinite(n)) return "";
    return n.toFixed(2);
  };

  if (currency !== expectedCurrency) {
    throw new Error(`Wrong currency (got=${currency}, expected=${expectedCurrency})`);
  }

  if (norm(value) !== expectedValue) {
    throw new Error(`Wrong amount (got=${norm(value)}, expected=${expectedValue})`);
  }

  // --- 5) Validate receiver merchant ---
  const payeeMerchant =
    pu0?.payee?.merchant_id ||
    pu0?.payments?.captures?.[0]?.payee?.merchant_id ||
    "";

  if (String(payeeMerchant) !== String(PAYPAL_MERCHANT_ID)) {
    throw new Error(
      `Wrong merchant (got=${String(payeeMerchant)}, expected=${String(PAYPAL_MERCHANT_ID)})`
    );
  }

  // ✅ valid
}

// ✅ OPTIONS preflight
export const onRequestOptions: PagesFunction = async (ctx) => {
  const origin = ctx.request.headers.get("Origin") || undefined;

  return new Response(null, {
    status: 204,
    headers: cors(origin),
  });
};

export const onRequestPost: PagesFunction<{
  VENICE_API_KEY: string;
  MODELSLAB_API_KEY: string;
  MODELSLAB_VIDEO_MODEL_ID?: string;

  PAYPAL_ENV?: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_MERCHANT_ID: string;
}> = async (ctx) => {
  const origin = ctx.request.headers.get("Origin") || undefined;

  let body: any;

  try {
    body = await ctx.request.json();
  } catch {
    return json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors(origin) }
    );
  }

  const veniceApiKey = (ctx.env as any)?.VENICE_API_KEY;
  const modelslabApiKey = (ctx.env as any)?.MODELSLAB_API_KEY;

  try {
    // ---------------------------
    // action: queue
    // ---------------------------
    if (body.action === "queue") {
      const b = body as QueueBody;
      const duration = pickDuration(b.duration);

      // ✅ Existing payment verification preserved.
      await verifyPaypalOrder(b.orderID, duration, ctx);

      if (!isDataUrl(b.imageDataUrl) && !isHttpUrl(b.imageDataUrl)) {
        return json(
          { error: "imageDataUrl must be a data: URL or http(s) URL" },
          { status: 400, headers: cors(origin) }
        );
      }

      const userPrompt = typeof b.prompt === "string" ? b.prompt.trim() : "";

      const prompt =
        userPrompt.length > 0
          ? userPrompt.slice(0, 2500)
          : "Animate this image into a short cinematic video. Smooth camera motion, natural movement, realistic motion, intimate cinematic atmosphere.";

      // 1) ModelsLab first
      if (modelslabApiKey) {
        try {
          const modelslabQueued = await queueModelsLabVideo({
            apiKey: modelslabApiKey,
            model_id: (ctx.env as any)?.MODELSLAB_VIDEO_MODEL_ID || MODELSLAB_DEFAULT_VIDEO_MODEL,
            prompt,
            duration,
            imageDataUrl: b.imageDataUrl,
          });

          return json(
            {
              provider: "modelslab",
              model: `modelslab:${modelslabQueued.model_id}`,
              queue_id: providerQueueId("modelslab", String(modelslabQueued.id)),
              fallback: false,
              duration,
              fps: modelslabQueued.fps,
              num_frames: modelslabQueued.num_frames,
              expected_seconds: modelslabQueued.expected_seconds,
            },
            { status: 200, headers: cors(origin) }
          );
        } catch (modelslabErr) {
          console.log("ModelsLab video queue failed. Falling back to Venice:", serializeErr(modelslabErr));

          if (!veniceApiKey) {
            return json(
              {
                error: "ModelsLab video queue failed and VENICE_API_KEY is missing.",
                detail: serializeErr(modelslabErr),
              },
              { status: 502, headers: cors(origin) }
            );
          }

          const veniceQueued = await queueVeniceVideo({
            apiKey: veniceApiKey,
            model: (typeof b.model === "string" && b.model.trim()) || VENICE_DEFAULT_VIDEO_MODEL,
            prompt,
            duration,
            imageDataUrl: b.imageDataUrl,
          });

          return json(
            {
              provider: "venice",
              model: `venice:${veniceQueued.model}`,
              queue_id: providerQueueId("venice", veniceQueued.queue_id),
              fallback: true,
              fallbackFrom: "modelslab_video_queue_failure",
              modelslab: serializeErr(modelslabErr),
              duration,
            },
            { status: 200, headers: cors(origin) }
          );
        }
      }

      // 2) If ModelsLab key is absent, use Venice directly after PayPal verification.
      if (!veniceApiKey) {
        return json(
          { error: "Missing MODELSLAB_API_KEY and VENICE_API_KEY" },
          { status: 500, headers: cors(origin) }
        );
      }

      const veniceQueued = await queueVeniceVideo({
        apiKey: veniceApiKey,
        model: (typeof b.model === "string" && b.model.trim()) || VENICE_DEFAULT_VIDEO_MODEL,
        prompt,
        duration,
        imageDataUrl: b.imageDataUrl,
      });

      return json(
        {
          provider: "venice",
          model: `venice:${veniceQueued.model}`,
          queue_id: providerQueueId("venice", veniceQueued.queue_id),
          fallback: true,
          fallbackFrom: "missing_modelslab_api_key",
          duration,
        },
        { status: 200, headers: cors(origin) }
      );
    }

    // ---------------------------
    // action: retrieve
    // ---------------------------
    if (body.action === "retrieve") {
      const b = body as RetrieveBody;

      if (!b.model || typeof b.model !== "string") {
        return json(
          { error: "Missing model" },
          { status: 400, headers: cors(origin) }
        );
      }

      if (!b.queue_id || typeof b.queue_id !== "string") {
        return json(
          { error: "Missing queue_id" },
          { status: 400, headers: cors(origin) }
        );
      }

      const parsed = parseProviderQueueId(b.model, b.queue_id);

      console.log("VIDEO RETRIEVE REQUEST:", {
        model: b.model,
        queue_id: b.queue_id,
        provider: parsed.provider,
        rawId: parsed.rawId,
      });

      if (parsed.provider === "modelslab") {
        if (!modelslabApiKey) {
          return json(
            { error: "Missing MODELSLAB_API_KEY" },
            { status: 500, headers: cors(origin) }
          );
        }

        const result = await retrieveModelsLabVideo({
          apiKey: modelslabApiKey,
          id: parsed.rawId,
        });

        return json(result, {
          status: 200,
          headers: cors(origin),
        });
      }

      if (!veniceApiKey) {
        return json(
          { error: "Missing VENICE_API_KEY" },
          { status: 500, headers: cors(origin) }
        );
      }

      const result = await retrieveVeniceVideo({
        apiKey: veniceApiKey,
        model: b.model.startsWith("venice:") ? b.model.slice("venice:".length) : b.model,
        queue_id: parsed.rawId,
      });

      return json(result, {
        status: 200,
        headers: cors(origin),
      });
    }

    return json(
      { error: "Unknown action. Use 'queue' or 'retrieve'." },
      { status: 400, headers: cors(origin) }
    );
  } catch (e: any) {
    console.log("VIDEO API SERVER ERROR:", serializeErr(e));

    return json(
      {
        error: "Server error",
        detail: serializeErr(e),
      },
      { status: 500, headers: cors(origin) }
    );
  }
};

async function queueModelsLabVideo(args: {
  apiKey: string;
  model_id: string;
  prompt: string;
  duration: "5s" | "10s";
  imageDataUrl: string;
}): Promise<{
  id: string | number;
  model_id: string;
  num_frames: number;
  fps: number;
  expected_seconds: number;
}> {
  const initImage = await ensureModelsLabInitImageUrl(args.apiKey, args.imageDataUrl);

  const settings = pickModelsLabVideoSettings(args.duration);
  const fps = settings.fps;
  const frames = settings.frames;

  console.log("MODELSLAB VIDEO QUEUE SETTINGS:", {
    duration: args.duration,
    model_id: args.model_id,
    fps,
    num_frames: frames,
    expected_seconds: settings.expectedSeconds,
  });

  const payload = {
    key: args.apiKey,
    init_image: initImage,
    model_id: args.model_id || MODELSLAB_DEFAULT_VIDEO_MODEL,

    prompt: buildModelsLabVideoPrompt(args.prompt),
    negative_prompt: buildModelsLabVideoNegativePrompt(),

    // ModelsLab Ultra settings.
    // Length is controlled by num_frames / fps.
    // 5s  = 80 / 16 = 5s
    // 10s = 120 / 12 = 10s
    resolution: 480,
    num_frames: frames,
    num_inference_steps: 25,
    guidance_scale: 4,
    fps,

    // Keep square-ish output like the current image chat.
    // Set true only if your frontend expects 9:16 portrait video.
    portrait: false,

    sample_shift: 5,
    base64: false,
    temp: false,
    webhook: null,
    track_id: null,
  };

  const data = await postModelsLabJson(
    MODELSLAB_IMG2VIDEO_ULTRA_URL,
    payload,
    "modelslab_video_img2video_ultra"
  );

  const status = String(data?.status || "").toLowerCase();

  if (status === "error" || status === "failed") {
    throw {
      where: "modelslab_video_queue_failed",
      body_json: data,
      message: bestErrMsg(data, "ModelsLab video queue failed"),
    };
  }

  const id = data?.id || data?.generation_id || data?.fetch_result || data?.queue_id;

  if (id == null) {
    throw {
      where: "modelslab_video_queue_parse",
      body_json: data,
      message: "Missing id",
    };
  }

  return {
    id,
    model_id: payload.model_id,
    num_frames: frames,
    fps,
    expected_seconds: settings.expectedSeconds,
  };
}

async function retrieveModelsLabVideo(args: {
  apiKey: string;
  id: string;
}) {
  const data = await postModelsLabJson(
    `${MODELSLAB_FETCH_VIDEO_URL_BASE}/${encodeURIComponent(String(args.id))}`,
    { key: args.apiKey },
    "modelslab_video_fetch"
  );

  const status = String(data?.status || "").toLowerCase();

  if (status === "processing" || status === "queued" || status === "pending") {
    return {
      status: "PROCESSING",
      provider: "modelslab",
      eta: data?.eta ?? null,
      message: data?.message || "Processing",
    };
  }

  if (status === "error" || status === "failed") {
    throw {
      where: "modelslab_video_fetch_failed",
      body_json: data,
      message: bestErrMsg(data, "ModelsLab video generation failed"),
    };
  }

  const candidates = extractUrlCandidates(data);
  const videoUrl = candidates[0];

  if (!videoUrl) {
    // Sometimes success arrives before links are populated.
    return {
      status: "PROCESSING",
      provider: "modelslab",
      eta: data?.eta ?? null,
      message: data?.message || "Waiting for video URL",
    };
  }

  const video = await fetchUrlAsBase64(videoUrl, "video");

  return {
    status: "COMPLETED",
    provider: "modelslab",
    video,
    videoUrl,
    output: data?.output || [],
    proxy_links: data?.proxy_links || [],
    future_links: data?.future_links || [],
  };
}

async function queueVeniceVideo(args: {
  apiKey: string;
  model: string;
  prompt: string;
  duration: "5s" | "10s";
  imageDataUrl: string;
}): Promise<{
  model: string;
  queue_id: string;
}> {
  const payload = {
    model: args.model,
    prompt: args.prompt,
    duration: args.duration,
    image_url: args.imageDataUrl,
    resolution: "720p",
    negative_prompt: "low resolution, error, worst quality, low quality, defects, blurry, distorted, watermark, text, logo",
  };

  const r = await fetch(`${VENICE_BASE_URL}/video/queue`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await r.text().catch(() => "");

  let data: any = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  if (!r.ok) {
    throw {
      where: "venice_video_queue",
      status: r.status,
      statusText: r.statusText,
      body_json: data,
      body_raw: raw.slice(0, 4000),
    };
  }

  const queue_id = String(data?.queue_id || "").trim();

  if (!queue_id) {
    throw {
      where: "venice_video_queue_parse",
      body_json: data,
      message: "Missing queue_id",
    };
  }

  return {
    model: data?.model || args.model,
    queue_id,
  };
}

async function retrieveVeniceVideo(args: {
  apiKey: string;
  model: string;
  queue_id: string;
}) {
  const payload = {
    model: args.model,
    queue_id: args.queue_id,
    delete_media_on_completion: true,
  };

  const r = await fetch(`${VENICE_BASE_URL}/video/retrieve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const ct = (r.headers.get("content-type") || "").toLowerCase();

  // Most Venice responses are JSON: PROCESSING / COMPLETED with URLs or payload.
  if (ct.includes("application/json")) {
    const data = await r.json().catch(() => ({} as any));

    if (!r.ok) {
      throw {
        where: "venice_video_retrieve",
        status: r.status,
        statusText: r.statusText,
        body_json: data,
      };
    }

    return data;
  }

  // Binary fallback.
  if (!r.ok) {
    const txt = await r.text().catch(() => "");

    throw {
      where: "venice_video_retrieve_non_json",
      status: r.status,
      statusText: r.statusText,
      body_raw: txt.slice(0, 4000),
    };
  }

  const ab = await r.arrayBuffer();
  const mime = ct && ct.includes("/") ? ct : "video/mp4";
  const b64 = arrayBufferToBase64(ab);

  return {
    status: "COMPLETED",
    provider: "venice",
    video: {
      mime,
      b64,
    },
  };
}

async function postModelsLabJson(url: string, payload: any, where: string) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await r.text().catch(() => "");

  console.log(`${where.toUpperCase()} STATUS:`, r.status);
  console.log(`${where.toUpperCase()} BODY:`, raw.slice(0, 2000));

  let data: any = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  if (!r.ok) {
    throw {
      where,
      status: r.status,
      statusText: r.statusText,
      body_json: data,
      body_raw: raw.slice(0, 4000),
    };
  }

  const status = String(data?.status || "").toLowerCase();

  if (status === "error" || status === "failed") {
    throw {
      where,
      status: data?.status,
      message: bestErrMsg(data, `${where} failed`),
      body_json: data,
      body_raw: raw.slice(0, 4000),
    };
  }

  return data;
}

async function ensureModelsLabInitImageUrl(apiKey: string, imageDataUrlOrUrl: string) {
  if (isHttpUrl(imageDataUrlOrUrl)) return imageDataUrlOrUrl;

  if (!isDataUrl(imageDataUrlOrUrl)) {
    throw {
      where: "modelslab_init_image",
      message: "init image must be data URL or URL",
    };
  }

  const fullDataUrl = String(imageDataUrlOrUrl || "").trim();
  const rawBase64 = stripDataUrlPrefix(fullDataUrl);

  // ModelsLab Ultra init_image is safest as a URL.
  // So convert data URL to hosted URL first.
  // Try multiple known ModelsLab base64-to-url variants for account compatibility.
  const attempts = [
    {
      where: "modelslab_base64_to_url_full_dataurl",
      url: MODELSLAB_BASE64_TO_URL,
      payload: {
        key: apiKey,
        base64_string: fullDataUrl,
      },
    },
    {
      where: "modelslab_base64_to_url_raw_base64",
      url: MODELSLAB_BASE64_TO_URL,
      payload: {
        key: apiKey,
        base64_string: rawBase64,
      },
    },
    {
      where: "modelslab_image_editing_base64_to_url",
      url: "https://modelslab.com/api/v6/image_editing/base64_to_url",
      payload: {
        key: apiKey,
        init_image: fullDataUrl,
      },
    },
  ];

  const errors: any[] = [];

  for (const a of attempts) {
    try {
      const data = await postModelsLabJson(a.url, a.payload, a.where);
      const url = extractUrlCandidates(data)[0];

      if (url) return url;

      errors.push({
        where: a.where,
        message: "Missing uploaded image URL",
        body_json: data,
      });
    } catch (e) {
      errors.push(serializeErr(e));
    }
  }

  throw {
    where: "modelslab_base64_upload_all_failed",
    message: "Could not convert image dataURL to URL for ModelsLab video.",
    imagePrefix: fullDataUrl.slice(0, 80),
    imageLength: fullDataUrl.length,
    errors,
  };
}

function extractUrlCandidates(data: any): string[] {
  const raw = [
    data?.proxy_links,
    data?.output,
    data?.future_links,
    data?.video,
    data?.url,
    data?.fetch_result,
    data?.file,
    data?.result,
  ];

  const out: string[] = [];

  function add(v: any) {
    if (!v) return;

    if (Array.isArray(v)) {
      for (const x of v) add(x);
      return;
    }

    if (typeof v === "object") {
      add(v.url);
      add(v.video);
      add(v.file);
      add(v.output);
      add(v.proxy_links);
      add(v.future_links);
      return;
    }

    if (typeof v === "string" && v.trim()) {
      const s = v.trim();

      if (/^https?:\/\//i.test(s) && !out.includes(s)) {
        out.push(s);
      }
    }
  }

  for (const v of raw) add(v);

  return out;
}

function buildModelsLabVideoPrompt(prompt: string) {
  const p = String(prompt || "").trim();

  return [
    p,
    "adult 18+ subject",
    "consensual adult scene",
    "cinematic realistic motion",
    "natural body movement",
    "smooth camera movement",
    "high detail",
    "no text",
    "no watermark",
  ].filter(Boolean).join(", ");
}

function buildModelsLabVideoNegativePrompt() {
  return [
    "low resolution",
    "worst quality",
    "low quality",
    "defects",
    "blurry",
    "distorted",
    "warped anatomy",
    "bad hands",
    "extra limbs",
    "flicker",
    "jitter",
    "watermark",
    "text",
    "logo",

    // hard safety blocks
    "minor",
    "child",
    "kid",
    "teen",
    "underage",
    "loli",
    "shota",
    "young-looking",
    "baby face",
    "school uniform",
    "forced",
    "non-consensual",
    "rape",
    "gore",
    "dismemberment",
    "public figure",
    "deepfake",
  ].join(", ");
}
