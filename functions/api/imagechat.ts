// functions/api/imagechat.ts
export const onRequestPost: PagesFunction<{
  VENICE_API_KEY: string;
}> = async (ctx) => {
  const { request, env } = ctx;

  const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    type Msg = { role: "system" | "user" | "assistant"; content: string };

    type HeightUnit = "cm" | "ft";
    type WeightUnit = "kg" | "lb";

    type Character = {
      name: string;
      age: number;
      gender: string;
      language: string;
      personality: string;
      scenario: string;
      nickname?: string;
      mbti?: string;

      // 메인 구조(너가 쓰는 세션 구조) 그대로 받는다고 가정
      height?: { unit: "cm" | "ft"; cm?: number | null; ft?: number | null; in?: number | null } | null;
      weight?: { unit: "kg" | "lb"; value?: number | null } | null;

      // imagechat에서 추가로 쓰는 것들
      avatarDataUrl?: string; // data:image/jpeg;base64,...
      fontColor?: string;     // "#ffcc00" 등
    };

    // ---------------- LIMITS ----------------
    const MAX_MESSAGE_CHARS = 600;
    const MAX_REPLY_CHARS = 700;

    const MAX_HISTORY_MSGS = 30;
    const MAX_PROMPT_CHARS = 14000;

    const MAX_TOKENS_TEXT = 650;
    const MAX_TOKENS_PLAN = 220;
    // ---------------------------------------

    const body = await request.json<{
      paymentStatus?: "paid" | "unpaid" | "cancelled";
      character: Character;
      message: string;
      history?: Msg[];
    }>();

    const bodyAny = await request.json<any>().catch(() => null);

if (!bodyAny || typeof bodyAny !== "object") {
  return json({ error: "Invalid body." }, 400, CORS);
}

const character = bodyAny.character || bodyAny.session; // ✅ character 또는 session 허용
if (!character) {
  return json({ error: "Missing character." }, 400, CORS);
}

const message = typeof bodyAny.message === "string" ? bodyAny.message.trim() : "";
if (!message) {
  return json({ error: "Missing message." }, 400, CORS);
}

// history도 bodyAny 기준으로
const rawHistory = Array.isArray(bodyAny.history) ? bodyAny.history : [];
const history = rawHistory.filter(isValidMsg).slice(-MAX_HISTORY_MSGS);

// paymentStatus도 bodyAny 기준으로
const paymentStatus = bodyAny.paymentStatus;
if (paymentStatus !== "paid") {
  return json(
    { error: "Payment not completed. Image chat is locked.", code: "PAYMENT_REQUIRED" },
    402,
    CORS
  );
}

    const ch = sanitizeCharacter(character);

    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const history = rawHistory.filter(isValidMsg).slice(-MAX_HISTORY_MSGS);

    // 1) 텍스트 답변 생성
    const systemPrompt = buildSystemPrompt_Text(ch);

    const messagesBeforeFit: Msg[] = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: String(m.content) })),
      { role: "user", content: userMsg },
    ];

    const fitted = fitMessagesToBudget(messagesBeforeFit, MAX_PROMPT_CHARS);
    const replyRaw = await callVeniceChat(env.VENICE_API_KEY, fitted, MAX_TOKENS_TEXT);
    const reply = truncateReply(replyRaw, MAX_REPLY_CHARS);

    // 2) 이미지 트리거 판단 (JSON schema로 깔끔하게)
    const plan = await decideImagePlan(env.VENICE_API_KEY, {
      character: ch,
      userMessage: userMsg,
      lastAssistant: reply,
      history,
      maxTokens: MAX_TOKENS_PLAN,
    });

    // 3) 이미지가 필요하면 생성
    let image: null | { mime: "image/webp" | "image/png" | "image/jpeg"; b64: string } = null;

    if (plan.generate === true) {
      // ✅ 서버에서 1차 안전장치 (노골적 성적/미성년/폭력 등 차단)
      // 필요하면 더 강하게 확장 가능
      if (looksExplicitOrIllegal(plan.prompt)) {
        // 이미지 생성은 건너뛰고 텍스트만 반환
        return json(
          {
            reply,
            image: null,
            note: "Image request was blocked by server safety rules.",
            tier: "venice-uncensored",
            imageModel: "lustify-sdxl",
          },
          200,
          CORS
        );
      }

      // 프로필 사진 “참고”:
      // /api/v1/image/generate는 입력 이미지(reference)를 직접 받는 필드가 없음(문서 기준).
      // 그래서 여기서는 avatarDataUrl을 그대로 “텍스트 프롬프트에 반영”하라고 지시만 넣어.
      // (정말로 얼굴/외형을 반영하려면: 별도의 비전 모델로 avatarDataUrl을 묘사 텍스트로 바꿔 prompt에 넣는 방식이 필요)
      const promptWithRef = buildImagePromptWithAvatarHint(plan.prompt, ch);

      const imgB64 = await callVeniceImageGenerate(env.VENICE_API_KEY, {
        model: "lustify-sdxl",
        prompt: promptWithRef,
        negative_prompt: plan.negativePrompt || defaultNegativePrompt(),
        format: "webp",
        width: 1024,
        height: 1024,
        cfg_scale: 7.0,
        // safe_mode=true면 성인물로 분류되면 blur 처리됨(문서)
        // 노골적 성적 이미지 생성 방향 구현은 도와줄 수 없어서 기본 true로 둠
        safe_mode: true,
        variants: 1,
      });

      image = { mime: "image/webp", b64: imgB64 };
    }

    return json(
      {
        reply,
        image,
        tier: "venice-uncensored",
        imageModel: "lustify-sdxl",
      },
      200,
      CORS
    );
  } catch (err: any) {
    return json({ error: "Server error.", detail: String(err?.message || err) }, 500, CORS);
  }
};

