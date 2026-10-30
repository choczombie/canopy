/**
 * Canopy Legal — Cloudflare Worker Edge Server
 * ============================================
 * Serves the Canopy SPA static assets (ASSETS), pre-compiled legislation & caselaw
 * bundles, FTS5 search & Lawpart lookups (DB_REF), and live multi-tier practitioner
 * annotations with bidirectional cross-citation indexing (DB_ANNOTATIONS).
 *
 * Authentication:
 * - Publicly readable for all GET routes and static assets.
 * - Write routes (POST/PUT/DELETE /api/commentary*) require an authenticated
 *   Cloudflare Access user (tracked via Cf-Access-Jwt-Assertion `sub` & `email`).
 */

// --- CITATION LEXER (Ported 1:1 from src/citation_lexer.py) ---

const ACRONYM_MAP = {
  RTA: { slug: "road-transport-act-2013", title: "Road Transport Act 2013", pref_type: "act", jurisdiction: "nsw" },
  RR: { slug: "road-rules-2014", title: "Road Rules 2014", pref_type: "regulation", jurisdiction: "nsw" },
  DL: { slug: "road-transport-driver-licensing-regulation-2017", title: "Road Transport (Driver Licensing) Regulation 2017", pref_type: "regulation", jurisdiction: "nsw" },
  HVNL: { slug: "heavy-vehicle-national-law", title: "Heavy Vehicle National Law", pref_type: "act", jurisdiction: "national" },
  ACL: { slug: "australian-consumer-law", title: "Australian Consumer Law", pref_type: "schedule", jurisdiction: "cth" },
  CCA: { slug: "competition-and-consumer-act-2010", title: "Competition and Consumer Act 2010", pref_type: "act", jurisdiction: "cth" }
};

const KNOWN_INSTRUMENTS = [
  ["Road Transport Act 2013", "road-transport-act-2013", "act", /\bRoad\s+Transport\s+Act(?:\s+2013)?\b/gi],
  ["Road Rules 2014", "road-rules-2014", "regulation", /\bRoad\s+Rules(?:\s+2014)?\b/gi],
  ["Road Transport (Driver Licensing) Regulation 2017", "road-transport-driver-licensing-regulation-2017", "regulation", /\b(?:Road\s+Transport\s+)?\(?Driver\s+Licensing\)?\s+Reg(?:ulation)?(?:\s+2017)?\b/gi],
  ["Road Transport (General) Regulation 2021", "road-transport-general-regulation-2021", "regulation", /\b(?:Road\s+Transport\s+)?\(?General\)?\s+Reg(?:ulation)?(?:\s+2021)?\b/gi],
  ["Road Transport (Vehicle Registration) Regulation 2017", "road-transport-vehicle-registration-regulation-2017", "regulation", /\b(?:Road\s+Transport\s+)?\(?Vehicle\s+Registration\)?\s+Reg(?:ulation)?(?:\s+2017)?\b/gi],
  ["Roads Act 1993", "roads-act-1993", "act", /\bRoads\s+Act(?:\s+1993)?\b/gi],
  ["Transport Administration Act 1988", "transport-administration-act-1988", "act", /\bTransport\s+Administration\s+Act(?:\s+1988)?\b/gi],
  ["Crimes (Sentencing Procedure) Act 1999", "crimes-sentencing-procedure-act-1999", "act", /\bCrimes\s*\(Sentencing\s+Procedure\)\s*Act(?:\s+1999)?\b/gi],
  ["Crimes Act 1900", "crimes-act-1900", "act", /\bCrimes\s+Act(?:\s+1900)?\b/gi],
  ["Civil Procedure Act 2005", "civil-procedure-act-2005", "act", /\bCivil\s+Procedure\s+Act(?:\s+2005)?\b/gi],
  ["Land Acquisition (Just Terms Compensation) Act 1991", "land-acquisition-just-terms-compensation-act-1991", "act", /\bLand\s+Acquisition(?:\s*\(Just\s+Terms\s+Compensation\)\s*Act)?(?:\s+1991)?\b/gi],
  ["Heavy Vehicle National Law", "heavy-vehicle-national-law", "act", /\bHeavy\s+Vehicle\s+National\s+Law\b/gi],
  ["Heavy Vehicle (General) National Regulation", "heavy-vehicle-general-regulation", "regulation", /\bHeavy\s+Vehicle\s+\(?General\)?(?:\s+National)?\s+Reg(?:ulation)?\b/gi],
  ["Heavy Vehicle (Mass, Dimension and Loading) National Regulation", "heavy-vehicle-mass-dimension-and-loading-regulation", "regulation", /\bHeavy\s+Vehicle\s+\(?Mass(?:,\s*Dimension\s+and\s+Loading)?\)?(?:\s+National)?\s+Reg(?:ulation)?\b/gi],
  ["Heavy Vehicle (Vehicle Standards) National Regulation", "heavy-vehicle-vehicle-standards-regulation", "regulation", /\bHeavy\s+Vehicle\s+\(?Vehicle\s+Standards\)?(?:\s+National)?\s+Reg(?:ulation)?\b/gi],
  ["Heavy Vehicle (Fatigue Management) National Regulation", "heavy-vehicle-fatigue-management-regulation", "regulation", /\bHeavy\s+Vehicle\s+\(?Fatigue(?:\s+Management)?\)?(?:\s+National)?\s+Reg(?:ulation)?\b/gi],
  ["Australian Consumer Law", "australian-consumer-law", "schedule", /\bAustralian\s+Consumer\s+Law\b/gi],
  ["Competition and Consumer Act 2010", "competition-and-consumer-act-2010", "act", /\bCompetition\s+and\s+Consumer\s+Act(?:\s+2010)?\b/gi]
];

