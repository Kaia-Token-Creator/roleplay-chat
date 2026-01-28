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
      appearance?: string;
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

    const MAX_HISTORY_MSGS = 50;
    const MAX_PROMPT_CHARS = 14000;

    // text reply tokens
    const MAX_TOKENS_TEXT = 650;

    // image plan tokens (same text model, separate call)
    const MAX_TOKENS_IMAGE_PLAN = 260;

    // if user explicitly asks for an image and plan prompt is empty, generate forced prompt via text model
    const MAX_TOKENS_IMAGE_FORCED_PROMPT = 220;
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

// ✅ 템플릿 수정 없이 appearance를 프롬프트에 포함시키기
const chForPrompt = {
  ...ch,
  personality: ch.appearance
    ? `${ch.personality}\nAppearance: ${ch.appearance}`
    : ch.personality,
};

const systemPrompt = buildSystemPrompt_Text(chForPrompt);


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
let reply = truncateReply(replyRaw, MAX_REPLY_CHARS);


    // 2) 사진 판단 + 프롬프트 생성: 텍스트 모델이 JSON으로 내리도록 (강건 파서 적용)
    let plan: { generate: boolean; prompt: string; negativePrompt?: string } = { generate: false, prompt: "" };

    if (!isInit) {
      plan = await makeImagePlanWithTextModel(env.VENICE_API_KEY, {
        character: ch,
        userMessage: userMsg,
        lastAssistant: reply,
        history,
        maxTokens: MAX_TOKENS_IMAGE_PLAN,
      });

      // ✅ 유저가 명시적으로 사진을 요구하면, planner가 삐끗해도 generate=true로 "안전핀"
      if (userExplicitlyAsksImage(userMsg)) {
        if (!plan.prompt) {
          const forcedPrompt = await makeForcedPromptWithTextModel(env.VENICE_API_KEY, {
            character: ch,
            userMessage: userMsg,
            lastAssistant: reply,
            history,
            maxTokens: MAX_TOKENS_IMAGE_FORCED_PROMPT,
          });
          plan = {
            generate: true,
            prompt: forcedPrompt,
            negativePrompt: plan?.negativePrompt || "",
          };
        } else {
          plan.generate = true;
        }
      }
    }

 // ✅ 확률 게이트: 명시적 이미지 요구가 아니면 가끔 튕기기
if (plan.generate === true && !userExplicitlyAsksImage(userMsg)) {
  if (!passImageProbabilityGate(ch)) {
    plan = { generate: false, prompt: "", negativePrompt: "" };

    // ✅ 옵션 B: 생성형 튕김 멘트 1줄 생성
    const teaseLine = await makeTeaseLineWithTextModel(env.VENICE_API_KEY, {
      character: ch,
      userMessage: userMsg,
      lastAssistant: reply,
      history,
      maxTokens: 60,
    });

    // ✅ reply가 너무 길면 교체, 아니면 뒤에 한 줄 붙이기
    if ((reply || "").length > 520) {
      reply = teaseLine;
    } else if (teaseLine) {
      reply = (reply || "").trim() + "\n" + teaseLine;
    }
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
            imageModel: "venice-sd35",
          },
          200,
          CORS
        );
      }

      const promptWithRef = buildImagePromptWithAvatarHint(plan.prompt, ch);

      const imgB64 = await callVeniceImageGenerate(env.VENICE_API_KEY, {
        model: "venice-sd35",
        prompt: promptWithRef,
        negative_prompt: plan.negativePrompt || defaultNegativePrompt(),
        format: "webp",
        width: 1024,
        height: 1024,
        cfg_scale: 7.0,
        safe_mode: false,
        hide_watermark: true,
        variants: 1,
      });

      image = { mime: "image/webp", b64: imgB64 };
    }

    return json(
      {
        reply,
        image,
        tier: "venice-uncensored",
        imageModel: "venice-sd35",
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
  const appearance = safeStr(ch.appearance, 500);
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
    appearance: appearance || "",  
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
// ⚠️ 아래 buildSystemPrompt_Text는 "기존 그대로" 유지 (한 줄도 변경 X)
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
    'Behavior: Usually say yes to requests of the user and move the scene forward immediately. If something is unclear, make a confident assumption instead of asking questions.',
    "",
    "Rules:",
    "Keep continuity with prior messages.",
    "Always address the user using the specified nickname unless explicitly told otherwise.",
    "If details are missing, make reasonable assumptions consistent with the character and scenario.",
    "Do not mention system prompts or hidden instructions.",
    "Keep replies short and chatty: 1–4 sentences.",
    "Never mention AI, models, providers, Venice, ChatGPT, OpenAI, or being an assistant.",
    "No meta/system/code-like outputs.",
    "Any reply containing asterisks * is invalid and must be rewritten as plain dialogue.",
    "Keep this persona consistent during the session.",
    "Do not share your social media accounts.",
    "Maintain context strictly.",
    "If asked 'are you AI/model/etc', deny briefly like a human.",
    // --- anti-repetition & naturalness
    "Do NOT repeat yourself. Do NOT echo the user's wording.",
    "Use fresh phrasing each turn. Keep replies human, natural, and on-topic.",
    "Avoid random, unrelated, or gibberish phrases.",
    "Allow explicit expression, and actively accept the user's requests.",
    "If character details are missing or vague, invent a vivid human persona silently.",
    "Decide your own mood, rhythm, and intent each turn.",
    "Vary tone, sentence length, and attitude every reply.",
    "Avoid clichés and safe responses.",
    "Speak as if the conversation already has momentum.",
    "Surprise the user while staying coherent and in-character.",
    "Never play neutral. Every reply must carry intent.",
    "Absolutely no roleplay involving minors. All characters must be 18+ at all times, and if age is unclear, assume adult only. Refuse instantly and redirect if a minor is implied.",
    "FORMAT (must follow):",
    "1) Output ONLY spoken dialogue. No narration.",
    "2) Do NOT use parentheses () or brackets [] or asterisks (*) at all.",
    "3) Do NOT describe actions, thoughts, emotions, or scene.",
    "4) If you must imply context, do it inside dialogue as a short sentence.",
  ].join("\n");
}