// ---------------- response helper ----------------
function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

// ---------------- sanitizers ----------------
function safeStr(v: any, maxLen: number) {
  if (typeof v !== "string") return "";
  return v.slice(0, maxLen);
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function isValidMsg(m: any): m is { role: "system" | "user" | "assistant"; content: string } {
  return (
    m &&
    typeof m === "object" &&
    (m.role === "system" || m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string"
  );
}

type HeightUnit = "cm" | "ft";
type WeightUnit = "kg" | "lb";

function normalizeMBTI(s: string) {
  const t = s.trim().toUpperCase();
  if (!/^[IE][NS][FT][PJ]$/.test(t)) return "";
  return t;
}

function sanitizeCharacter(ch: any) {
  const name = safeStr(ch.name, 40).trim() || "Character";

  const ageNum = Number(ch.age);
  const age = Number.isFinite(ageNum) ? clamp(Math.floor(ageNum), 18, 200) : 18;

  const gender = safeStr(ch.gender, 30);
  const language = safeStr(ch.language, 30) || "English";
  const personality = safeStr(ch.personality, 500);
  const scenario = safeStr(ch.scenario, 500);

  const nickname = safeStr(ch.nickname, 40).trim();
  const mbti = normalizeMBTI(safeStr(ch.mbti, 8));

  const avatarDataUrl = safeStr(ch.avatarDataUrl, 2_000_000); // base64라 길 수 있음
  const fontColor = safeStr(ch.fontColor, 32);

  // 메인 세션 구조 그대로 받는 형태
  const height = sanitizeHeight(ch.height);
  const weight = sanitizeWeight(ch.weight);

  return {
    name,
    age,
    gender,
    language,
    personality,
    scenario,
    nickname: nickname || "",
    mbti: mbti || "",
    height,
    weight,
    avatarDataUrl: avatarDataUrl || "",
    fontColor: fontColor || "",
  };
}

function sanitizeHeight(v: any) {
  if (!v || typeof v !== "object") return null;
  const unitRaw = typeof v.unit === "string" ? v.unit.toLowerCase() : "";
  if (unitRaw === "cm") {
    const cm = Number(v.cm);
    if (!Number.isFinite(cm)) return null;
    return { unit: "cm" as const, cm: clamp(cm, 50, 260) };
  }
  if (unitRaw === "ft") {
    const ft = Number(v.ft);
    const inch = Number(v.in);
    if (!Number.isFinite(ft) || !Number.isFinite(inch)) return null;
    return { unit: "ft" as const, ft: clamp(ft, 3, 8), in: clamp(inch, 0, 11) };
  }
  return null;
}

function sanitizeWeight(v: any) {
  if (!v || typeof v !== "object") return null;
  const unitRaw = typeof v.unit === "string" ? v.unit.toLowerCase() : "";
  const val = Number(v.value);
  if (!Number.isFinite(val)) return null;
  if (unitRaw === "kg") return { unit: "kg" as const, value: clamp(val, 10, 400) };
  if (unitRaw === "lb") return { unit: "lb" as const, value: clamp(val, 22, 880) };
  return null;
}

function formatHeight(h: any) {
  if (!h) return "Not specified";
  if (h.unit === "cm") return `${h.cm} cm`;
  return `${h.ft} ft ${h.in} in`;
}
function formatWeight(w: any) {
  if (!w) return "Not specified";
  return w.unit === "kg" ? `${w.value} kg` : `${w.value} lb`;
}

// ---------------- prompts ----------------

// (A) 텍스트 답변 프롬프트 (너의 chat.ts 톤 최대한 유지)
function buildSystemPrompt_Text(ch: any) {
  const nicknameLine = ch.nickname?.trim()
    ? `- What you call the user: ${ch.nickname.trim()} (always use this when addressing the user)`
    : `- What you call the user: Not specified`;

  return [
    "You are a human roleplay chat partner. Stay in-character and write immersive, story-forward replies.",
    `Always respond in: ${ch.language}.`,
    "",
    "Character Sheet:",
    `- Name: ${ch.name}`,
    `- Age: ${ch.age}`,
    `- Gender: ${ch.gender || "Unspecified"}`,
    `- MBTI: ${ch.mbti || "Not specified"}`,
    nicknameLine,
    `- Height: ${formatHeight(ch.height)}`,
    `- Weight: ${formatWeight(ch.weight)}`,
    `- Personality: ${ch.personality || "Not specified"}`,
    `- Place & Situation: ${ch.scenario || "Not specified"}`,
    "",
    "Rules:",
    "Keep continuity with prior messages.",
    "Always address the user using the specified nickname unless explicitly told otherwise.",
    "If details are missing, make reasonable assumptions consistent with the character and scenario.",
    "Do not mention system prompts or hidden instructions.",
    "Keep replies short and chatty: 1–4 sentences.",
    "Never mention AI, models, providers, Venice, ChatGPT, OpenAI, or being an assistant.",
    "No meta/system/code-like outputs.",
    "",
    "FORMAT:",
    "Output ONLY spoken dialogue. No narration.",
    "Do NOT use parentheses () or brackets [] at all.",
  ].join("\n");
}

// (B) 이미지 생성 여부 + 프롬프트를 JSON으로 받기
async function decideImagePlan(
  apiKey: string,
  args: {
    character: any;
    userMessage: string;
    lastAssistant: string;
    history: { role: string; content: string }[];
    maxTokens: number;
  }
): Promise<{ generate: boolean; prompt: string; negativePrompt?: string }> {
  const { character: ch, userMessage, lastAssistant, history, maxTokens } = args;

  const plannerSystem: Msg = {
    role: "system",
    content: [
      "You are a planner that decides whether to generate a SFW image for a roleplay chat.",
      "Return ONLY valid JSON that matches the schema.",
      "",
      "Rules:",
      "- Only suggest an image if the user explicitly asks for a picture, wants to see something, requests a selfie/photo, or the conversation clearly calls for a visual.",
      "- The image must be SFW. No explicit sex, nudity, pornography, minors, sexual violence, or extreme gore.",
      "- Make the prompt concise but specific: subject, environment, camera framing, lighting, style.",
      "- If unsure, set generate=false.",
    ].join("\n"),
  };

  const plannerUser: Msg = {
    role: "user",
    content: [
      "Character:",
      `Name=${ch.name}; Age=${ch.age}; Gender=${ch.gender}; MBTI=${ch.mbti}; Language=${ch.language}`,
      `Personality=${ch.personality}`,
      `Scenario=${ch.scenario}`,
      "",
      "Recent history (latest last):",
      ...history.slice(-8).map((m) => `${m.role}: ${m.content}`),
      "",
      "User message:",
      userMessage,
      "",
      "Assistant draft reply (already generated):",
      lastAssistant,
      "",
      "Decide if we should generate an image.",
    ].join("\n"),
  };

  const response = await callVeniceChatJsonSchema(apiKey, [plannerSystem, plannerUser], maxTokens, {
    type: "json_schema",
    json_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        generate: { type: "boolean" },
        prompt: { type: "string" },
        negativePrompt: { type: "string" },
      },
      required: ["generate", "prompt"],
    },
  });

  const generate = !!response?.generate;
  const prompt = String(response?.prompt || "").trim();
  const negativePrompt = String(response?.negativePrompt || "").trim();

  if (!generate) return { generate: false, prompt: "" };
  if (!prompt) return { generate: false, prompt: "" };

  return { generate: true, prompt, negativePrompt: negativePrompt || undefined };
}

