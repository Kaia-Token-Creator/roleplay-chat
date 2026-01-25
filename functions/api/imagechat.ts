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

    type Character = {
      name: string;
      age: number;
      gender: string;
      language: string;
      personality: string;
      scenario: string;
      nickname?: string;
      mbti?: string;

      height?: { unit: "cm" | "ft"; cm?: number | null; ft?: number | null; in?: number | null } | null;
      weight?: { unit: "kg" | "lb"; value?: number | null } | null;

      avatarDataUrl?: string;
      fontColor?: string;
    };

    // ---------------- LIMITS ----------------
    const MAX_MESSAGE_CHARS = 600;
    const MAX_REPLY_CHARS = 700;

    const MAX_HISTORY_MSGS = 30;
    const MAX_PROMPT_CHARS = 14000;

    const MAX_TOKENS_TEXT = 650;
    const MAX_TOKENS_PLAN = 220;
    // ---------------------------------------

    // ✅ body는 딱 1번만 읽어야 함
    const bodyAny = await request.json<any>().catch(() => null);
    if (!bodyAny || typeof bodyAny !== "object") {
      return json({ error: "Invalid body." }, 400, CORS);
    }

    // ✅ character 또는 session 둘 다 허용
    const characterRaw = bodyAny.character || bodyAny.session;
    if (!characterRaw) {
      return json({ error: "Missing character/session." }, 400, CORS);
    }

    const message = typeof bodyAny.message === "string" ? bodyAny.message.trim() : "";

// ✅ init 트리거
const isInit = message === "__INIT__";

// ✅ 일반 채팅만 message 필수
if (!isInit && !message) {
  return json({ error: "Missing message." }, 400, CORS);
}

const userMsg = isInit ? "" : truncateString(message, MAX_MESSAGE_CHARS);


    // history
    const rawHistory = Array.isArray(bodyAny.history) ? bodyAny.history : [];
    const history: Msg[] = rawHistory.filter(isValidMsg).slice(-MAX_HISTORY_MSGS);

    // paymentStatus
    const paymentStatus = bodyAny.paymentStatus;
    if (paymentStatus !== "paid") {
      return json(
        { error: "Payment not completed. Image chat is locked.", code: "PAYMENT_REQUIRED" },
        402,
        CORS
      );
    }

    const ch = sanitizeCharacter(characterRaw);

    // 1) 텍스트 답변 생성
    const systemPrompt = buildSystemPrompt_Text(ch);

    const initUserMsg =
  "Generate the first assistant message to start this roleplay. " +
  "Use the Character Sheet (personality, scenario, nickname, language) to decide how to open. " +
  "Do NOT write a generic greeting unless it naturally fits the scenario. " +
  "Begin in the middle of the moment with immediate context or tension appropriate to the character. " +
  "If you need to convey setting, do it through natural spoken words, not narration." +
  "Ask at most one short question only if it helps the scene move forward. " +
  "Follow the FORMAT rules exactly: spoken dialogue only, no narration, no parentheses or brackets.";


const messagesBeforeFit: Msg[] = [
  { role: "system", content: systemPrompt },
  ...history.map((m) => ({ role: m.role, content: String(m.content) })),
  { role: "user", content: isInit ? initUserMsg : userMsg },
];


    const fitted = fitMessagesToBudget(messagesBeforeFit, MAX_PROMPT_CHARS);

    const replyRaw = await callVeniceChat(env.VENICE_API_KEY, fitted, MAX_TOKENS_TEXT);
    const reply = truncateReply(replyRaw, MAX_REPLY_CHARS);

    // 2) 이미지 트리거 판단 (✅ JSON 강제 파싱)
    let plan: { generate: boolean; prompt: string; negativePrompt?: string } = { generate: false, prompt: "" };