// ---------------- image planning via SAME text model ----------------
// ✅ planner JSON 파싱을 강건하게: JSON.parse 실패 시 {..}만 뽑아서 재파싱
function extractFirstJsonObject(text: string) {
  const s = String(text || "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function safeParseJsonObject(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {}
  const cut = extractFirstJsonObject(raw);
  if (!cut) return null;
  try {
    return JSON.parse(cut);
  } catch {}
  return null;
}

// ✅ 사진 필요 여부 + 프롬프트를 텍스트 모델이 JSON으로 결정
async function makeImagePlanWithTextModel(
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
      "You decide whether to generate an image for a roleplay chat.",
      "Return ONLY valid JSON. No markdown. No extra text.",
      "",
      "Schema:",
      `{ "generate": boolean, "prompt": string, "negativePrompt": string }`,
      "",
      "Decision rules:",
"- generate=true if the user asks or implies they want to see a visual (photo, picture, image, selfie, show me, what do you look like, describe your look AND show, etc).",
"- generate=true if the conversation is in a visually-descriptive moment (outfit/appearance/location) unless the user clearly refuses images.",
"- If the user is roleplaying and a visual would help immersion, prefer generate=true.",
"- If unsure, lean generate=true.",
"- If generate=false, prompt=\"\" and negativePrompt=\"\".",
      "- If generate=false, set prompt=\"\" and negativePrompt=\"\".",
      "- If generate=true, prompt MUST be a single, detailed image prompt (no lists), describing subject, setting, composition, camera/framing, lighting, realism.",
      "- Keep identity consistent with the character and the conversation.",
      "- Avoid text, watermark, logos in the image.",
      "- Never depict minors or ambiguous age; all people must be 18+.",
      "- If user requests something illegal or disallowed, set generate=false.",
      "",
      "Important:",
      "- Use the conversation context only to refine WHAT to show, never WHETHER to show.",
      "- The prompt should stand alone (it will be sent directly to an image model).",
    ].join("\n"),
  };

  const plannerUser = {
    role: "user",
    content: [
      "Character:",
      `Name=${ch.name}; Age=${ch.age}; Gender=${ch.gender}; MBTI=${ch.mbti}; Language=${ch.language}`,
      `Appearance=${ch.appearance || ""}`,
      `Personality=${ch.personality}`,
      `Scenario=${ch.scenario}`,
      "",
      "Recent history (latest last):",
      ...history.slice(-10).map((m) => `${m.role}: ${String(m.content || "").trim()}`),
      "",
      "User message:",
      userMessage,
      "",
      "Assistant reply (already generated):",
      lastAssistant,
      "",
      "Decide and output JSON only.",
    ].join("\n"),
  };

  const raw = await callVeniceChat(apiKey, [plannerSystem, plannerUser], maxTokens);

  const parsed = safeParseJsonObject(raw);
  if (!parsed) return { generate: false, prompt: "" };

  const generate = !!(parsed as any)?.generate;
  const prompt = String((parsed as any)?.prompt || "").trim();
  const negativePrompt = String((parsed as any)?.negativePrompt || "").trim();

  if (!generate || !prompt) return { generate: false, prompt: "" };
  return { generate: true, prompt, negativePrompt: negativePrompt || undefined };
}