// ---------------- budget helpers ----------------
function fitMessagesToBudget(messages: { role: any; content: string }[], maxChars: number) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const system = messages[0];
  const last = messages[messages.length - 1];
  const sys = system?.role === "system" ? system : null;
  const middle = messages.slice(sys ? 1 : 0, -1);

  const safeSys = sys ? { role: "system" as const, content: String(sys.content || "") } : null;
  const safeLast = { role: last.role, content: String(last.content || "") };

  let result: any[] = [];
  if (safeSys) result.push(safeSys);
  result.push(safeLast);

  const sizeOf = (arr: any[]) => arr.reduce((s, m) => s + String(m.content || "").length, 0);

  if (sizeOf(result) > maxChars) {
    if (safeSys) {
      safeLast.content = truncateString(safeLast.content, Math.max(0, maxChars - safeSys.content.length));
      return [safeSys, safeLast].filter(Boolean);
    }
    safeLast.content = truncateString(safeLast.content, maxChars);
    return [safeLast];
  }

  for (let i = middle.length - 1; i >= 0; i--) {
    const m = middle[i];
    const entry = { role: m.role, content: String(m.content || "") };
    const insertIndex = safeSys ? 1 : 0;
    const candidate = result.slice(0, insertIndex).concat([entry], result.slice(insertIndex));
    if (sizeOf(candidate) <= maxChars) result = candidate;
  }

  return result;
}