if (!isInit) {
  plan = await decideImagePlan(env.VENICE_API_KEY, {
    character: ch,
    userMessage: userMsg,
    lastAssistant: reply,
    history,
    maxTokens: MAX_TOKENS_PLAN,
  });

  if (wantsImage(userMsg)) {
    plan = {
      generate: true,
      prompt: buildForcedImagePrompt(ch, userMsg),
      negativePrompt: plan?.negativePrompt || "",
    };
  }
}

    // 3) 이미지 생성
    let image: null | { mime: "image/webp" | "image/png" | "image/jpeg"; b64: string } = null;

    if (plan.generate === true) {
      if (looksExplicitOrIllegal(plan.prompt)) {
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

      const promptWithRef = buildImagePromptWithAvatarHint(plan.prompt, ch);

      const imgB64 = await callVeniceImageGenerate(env.VENICE_API_KEY, {
        model: "lustify-sdxl",
        prompt: promptWithRef,
        negative_prompt: plan.negativePrompt || defaultNegativePrompt(),
        format: "webp",
        width: 1024,
        height: 1024,
        cfg_scale: 7.0,
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
    // ✅ 디버깅 위해 detail은 최대한 살려서 내려줌
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

// ---------------- validators/sanitizers ----------------
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

  const avatarDataUrl = safeStr(ch.avatarDataUrl, 2_000_000);
  const fontColor = safeStr(ch.fontColor, 32);

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

// ✅ response_format 없이 JSON만 뽑기
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

  const plannerSystem = {
    role: "system",
    content: [
      "You are a planner that decides whether to generate a SFW image for a roleplay chat.",
      "Return ONLY valid JSON. No markdown, no extra text.",
      "",
      "Schema:",
      `{ "generate": boolean, "prompt": string, "negativePrompt": string }`,
      "",
      "Rules:",
      "- Only suggest an image if the user explicitly asks for a picture, wants to see something, requests a selfie/photo, or the conversation clearly calls for a visual.",
      "- The image must be SFW. No explicit sex, nudity, pornography, minors, sexual violence, or extreme gore.",
      "- If unsure, set generate=false and prompt=\"\".",
    ].join("\n"),
  };

  const plannerUser = {
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
      "Decide if we should generate an image and output JSON only.",
    ].join("\n"),
  };

  const raw = await callVeniceChat(apiKey, [plannerSystem, plannerUser], maxTokens);

  try {
    const parsed = JSON.parse(raw);
    const generate = !!parsed?.generate;
    const prompt = String(parsed?.prompt || "").trim();
    const negativePrompt = String(parsed?.negativePrompt || "").trim();
    if (!generate || !prompt) return { generate: false, prompt: "" };
    return { generate: true, prompt, negativePrompt: negativePrompt || undefined };
  } catch {
    return { generate: false, prompt: "" };
  }
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
function looksExplicitOrIllegal(prompt: string) {
  const p = (prompt || "").toLowerCase();

  if (/\b(child|kid|minor|underage|teen|loli|shota)\b/.test(p)) return true;
  if (/\b(nude|nudity|porn|explicit|sex act|intercourse|blowjob|handjob|penetration|cum|ejaculation)\b/.test(p)) return true;
  if (/\b(rape|non-consensual|forced)\b/.test(p)) return true;
  if (/\b(dismember|decapitat|gore)\b/.test(p)) return true;

  return false;
}

function defaultNegativePrompt() {
  return "low quality, blurry, bad anatomy, extra fingers, deformed, watermark, text, logo, jpeg artifacts";
}

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

// ✅ 사진 요청 감지
function wantsImage(userMsg: string) {
  const s = (userMsg || "").toLowerCase();

  const hit =
    /\b(selfie|photo|picture|pic|image|portrait|snapshot)\b/.test(s) ||
    /\b(show me|can i see|let me see|send me)\b/.test(s);

  // 흔한 오타도 잡기
  const typo = /\b(a\s*pic|apic|picutre|pictur|piture)\b/.test(s);

  return hit || typo;
}

// ✅ 사진 요청이면 이 프롬프트로 바로 생성
function buildForcedImagePrompt(ch: any, userMsg: string) {
  // "selfie" 류면 셀카 느낌
  const wantsSelfie = /\b(selfie|front camera|self\s*shot)\b/.test((userMsg || "").toLowerCase());

  const base = [
    wantsSelfie ? `A selfie-style portrait of ${ch.name}.` : `A portrait photo of ${ch.name}.`,
    `Age ${ch.age}, ${ch.gender || "unspecified gender"}.`,
    `Scene: ${ch.scenario || "neutral simple background"}.`,
    `Mood: friendly, natural, candid.`,
    wantsSelfie
      ? `Camera: front-facing camera selfie, head-and-shoulders framing, eye contact.`
      : `Camera: portrait framing, head-and-shoulders, eye contact.`,
    `Lighting: soft natural light, sharp focus, high quality.`,
    `Style: realistic photo, no text, no watermark.`,
  ].join(" ");

  return base;
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
  return images[0];
}