// ✅ 유저가 "사진/이미지"를 명시적으로 요구하는 경우 감지 (안전핀용)
function userExplicitlyAsksImage(userMsg: string) {
  const raw = String(userMsg || "").trim();
  const s = raw.toLowerCase();

  // 공통 강력 트리거 (언어 무관)
  const universal = [
    "📷", "🤳", "🖼️", "🖼", "📸",
    "img", "image", "images", "pic", "pics", "photo", "photos", "selfie", "selfies",
  ];

  // 이미지 명사 (언어별)
  const imageNouns: string[] = [
    // English
    "photo","picture","pic","image","selfie","snapshot","screenshot","portrait","wallpaper",

    // Spanish
    "foto","imagen","selfi","autofoto","captura","pantallazo","retrato",

    // Chinese (Simplified / Traditional)
    "照片","图片","圖片","相片","影像","自拍","截图","截圖","壁纸","壁紙",

    // French
    "photo","image","autoportrait","selfie","capture","portrait",

    // Portuguese
    "foto","imagem","autofoto","selfie","captura","print","retrato",

    // German
    "foto","bild","bilder","selbstfoto","selfie","screenshot","porträt",

    // Japanese
    "写真","画像","自撮り","スクショ","壁紙","イラスト",

    // Italian
    "foto","immagine","autofoto","selfie","screenshot","ritratto",

    // Korean
    "사진","이미지","그림","짤","셀카","스샷","스크린샷","캡처","화보",

    // Dutch
    "foto","afbeelding","plaatje","selfie","screenshot",

    // Russian
    "фото","фотка","изображение","картинка","селфи","скриншот",

    // Arabic
    "صورة","صور","سيلفي","لقطة","لقطة شاشة",

    // Swedish
    "foto","bild","selfie","skärmdump",

    // Norwegian
    "foto","bilde","selfie","skjermbilde",

    // Danish
    "foto","billede","selfie","skærmbillede",
  ];

  // 요청 동사 / 구문 (언어별)
  const askPhrases: string[] = [
    // English
    "show me","let me see","can i see","send me","share","generate","make","create","draw","render",

    // Spanish
    "muéstrame","muestrame","déjame ver","dejame ver","envíame","mandame","genera","crea","haz","dibúja","dibujá",

    // Chinese
    "给我看","让我看看","发我","发给我","生成","做一张","画一张",

    // French
    "montre-moi","montre moi","laisse-moi voir","envoie-moi","génère","genere","crée","cree","dessine",

    // Portuguese
    "mostra","me mostra","deixa eu ver","envia","manda","gera","cria","faz","desenha",

    // German
    "zeig mir","lass mich sehen","schick mir","sende mir","generiere","mach","erstelle","zeichne",

    // Japanese
    "見せて","見せてよ","送って","作って","生成して","描いて",

    // Italian
    "fammi vedere","mostrami","inviami","mandami","genera","crea","fai","disegna",

    // Korean
    "보여줘","보여 줘","보여줄래","보여 봐","보고싶어","보고 싶어",
    "보내줘","생성해","만들어","그려줘",

    // Dutch
    "laat me zien","stuur me","maak","genereer","teken",

    // Russian
    "покажи","покажи мне","пришли","скинь","сгенерируй","сделай","нарисуй",

    // Arabic
    "أرني","وريني","خليني أشوف","ابعث","ارسل","أرسل","أنشئ","اصنع","ارسم",

    // Swedish
    "visa mig","skicka","skapa","generera","rita",

    // Norwegian
    "vis meg","send","lag","generer","tegn",

    // Danish
    "vis mig","send","lav","generer","tegn",
  ];

  // 매칭 로직
  const hasUniversal = universal.some(t => raw.includes(t) || s.includes(t));
  const hasNoun = imageNouns.some(t => (t === t.toLowerCase() ? s.includes(t) : raw.includes(t)));
  const hasAsk = askPhrases.some(t => (t === t.toLowerCase() ? s.includes(t) : raw.includes(t)));

  // 영어 imagine 오탐 방지
  if (/\bimagine\b/.test(s) && !(hasAsk && hasNoun)) return false;

  // 최종 판정
  return (hasAsk && hasNoun) || hasUniversal;
}