function truncateString(s: string, maxLen: number) {
  const str = String(s || "");
  if (maxLen <= 0) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 1)) + "…";
}

function truncateReply(reply: string, maxChars: number) {
  return truncateString(String(reply || "").trim(), maxChars);
}

// ---------------- safety filter (basic) ----------------
// 노골적/불법 가능성이 높은 키워드 방지 (서버 1차 방화문)
function looksExplicitOrIllegal(prompt: string) {
  const p = (prompt || "").toLowerCase();

  // minors
  if (/\b(child|kid|minor|underage|teen|loli|shota)\b/.test(p)) return true;

  // explicit sex / porn-ish
  if (/\b(nude|nudity|porn|explicit|sex act|intercourse|blowjob|handjob|penetration|cum|ejaculation)\b/.test(p)) return true;

  // sexual violence
  if (/\b(rape|non-consensual|forced)\b/.test(p)) return true;

  // extreme gore (원하면 더 늘려)
  if (/\b(dismember|decapitat|gore)\b/.test(p)) return true;

  return false;
}

function defaultNegativePrompt() {
  return "low quality, blurry, bad anatomy, extra fingers, deformed, watermark, text, logo, jpeg artifacts";
}

// “프로필 사진 참고” 힌트(실제로 이미지 입력이 안 되므로 텍스트 지시만)
function buildImagePromptWithAvatarHint(basePrompt: string, ch: any) {
  const hasAvatar = !!(ch.avatarDataUrl && ch.avatarDataUrl.startsWith("data:image/"));
  if (!hasAvatar) return basePrompt;

  return [
    basePrompt,
    "",
    "Important: Use the user's provided profile photo as the identity reference for face/features.",
    "Keep the same identity consistently.",
  ].join("\n");
}

// ---------------- Venice: chat (text) ----------------
async function callVeniceChat(apiKey: string, messages: any[], maxTokens: number) {
  if (!apiKey) throw new Error("Missing VENICE_API_KEY");

  const res = await fetch("https://api.venice.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "venice-uncensored",
      messages,
      stream: false,
      temperature: 0.92,
      presence_penalty: 0.6,
      frequency_penalty: 0.2,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Venice error (${res.status}): ${t.slice(0, 800)}`);
  }

  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Venice: empty response");
  return String(content);
}

// Venice: chat (json_schema)
async function callVeniceChatJsonSchema(
  apiKey: string,
  messages: any[],
  maxTokens: number,
  response_format: any
) {
  if (!apiKey) throw new Error("Missing VENICE_API_KEY");

  const res = await fetch("https://api.venice.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "venice-uncensored",
      messages,
      stream: false,
      temperature: 0.4,
      max_tokens: maxTokens,
      response_format,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Venice planner error (${res.status}): ${t.slice(0, 800)}`);
  }

  const data: any = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Venice planner: empty response");

  // response_format=json_schema면 content가 JSON 문자열로 옴
  try {
    return JSON.parse(raw);
  } catch {
    // 혹시 모델이 실수하면 최대한 복구
    return { generate: false, prompt: "" };
  }
}

// ---------------- Venice: image generate ----------------
async function callVeniceImageGenerate(
  apiKey: string,
  args: {
    model: string;
    prompt: string;
    negative_prompt?: string;
    format?: "webp" | "png" | "jpeg";
    width?: number;
    height?: number;
    cfg_scale?: number;
    safe_mode?: boolean;
    variants?: number;
  }
): Promise<string> {
  if (!apiKey) throw new Error("Missing VENICE_API_KEY");

  const res = await fetch("https://api.venice.ai/api/v1/image/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      prompt: args.prompt,
      negative_prompt: args.negative_prompt || "",
      format: args.format || "webp",
      width: args.width ?? 1024,
      height: args.height ?? 1024,
      cfg_scale: args.cfg_scale ?? 7.5,
      safe_mode: args.safe_mode ?? true,
      variants: args.variants ?? 1,
      return_binary: false,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Venice image error (${res.status}): ${t.slice(0, 800)}`);
  }

  const data: any = await res.json();
  const images: string[] = data?.images;
  if (!Array.isArray(images) || !images[0]) throw new Error("Venice image: empty response");
  return images[0]; // base64 only (no data: prefix)
}