function extractBaseSection(rawSec) {
  const m = String(rawSec || "").trim().match(/^(\d+[A-Za-z]?)/);
  return m ? m[1] : String(rawSec || "").trim();
}

function parseMncToSlug(year, court, num) {
  return `${year}-${String(court).toLowerCase()}-${num}`;
}

function extractCitations(text, currentActSlug = null) {
  const citations = [];
  const seen = new Set();

  // 1. Medium Neutral Citations (MNC)
  const mncRe = /\[(19\d\d|20\d\d)\]\s+([A-Za-z]+)\s+(\d+)/gi;
  let m;
  while ((m = mncRe.exec(text)) !== null) {
    const year = m[1];
    const court = m[2].toUpperCase();
    const num = m[3];
    const slug = parseMncToSlug(year, court, num);
    const key = `case:${slug}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({
        citation_type: "case",
        target_id: slug,
        raw_text: m[0],
        metadata: { year, court, number: num, mnc: `[${year}] ${court} ${num}` }
      });
    }
  }

  // 2. Statutory Acronyms
  const acroRe = /\b(RTA|RR|DL|HVNL|ACL|CCA)\s+(?:s|sec|section|r|rule|cl|clause)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)/gi;
  while ((m = acroRe.exec(text)) !== null) {
    const acro = m[1].toUpperCase();
    const rawSec = m[2];
    const baseSec = extractBaseSection(rawSec);
    const inst = ACRONYM_MAP[acro];
    if (inst) {
      const prefix = inst.pref_type === "regulation" ? "r" : "s";
      const targetId = `${inst.slug}:${prefix}${baseSec}`;
      const key = `statute:${targetId}`;
      if (!seen.has(key)) {
        seen.add(key);
        citations.push({
          citation_type: inst.pref_type === "regulation" ? "regulation" : "statute",
          target_id: targetId,
          act_slug: inst.slug,
          section: baseSec,
          raw_text: m[0],
          metadata: { instrument_title: inst.title, section: baseSec, original_sec: rawSec, acronym: acro }
        });
      }
    }
  }

  // 3. Explicit Proximity Matching for Full Statute & Regulation Names
  for (const [title, slug, instType, pattern] of KNOWN_INSTRUMENTS) {
    pattern.lastIndex = 0;
    let instM;
    while ((instM = pattern.exec(text)) !== null) {
      const instStart = instM.index;
      const instEnd = instStart + instM[0].length;
      const snippets = [
        ["after", text.slice(instEnd, instEnd + 120)],
        ["before", text.slice(Math.max(0, instStart - 120), instStart)]
      ];
      for (const [dir, snippet] of snippets) {
        const secRe = instType === "regulation"
          ? /\b(?:r|rule|cl|clause)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)/gi
          : /\b(?:s|sec|section)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)/gi;
        let sm;
        while ((sm = secRe.exec(snippet)) !== null) {
          const rawSec = sm[1];
          const baseSec = extractBaseSection(rawSec);
          const prefix = instType === "regulation" ? "r" : "s";
          const targetId = `${slug}:${prefix}${baseSec}`;
          const key = `statute:${targetId}`;
          if (!seen.has(key)) {
            seen.add(key);
            citations.push({
              citation_type: instType === "regulation" ? "regulation" : "statute",
              target_id: targetId,
              act_slug: slug,
              section: baseSec,
              raw_text: dir === "after" ? `${instM[0]} ${sm[0]}` : `${sm[0]} of ${instM[0]}`,
              metadata: { instrument_title: title, section: baseSec, original_sec: rawSec }
            });
          }
        }
      }
    }
  }

  // 4. Context-Aware Bare Section Pinpoints
  if (currentActSlug) {
    const bareRe = /(?:^|\s)(?:s|sec|section|r|rule|cl|clause)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)/gi;
    while ((m = bareRe.exec(text)) !== null) {
      const rawSec = m[1];
      const baseSec = extractBaseSection(rawSec);
      const prefix = (currentActSlug.includes("regulation") || currentActSlug.includes("rules")) ? "r" : "s";
      const targetId = `${currentActSlug}:${prefix}${baseSec}`;
      const key = `statute:${targetId}`;
      if (!seen.has(key)) {
        seen.add(key);
        citations.push({
          citation_type: "statute",
          target_id: targetId,
          act_slug: currentActSlug,
          section: baseSec,
          raw_text: m[0].trim(),
          metadata: { instrument_title: currentActSlug, section: baseSec, context_inferred: true }
        });
      }
    }
  }

  // 5. Lawpart Offence Codes
  const lpcRe = /\b(?:LPC|lawpart(?:\s+code)?)\s*[:#]?\s*(\d{5})\b/gi;
  while ((m = lpcRe.exec(text)) !== null) {
    const code = m[1];
    const key = `offence:LPC:${code}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({
        citation_type: "offence",
        target_id: `LPC:${code}`,
        raw_text: m[0],
        metadata: { lawpart_code: code }
      });
    }
  }

  return citations;
}

