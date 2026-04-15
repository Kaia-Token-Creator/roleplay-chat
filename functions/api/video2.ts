// functions/api/video.ts
// Cloudflare Pages Functions

type QueueBody = {
  action: "queue";
  orderID: string;
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

// ✅ Paste this into functions/api/video.ts (anywhere above onRequestPost)
// It throws on failure; if it returns, payment is verified.

async function verifyPaypalOrder(
  orderID: string,
  duration: "5s" | "10s",
  ctx: any
){
  if (!orderID || typeof orderID !== "string") {
    throw new Error("Missing PayPal orderID");
  }

  const env = (ctx.env || {}) as any;

  // ⚠️ Put these in Cloudflare Pages env vars (never in frontend code)
  const PAYPAL_ENV = (env.PAYPAL_ENV || "sandbox").toLowerCase(); // "sandbox" | "live"
  const PAYPAL_CLIENT_ID = env.PAYPAL_CLIENT_ID;
  const PAYPAL_CLIENT_SECRET = env.PAYPAL_CLIENT_SECRET;
  const PAYPAL_MERCHANT_ID = env.PAYPAL_MERCHANT_ID; // e.g. "B37RU4LAJ9FKA"

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
  // Most common: purchase_units[0].amount
  const pu0 = Array.isArray(order?.purchase_units) ? order.purchase_units[0] : null;

  const amountObj =
    pu0?.amount ||
    // fallback: sometimes amount is inside captures
    pu0?.payments?.captures?.[0]?.amount ||
    null;

  const currency = String(amountObj?.currency_code || "");
  const value = typeof amountObj?.value === "string"
    ? amountObj.value
    : (amountObj?.value != null ? String(amountObj.value) : "");

  // normalize value like "1.5" -> "1.50"
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

  // --- 5) Validate receiver (merchant) ---
  // Common fields:
  // purchase_units[0].payee.merchant_id
  // or capture.payee.merchant_id
  const payeeMerchant =
    pu0?.payee?.merchant_id ||
    pu0?.payments?.captures?.[0]?.payee?.merchant_id ||
    "";

  if (String(payeeMerchant) !== String(PAYPAL_MERCHANT_ID)) {
    throw new Error(
      `Wrong merchant (got=${String(payeeMerchant)}, expected=${String(PAYPAL_MERCHANT_ID)})`
    );
  }

  // ✅ If we reach here, payment is valid for this duration.
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

      await verifyPaypalOrder(b.orderID, duration, ctx);   // ⭐ 여기 추가

      if (!isDataUrl(b.imageDataUrl)) {
        return json({ error: "imageDataUrl must be a data: URL" }, { status: 400, headers: cors(origin) });
      }

      // ✅ 모델은 두 가지 방식 중 하나로:
      // 1) 서버에서 고정
      // 2) 프론트에서 model 넘기면 그걸 사용
      // (원하는 모델을 “찾아 붙여넣기” 했으면, 아래 default를 네 모델로 바꾸면 됨)
      const model = (typeof b.model === "string" && b.model.trim()) || "wan-2-7-image-to-video";

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
        resolution: "480p",
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