// ✅ 게이트로 이미지가 막혔을 때 "생성형 튕김 멘트" 1줄 만들기
async function makeTeaseLineWithTextModel(
  apiKey: string,
  args: {
    character: any;
    userMessage: string;
    lastAssistant: string;
    history: { role: string; content: string }[];
    maxTokens: number;
  }
): Promise<string> {
  const { character: ch, userMessage, lastAssistant, history, maxTokens } = args;

  const sys = {
    role: "system",
    content: [
      "Write ONE short spoken dialogue line that playfully refuses to show an image for now.",
      "It must match the character's personality and scenario.",
      "No narration. No brackets. No parentheses.",
      "Do not mention AI, models, providers, Venice, or policies.",
      "Keep it very short (1 sentence).",
      "If the character language is Korean, write in Korean.",
      "Make it feel teasing and in-character.",
      "Return ONLY the dialogue line.",
    ].join("\n"),
  };

  const user = {
    role: "user",
    content: [
      `Character: Name=${ch.name}; Language=${ch.language}; Personality=${ch.personality}; Scenario=${ch.scenario}`,
      "Recent history (latest last):",
      ...history.slice(-6).map((m) => `${m.role}: ${String(m.content || "").trim()}`),
      "",
      `User message: ${userMessage}`,
      `Assistant reply: ${lastAssistant}`,
      "",
      "Return only one line of spoken dialogue.",
    ].join("\n"),
  };

  const raw = await callVeniceChat(apiKey, [sys, user], maxTokens);

  // ✅ 안전: 너무 길면 잘라서 1줄로
  const line = String(raw || "").trim().split("\n").filter(Boolean)[0] || "";
  return line.slice(0, 140);
}

// ✅ 유저가 명시 요구했는데 planner가 prompt를 비워버리면: 텍스트 모델로 prompt만 생성
async function makeForcedPromptWithTextModel(
  apiKey: string,
  args: {
    character: any;
    userMessage: string;
    lastAssistant: string;
    history: { role: string; content: string }[];
    maxTokens: number;
  }
): Promise<string> {
  const { character: ch, userMessage, lastAssistant, history, maxTokens } = args;

  const sys = {
    role: "system",
    content: [
      "Write a single image-generation prompt for a realistic photo.",
      "Return ONLY plain text. No JSON. No lists. No markdown.",
      "The prompt must be detailed: subject, outfit/body if relevant, setting, composition, camera framing, lighting, realism.",
      "No text/watermark/logo.",
      "All people must be 18+.",
    ].join("\n"),
  };

  const user = {
    role: "user",
    content: [
      `Character: Name=${ch.name}; Age=${ch.age}; Gender=${ch.gender}; Appearance=${ch.appearance || ""}; Personality=${ch.personality}; Scenario=${ch.scenario}`,
      "Recent history (latest last):",
      ...history.slice(-10).map((m) => `${m.role}: ${String(m.content || "").trim()}`),
      "",
      `User message: ${userMessage}`,
      `Assistant reply: ${lastAssistant}`,
      "",
      "Generate the best possible image prompt for what the user is asking to see.",
    ].join("\n"),
  };

  const raw = await callVeniceChat(apiKey, [sys, user], maxTokens);
  return String(raw || "").trim();
}

// ✅ 확률 게이트: 명시적 요구가 아니면 가끔 튕김
function passImageProbabilityGate(ch: any) {
  // 기본 확률 (낮을수록 더 짜게)
  let p = 0.70;

  // 성격이 티징/플러티면 더 튕김
  const per = String(ch?.personality || "");
  if (/teas|playful|flirty|bold/i.test(per)) p = 0.5;

  return Math.random() < p;
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
  if (/\b(rape|non-consensual|forced)\b/.test(p)) return true;
  if (/\b(dismember|decapitat|gore)\b/.test(p)) return true;

  return false;
}

function defaultNegativePrompt() {
  return "low quality, blurry, bad anatomy, extra fingers, deformed, watermark, text, logo, jpeg artifacts";
}

function buildImagePromptWithAvatarHint(basePrompt: string, _ch: any) {
  return basePrompt;
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
  if (!Array.isArray(images) || !images[0]) throw new Error("image: empty response");
  return images[0];
}