function compileCommentaryHtml(markdownText, currentActSlug = null) {
  const citations = extractCitations(markdownText || "", currentActSlug);
  let html = String(markdownText || "");

  // 1. Medium Neutral Citations
  html = html.replace(/\[(19\d\d|20\d\d)\]\s+([A-Za-z]+)\s+(\d+)/gi, (_, year, courtRaw, num) => {
    const court = courtRaw.toUpperCase();
    const slug = parseMncToSlug(year, court, num);
    const mncText = `[${year}] ${court} ${num}`;
    return `<a href="#/cases/${slug}" class="case-cite-link" data-case-slug="${slug}" data-mnc="${mncText}" title="Open ${mncText} in Canopy">${mncText}</a>`;
  });

  // 2. Paragraph Jump Ranges & Single Jumps
  html = html.replace(/\[(\d+)\]\s*[-–]\s*\[(\d+)\]|\[(\d+)\s*[-–]\s*(\d+)\]/g, (_, s1, e1, s2, e2) => {
    const start = s1 || s2;
    const end = e1 || e2;
    return `<a href="#para-${start}" class="para-jump-link" data-jump-start="${start}" data-jump-end="${end}" onclick="app.jumpToParagraph(${start}, ${end})" title="Jump to paragraphs [${start}]-[{end}] in reader">[${start}]–[${end}]</a>`;
  });

  html = html.replace(/\[(\d+)\](?!\s*(?:[A-Za-z]{2,8}\s+\d|\())/g, (_, start) => {
    return `<a href="#para-${start}" class="para-jump-link" data-jump-start="${start}" onclick="app.jumpToParagraph(${start})" title="Jump to paragraph [${start}] in reader">[${start}]</a>`;
  });

  // 3. Statutory Acronyms
  html = html.replace(/\b(RTA|RR|DL|HVNL|ACL|CCA)\s+(?:s|sec|section|r|rule|cl|clause)\.?\s*(\d+[A-Za-z]?(?:\([^)]+\))*)/gi, (full, acroRaw, rawSec) => {
    const acro = acroRaw.toUpperCase();
    const baseSec = extractBaseSection(rawSec);
    const inst = ACRONYM_MAP[acro];
    if (!inst) return full;
    const prefix = inst.pref_type === "regulation" ? "r" : "s";
    const url = `#/${inst.slug}/${prefix}${baseSec}`;
    return `<a href="${url}" class="statute-link" data-act="${inst.slug}" data-sec="${baseSec}" title="${inst.title} section ${baseSec}">${full}</a>`;
  });

  // 4. Lawpart Codes
  html = html.replace(/\b(?:LPC|lawpart(?:\s+code)?)\s*[:#]?\s*(\d{5})\b/gi, (full, code) => {
    return `<a href="javascript:void(0)" class="lawpart-cite-link" data-lpc="${code}" onclick="app.filterLawparts('${code}')" title="Filter Section Intelligence for Lawpart Code #${code}">${full}</a>`;
  });

  // 5. Markdown Formatting
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");

  const paragraphs = html.split("\n\n").map(p => p.trim()).filter(Boolean);
  if (paragraphs.length > 1) {
    html = paragraphs.map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`).join("");
  } else {
    html = `<p>${html.replace(/\n/g, "<br/>")}</p>`;
  }

  return { body_html: html, citations };
}

// --- AUTHENTICATION HELPERS (Cloudflare Access) ---

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function extractUserIdentity(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || cookies["CF_Authorization"];
  const cfEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
  const cfUid = request.headers.get("Cf-Access-Authenticated-User-Id");

  if (jwt && jwt.includes(".")) {
    try {
      const parts = jwt.split(".");
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const payload = JSON.parse(atob(padded));
      const sub = payload.sub || cfUid || payload.email || cfEmail;
      const email = payload.email || cfEmail || "";
      const display = payload.name || (email ? email.split("@")[0] : "Practitioner");
      if (sub || email) {
        return {
          authenticated: true,
          user_id: String(sub).startsWith("cf:") ? sub : `cf:${sub || email}`,
          email,
          display_name: display,
          auth_provider: "cloudflare_access"
        };
      }
    } catch (_) {}
  }

  if (cfEmail || cfUid) {
    const uid = cfUid || cfEmail;
    const display = cfEmail && cfEmail.includes("@") ? cfEmail.split("@")[0] : (cfEmail || "Practitioner");
    return {
      authenticated: true,
      user_id: `cf:${uid}`,
      email: cfEmail,
      display_name: display,
      auth_provider: "cloudflare_access"
    };
  }

  const url = new URL(request.url);
  if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && env.CANOPY_REQUIRE_CLOUD_AUTH !== "1") {
    return {
      authenticated: true,
      user_id: "local:dev",
      email: "local@canopy.dev",
      display_name: "Nick C. (Local)",
      auth_provider: "local_dev"
    };
  }

  return {
    authenticated: false,
    user_id: null,
    email: null,
    display_name: null,
    auth_provider: null
  };
}

// --- JSON & STATIC ASSET HELPERS ---

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Sync-Secret"
    }
  });
}

async function fetchStaticJson(request, env, assetPath) {
  if (!env.ASSETS) return null;
  const assetUrl = new URL(assetPath, request.url);
  const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  if (!res || !res.ok) return null;
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

// --- D1 COMMENTARY QUERIES ---

function normalizeTargetId(targetType, targetId) {
  if (targetType === "provision" && targetId && targetId.includes(":")) {
    const [actPart, secPart] = targetId.split(":", 2);
    const cleanSec = extractBaseSection(secPart.replace(/^[sr]/i, ""));
    const prefix = (actPart.includes("regulation") || actPart.includes("rules")) ? "r" : "s";
    return `${actPart}:${prefix}${cleanSec}`;
  }
  return targetId;
}

async function queryCommentaryD1(env, targetType, targetId, tier = null, paragraph = null) {
  if (!env.DB_ANNOTATIONS) {
    return { target_type: targetType, target_id: targetId, total_count: 0, case_level: [], paragraph_level: [], all: [], referenced_by: [] };
  }

  const normalizedId = normalizeTargetId(targetType, targetId);
  let sql = `
    SELECT * FROM commentary
    WHERE target_type = ?
      AND (target_id = ? OR target_id = ?)
      AND COALESCE(status, 'active') = 'active'
  `;
  const params = [targetType, targetId, normalizedId];

  if (tier && tier !== "all") {
    const tierNorm = (tier.includes("1") || tier.includes("mod")) ? "moderator" : (tier.includes("ai") ? "ai" : "practitioner");
    sql += " AND author_tier = ?";
    params.push(tierNorm);
  }

  if (paragraph !== null && paragraph !== undefined && !Number.isNaN(Number(paragraph))) {
    sql += " AND (target_paragraph_start <= ? AND (target_paragraph_end >= ? OR target_paragraph_end IS NULL))";
    params.push(Number(paragraph), Number(paragraph));
  }

  sql += " ORDER BY CASE WHEN target_paragraph_start IS NULL THEN 0 ELSE 1 END ASC, target_paragraph_start ASC, created_at ASC";

  const { results: items = [] } = await env.DB_ANNOTATIONS.prepare(sql).bind(...params).all();

  let referencedBy = [];
  try {
    const backlinkSql = `
      SELECT DISTINCT c.*, cc.raw_text as cited_as
      FROM commentary_citations cc
      JOIN commentary c ON cc.commentary_id = c.id
      WHERE (cc.cited_target_id = ? OR cc.cited_target_id = ?)
        AND COALESCE(c.status, 'active') = 'active'
        AND c.target_id != ? AND c.target_id != ?
      ORDER BY c.created_at DESC
    `;
    const { results: bl = [] } = await env.DB_ANNOTATIONS.prepare(backlinkSql)
      .bind(targetId, normalizedId, targetId, normalizedId)
      .all();
    referencedBy = bl;
  } catch (_) {}

  const caseLevel = items.filter(c => !c.target_paragraph_start);
  const paragraphLevel = items.filter(c => Boolean(c.target_paragraph_start));

  return {
    target_type: targetType,
    target_id: targetId,
    total_count: items.length,
    case_level: caseLevel,
    paragraph_level: paragraphLevel,
    all: items,
    referenced_by: referencedBy
  };
}

// --- MAIN WORKER FETCH HANDLER ---

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return jsonResponse({ ok: true });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Auth & Identity Endpoints
    if (path === "/api/me" && request.method === "GET") {
      const user = extractUserIdentity(request, env);
      return jsonResponse({
        ...user,
        login_url: "/api/auth/login",
        logout_url: "/cdn-cgi/access/logout"
      });
    }

    if (path === "/api/auth/login") {
      const redirect = url.searchParams.get("redirect") || "/";
      const safeTarget = redirect.startsWith("/") ? redirect : "/";
      return Response.redirect(new URL(safeTarget, url.origin).toString(), 302);
    }

    // 2. Commentary Preview Endpoint
    if (path === "/api/commentary/preview" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const res = compileCommentaryHtml(body.body_markdown || "", body.current_act_slug || null);
      return jsonResponse(res);
    }

    // 3. Commentary Read Endpoints
    if (path === "/api/commentary" && request.method === "GET") {
      const targetType = url.searchParams.get("target_type") || "case";
      const targetId = url.searchParams.get("target_id") || "";
      const tier = url.searchParams.get("tier");
      const para = url.searchParams.get("paragraph");
      const data = await queryCommentaryD1(env, targetType, targetId, tier, para);
      return jsonResponse(data);
    }

    const commPathMatch = path.match(/^\/api\/commentary\/(case|provision|offence)\/(.+)$/);
    if (commPathMatch && request.method === "GET") {
      const targetType = commPathMatch[1];
      const targetId = decodeURIComponent(commPathMatch[2]);
      const tier = url.searchParams.get("tier");
      const para = url.searchParams.get("paragraph");
      const data = await queryCommentaryD1(env, targetType, targetId, tier, para);
      return jsonResponse(data);
    }

    // 4. Commentary Write Endpoints (Protected by Cloudflare Access)
    if (path === "/api/commentary" && request.method === "POST") {
      const user = extractUserIdentity(request, env);
      if (!user.authenticated) {
        return jsonResponse({ detail: "Authentication required via Cloudflare Access to add annotations." }, 401);
      }
      if (!env.DB_ANNOTATIONS) {
        return jsonResponse({ detail: "Annotations D1 database binding (DB_ANNOTATIONS) not configured." }, 500);
      }

      const req = await request.json();
      const commId = `comm-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      let tier = req.author_tier || req.tier || "practitioner";
      if (tier.startsWith("tier1")) tier = "moderator";
      else if (tier.startsWith("tier2") || tier.startsWith("tier3")) tier = "practitioner";
      else if (tier.toLowerCase().includes("ai")) tier = "ai";

      const pStart = req.target_paragraph_start || null;
      const pEnd = req.target_paragraph_end || pStart;
      const normalizedId = normalizeTargetId(req.target_type, req.target_id);
      const actSlug = req.current_act_slug || (req.target_type === "provision" && normalizedId.includes(":") ? normalizedId.split(":")[0] : null);
      const { body_html, citations } = compileCommentaryHtml(req.body_markdown || "", actSlug);
      const authorName = (req.author_name || "").trim() || user.display_name || "Practitioner";
      const authorRole = req.author_role || (tier === "ai" ? "AI Notation" : "Practitioner");
      const visibility = req.visibility || "public";

      const statements = [
        env.DB_ANNOTATIONS.prepare(`
          INSERT INTO commentary (
            id, target_type, target_id, target_paragraph_start, target_paragraph_end,
            author_tier, author_id, author_name, author_role, title,
            body_markdown, body_html, visibility, status, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)
        `).bind(
          commId, req.target_type, normalizedId, pStart, pEnd,
          tier, user.user_id, authorName, authorRole, req.title,
          req.body_markdown, body_html, visibility
        ),
        env.DB_ANNOTATIONS.prepare(`
          INSERT INTO commentary_fts (commentary_id, title, body_markdown, author_name)
          VALUES (?, ?, ?, ?)
        `).bind(commId, req.title, req.body_markdown, authorName)
      ];

      for (const cit of citations) {
        statements.push(
          env.DB_ANNOTATIONS.prepare(`
            INSERT INTO commentary_citations (commentary_id, citation_type, cited_target_id, raw_text)
            VALUES (?, ?, ?, ?)
          `).bind(commId, cit.citation_type, cit.target_id, cit.raw_text)
        );
      }

      await env.DB_ANNOTATIONS.batch(statements);

      return jsonResponse({
        id: commId,
        target_type: req.target_type,
        target_id: normalizedId,
        target_paragraph_start: pStart,
        target_paragraph_end: pEnd,
        author_tier: tier,
        author_id: user.user_id,
        author_name: authorName,
        author_role: authorRole,
        title: req.title,
        body_markdown: req.body_markdown,
        body_html,
        version: 1,
        citations
      });
    }

    const commIdMatch = path.match(/^\/api\/commentary\/(comm-[A-Za-z0-9_-]+)$/);
    if (commIdMatch && request.method === "PUT") {
      const user = extractUserIdentity(request, env);
      if (!user.authenticated) {
        return jsonResponse({ detail: "Authentication required via Cloudflare Access to edit annotations." }, 401);
      }
      const commentId = commIdMatch[1];
      const existing = await env.DB_ANNOTATIONS.prepare("SELECT * FROM commentary WHERE id = ?").bind(commentId).first();
      if (!existing || existing.status === "archived") {
        return jsonResponse({ detail: "Commentary not found" }, 404);
      }

      const req = await request.json();
      let tier = req.author_tier || req.tier || existing.author_tier || "practitioner";
      if (tier.startsWith("tier1")) tier = "moderator";
      else if (tier.startsWith("tier2") || tier.startsWith("tier3")) tier = "practitioner";
      else if (tier.toLowerCase().includes("ai")) tier = "ai";

      const pStart = req.target_paragraph_start !== undefined ? req.target_paragraph_start : existing.target_paragraph_start;
      const pEnd = req.target_paragraph_end || pStart;
      const targetId = existing.target_id;
      const actSlug = req.current_act_slug || (existing.target_type === "provision" && targetId.includes(":") ? targetId.split(":")[0] : null);
      const { body_html, citations } = compileCommentaryHtml(req.body_markdown || "", actSlug);
      const authorName = (req.author_name || "").trim() || existing.author_name || user.display_name || "Practitioner";
      const authorRole = req.author_role !== undefined ? req.author_role : existing.author_role;
      const visibility = req.visibility || existing.visibility || "public";
      const newVersion = (Number(existing.version) || 1) + 1;

      const statements = [
        env.DB_ANNOTATIONS.prepare(`
          UPDATE commentary
          SET title = ?, body_markdown = ?, body_html = ?, author_tier = ?, author_id = ?,
              author_name = ?, author_role = ?, target_paragraph_start = ?, target_paragraph_end = ?,
              visibility = ?, version = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          req.title, req.body_markdown, body_html, tier, user.user_id,
          authorName, authorRole, pStart, pEnd, visibility, newVersion, commentId
        ),
        env.DB_ANNOTATIONS.prepare("DELETE FROM commentary_fts WHERE commentary_id = ?").bind(commentId),
        env.DB_ANNOTATIONS.prepare(`
          INSERT INTO commentary_fts (commentary_id, title, body_markdown, author_name)
          VALUES (?, ?, ?, ?)
        `).bind(commentId, req.title, req.body_markdown, authorName),
        env.DB_ANNOTATIONS.prepare("DELETE FROM commentary_citations WHERE commentary_id = ?").bind(commentId)
      ];

      for (const cit of citations) {
        statements.push(
          env.DB_ANNOTATIONS.prepare(`
            INSERT INTO commentary_citations (commentary_id, citation_type, cited_target_id, raw_text)
            VALUES (?, ?, ?, ?)
          `).bind(commentId, cit.citation_type, cit.target_id, cit.raw_text)
        );
      }

      await env.DB_ANNOTATIONS.batch(statements);

      return jsonResponse({
        id: commentId,
        target_type: existing.target_type,
        target_id: targetId,
        target_paragraph_start: pStart,
        target_paragraph_end: pEnd,
        author_tier: tier,
        author_id: user.user_id,
        author_name: authorName,
        author_role: authorRole,
        title: req.title,
        body_markdown: req.body_markdown,
        body_html,
        version: newVersion,
        citations
      });
    }

    if (commIdMatch && request.method === "DELETE") {
      const user = extractUserIdentity(request, env);
      if (!user.authenticated) {
        return jsonResponse({ detail: "Authentication required via Cloudflare Access to delete annotations." }, 401);
      }
      const commentId = commIdMatch[1];
      await env.DB_ANNOTATIONS.batch([
        env.DB_ANNOTATIONS.prepare(`
          UPDATE commentary
          SET status = 'archived', version = COALESCE(version, 1) + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(commentId),
        env.DB_ANNOTATIONS.prepare("DELETE FROM commentary_fts WHERE commentary_id = ?").bind(commentId),
        env.DB_ANNOTATIONS.prepare("DELETE FROM commentary_citations WHERE commentary_id = ?").bind(commentId)
      ]);
      return jsonResponse({ deleted: true, id: commentId });
    }

    // 5. Legislation & Stats Endpoints (Served from Static Data Bundles + Live D1 Commentary)
    if (path === "/api/stats" && request.method === "GET") {
      const stats = await fetchStaticJson(request, env, "/static-data/stats.json");
      if (stats) return jsonResponse(stats);
      return jsonResponse({ acts_count: 0, regs_count: 0, total_statutes: 0, total_provisions: 0, portfolios: [] });
    }

    if (path === "/api/acts" && request.method === "GET") {
      let acts = (await fetchStaticJson(request, env, "/static-data/acts.json")) || [];
      const portfolio = url.searchParams.get("portfolio");
      const category = url.searchParams.get("category");
      if (portfolio) acts = acts.filter(a => a.portfolio === portfolio);
      if (category) acts = acts.filter(a => a.category === category);
      return jsonResponse(acts);
    }

    const actTreeMatch = path.match(/^\/api\/acts\/([^/]+)\/tree$/);
    if (actTreeMatch && request.method === "GET") {
      const actSlug = actTreeMatch[1];
      const treeData = await fetchStaticJson(request, env, `/static-data/trees/${actSlug}.json`);
      if (!treeData) return jsonResponse({ act_slug: actSlug, tree: [] });
      return jsonResponse(treeData);
    }

    const actNodeMatch = path.match(/^\/api\/acts\/([^/]+)\/nodes\/(.+)$/);
    if (actNodeMatch && request.method === "GET") {
      const actSlug = actNodeMatch[1];
      const nodeSlug = decodeURIComponent(actNodeMatch[2]).replace(/^\/+|\/+$/g, "");
      const bundle = await fetchStaticJson(request, env, `/static-data/act-provisions/${actSlug}.json`);
      if (!bundle || !bundle.nodes) {
        return jsonResponse({ detail: "Structural node not found" }, 404);
      }
      const nodeObj = bundle.nodes[nodeSlug] || Object.values(bundle.nodes).find(
        n => n.node.slug === nodeSlug || n.node.id === nodeSlug || (n.node.path_hierarchy || "").endsWith(`/${nodeSlug}`)
      );
      if (!nodeObj) return jsonResponse({ detail: "Structural node not found" }, 404);
      const hydratedProvs = nodeObj.provisions || (nodeObj.provision_slugs || []).map(k => bundle.provisions[k]).filter(Boolean);
      return jsonResponse({ ...nodeObj, provisions: hydratedProvs });
    }

    const actProvSubMatch = path.match(/^\/api\/acts\/([^/]+)\/provisions\/(.+?)(?:\/(info|lawparts|cases))?$/);
    if (actProvSubMatch && request.method === "GET") {
      const actSlug = actProvSubMatch[1];
      const fullSlug = decodeURIComponent(actProvSubMatch[2]);
      const subAction = actProvSubMatch[3] || null;

      const bundle = await fetchStaticJson(request, env, `/static-data/act-provisions/${actSlug}.json`);
      if (!bundle || !bundle.provisions) {
        return jsonResponse({ detail: `Act '${actSlug}' not found` }, 404);
      }

      const bareSlug = fullSlug.split("/").pop();
      const aliases = bundle.slug_aliases || {};
      const resolvedKey = aliases[fullSlug] || aliases[bareSlug] || aliases[`s${bareSlug}`] || aliases[`r${bareSlug}`] || fullSlug;
      const prov = bundle.provisions[resolvedKey] || bundle.provisions[fullSlug] || bundle.provisions[bareSlug] || bundle.provisions[`s${bareSlug}`] || bundle.provisions[`r${bareSlug}`];
      if (!prov) {
        return jsonResponse({ detail: `Provision '${fullSlug}' not found in '${actSlug}'` }, 404);
      }

      if (subAction === "lawparts") {
        return jsonResponse((prov.info && prov.info.lawparts) || []);
      }
      if (subAction === "cases") {
        return jsonResponse((prov.info && prov.info.cases) || []);
      }

      // Attach live commentary & backlinks from D1
      const cleanSec = String(prov.identifier || "").replace(/^(s|sec|rule|cl|clause)\s*/i, "").trim();
      const prefix = (actSlug.includes("regulation") || actSlug.includes("rules")) ? "r" : "s";
      const provTargetId = `${actSlug}:${prefix}${cleanSec}`;
      const commData = await queryCommentaryD1(env, "provision", provTargetId);

      const infoObj = {
        lawparts: (prov.info && prov.info.lawparts) || [],
        count: ((prov.info && prov.info.lawparts) || []).length,
        db_name: (prov.info && prov.info.db_name) || "JudCom Lawparts v15",
        cases: (prov.info && prov.info.cases) || [],
        cases_count: ((prov.info && prov.info.cases) || []).length,
        commentary: commData.all || [],
        referenced_by: commData.referenced_by || []
      };

      if (subAction === "info") {
        return jsonResponse(infoObj);
      }

      return jsonResponse({ ...prov, info: infoObj });
    }

    const actSingleMatch = path.match(/^\/api\/acts\/([^/]+)$/);
    if (actSingleMatch && request.method === "GET") {
      const actSlug = actSingleMatch[1];
      const acts = (await fetchStaticJson(request, env, "/static-data/acts.json")) || [];
      const found = acts.find(a => a.slug === actSlug);
      if (!found) return jsonResponse({ detail: "Act not found" }, 404);
      return jsonResponse(found);
    }

    // 6. Caselaw Endpoints
    if (path === "/api/cases" && request.method === "GET") {
      let cases = (await fetchStaticJson(request, env, "/static-data/cases-list.json")) || [];
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const court = (url.searchParams.get("court") || "").trim().toLowerCase();
      if (court) {
        cases = cases.filter(c => (c.court || "").toLowerCase().includes(court));
      }
      if (q) {
        cases = cases.filter(c =>
          (c.title || "").toLowerCase().includes(q) ||
          (c.citation || "").toLowerCase().includes(q) ||
          (c.mnc || "").toLowerCase().includes(q) ||
          (c.catchwords || "").toLowerCase().includes(q) ||
          (c.parties || "").toLowerCase().includes(q)
        );
      }
      return jsonResponse(cases);
    }

    const caseSingleMatch = path.match(/^\/api\/cases\/([^/]+)$/);
    if (caseSingleMatch && request.method === "GET") {
      const caseSlug = decodeURIComponent(caseSingleMatch[1]);
      const caseObj = await fetchStaticJson(request, env, `/static-data/cases/${caseSlug}.json`);
      if (!caseObj) return jsonResponse({ detail: `Case '${caseSlug}' not found` }, 404);

      const commData = await queryCommentaryD1(env, "case", caseSlug);
      caseObj.commentary = commData.all || [];
      caseObj.referenced_by = commData.referenced_by || [];
      return jsonResponse(caseObj);
    }

    // 7. Search Endpoints (D1 FTS5 + Static Fallback)
    if (path === "/api/lawparts/search" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q || !env.DB_REF) return jsonResponse([]);
      const isNum = /^\d+$/.test(q);
      const sql = isNum
        ? `SELECT * FROM offence_variants WHERE lawpart_code LIKE ? LIMIT 50`
        : `SELECT * FROM offence_variants WHERE variant_description LIKE ? OR section LIKE ? LIMIT 50`;
      const binds = isNum ? [`${q}%`] : [`%${q}%`, `%${q}%`];
      const { results = [] } = await env.DB_REF.prepare(sql).bind(...binds).all();
      return jsonResponse(results);
    }

    if ((path === "/api/search" || path === "/api/search/unified" || path === "/api/search/omnibox") && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      const lpc = (url.searchParams.get("lpc") || "").trim();
      const scope = url.searchParams.get("scope") || "all";
      const actSlugFilter = url.searchParams.get("act_slug") || null;
      const limit = Math.min(Number(url.searchParams.get("limit") || 40), 100);

      const cleanQ = `${q} ${lpc}`.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
      const ftsQuery = cleanQ ? cleanQ.split(/\s+/).map(w => `"${w}"*`).join(" ") : "";

      let provisions = [];
      let cases = [];
      let lawparts = [];
      let statutes = [];

      const acts = (await fetchStaticJson(request, env, "/static-data/acts.json")) || [];
      const actMap = Object.fromEntries(acts.map(a => [a.slug, a]));

      if (q) {
        const ql = q.toLowerCase();
        statutes = acts.filter(a => (a.short_title || "").toLowerCase().includes(ql) || (a.slug || "").toLowerCase().includes(ql));
      }

      if (env.DB_REF && ftsQuery) {
        try {
          if (actSlugFilter) {
            const { results = [] } = await env.DB_REF.prepare(`
              SELECT provision_id, act_slug, full_slug, identifier, title,
                     snippet(provisions_fts, 5, '<mark>', '</mark>', '...', 25) as snippet,
                     bm25(provisions_fts) as score
              FROM provisions_fts
              WHERE provisions_fts MATCH ? AND act_slug = ?
              ORDER BY score LIMIT ?
            `).bind(ftsQuery, actSlugFilter, limit).all();
            provisions = results;
          } else {
            const { results = [] } = await env.DB_REF.prepare(`
              SELECT provision_id, act_slug, full_slug, identifier, title,
                     snippet(provisions_fts, 5, '<mark>', '</mark>', '...', 25) as snippet,
                     bm25(provisions_fts) as score
              FROM provisions_fts
              WHERE provisions_fts MATCH ?
              ORDER BY score LIMIT ?
            `).bind(ftsQuery, limit).all();
            provisions = results.map(p => ({
              ...p,
              act_title: actMap[p.act_slug]?.short_title || p.act_slug,
              jurisdiction_id: actMap[p.act_slug]?.jurisdiction_id || "nsw"
            }));
          }
        } catch (_) {}

        try {
          const { results = [] } = await env.DB_REF.prepare(`
            SELECT f.case_id as id, f.paragraph_number, c.citation, c.mnc, c.title, c.court,
                   c.jurisdiction, c.judgment_date, c.bench, c.catchwords,
                   snippet(case_paragraphs_fts, 2, '<mark>', '</mark>', '...', 25) as snippet,
                   bm25(case_paragraphs_fts) as score
            FROM case_paragraphs_fts f
            JOIN cases c ON f.case_id = c.id
            WHERE case_paragraphs_fts MATCH ?
            ORDER BY score LIMIT ?
          `).bind(ftsQuery, limit).all();
          const seen = new Set();
          for (const r of results) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              cases.push(r);
            }
          }
        } catch (_) {}

        try {
          const targetLp = lpc || q;
          if (targetLp) {
            const isNum = /^\d+$/.test(targetLp);
            const lpSql = isNum
              ? `SELECT * FROM offence_variants WHERE lawpart_code LIKE ? LIMIT 15`
              : `SELECT * FROM offence_variants WHERE variant_description LIKE ? OR section LIKE ? LIMIT 15`;
            const binds = isNum ? [`${targetLp}%`] : [`%${targetLp}%`, `%${targetLp}%`];
            const { results = [] } = await env.DB_REF.prepare(lpSql).bind(...binds).all();
            lawparts = results;
          }
        } catch (_) {}
      } else if (q) {
        // Fallback metadata search over static cases-list.json if DB_REF FTS is not yet populated
        const allCases = (await fetchStaticJson(request, env, "/static-data/cases-list.json")) || [];
        const ql = q.toLowerCase();
        cases = allCases.filter(c =>
          (c.title || "").toLowerCase().includes(ql) ||
          (c.citation || "").toLowerCase().includes(ql) ||
          (c.catchwords || "").toLowerCase().includes(ql)
        ).slice(0, limit).map(c => ({ ...c, snippet: c.catchwords }));
      }

      if (path === "/api/search") {
        return jsonResponse({ query: q, act_slug: actSlugFilter, count: provisions.length, results: provisions });
      }

      if (path === "/api/search/omnibox") {
        return jsonResponse({
          statutes: statutes.slice(0, 3).map(a => ({ slug: a.slug, title: a.short_title, category: a.category, portfolio: a.portfolio })),
          provisions: provisions.slice(0, 4),
          lawparts: lawparts.slice(0, 4),
          cases: cases.slice(0, 4)
        });
      }

      const totalCount = cases.length + provisions.length + statutes.length + lawparts.length;
      return jsonResponse({
        query: q,
        scope,
        total_count: totalCount,
        time_ms: 5,
        counts: {
          all: totalCount,
          cases: cases.length,
          provisions: provisions.length,
          statutes: statutes.length,
          lawparts: lawparts.length
        },
        cases,
        provisions,
        statutes: statutes.slice(0, 10),
        lawparts
      });
    }

    // 8. Fallback to Static Assets (SPA index.html & /static/*)
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) return assetRes;
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString(), request));
    }

    return new Response("Not Found", { status: 404 });
  }
};

