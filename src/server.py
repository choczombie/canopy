"""
FastAPI Server for Canopy Legal: Legislation Tree API, Provisions, and Static Web Reader.
"""
import os
import re
import json
import base64
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware

from .repository import LegislationRepository
from .lawpart_bridge import LawpartBridge

app = FastAPI(
    title="Canopy Legal: Modern Legislation & Caselaw Platform",
    description="Atomic provision addressing, hierarchical trees, dual-family typography, and full-text search for Commonwealth statutes.",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Repository (Supports modular acts.db and regs.db)
acts_db_path = os.environ.get("ACTS_DB_PATH", "data/acts.db")
regs_db_path = os.environ.get("REGS_DB_PATH", "data/regs.db")
# Fallback to single db if LEGISLATION_DB_PATH is specified
single_db = os.environ.get("LEGISLATION_DB_PATH")
if single_db and os.path.exists(single_db) and not os.path.exists(acts_db_path):
    repo = LegislationRepository(db_path=single_db)
else:
    repo = LegislationRepository(acts_db_path=acts_db_path, regs_db_path=regs_db_path)

# Initialize Lawparts Bridge Engine (tl_v15.db)
lawpart_bridge = LawpartBridge()

# Static files directory
static_dir = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_dir, exist_ok=True)

@app.get("/api/acts")
def list_acts(
    portfolio: Optional[str] = Query(None, description="Filter by portfolio: commercial | transport"),
    category: Optional[str] = Query(None, description="Filter by category: act | regulation")
):
    """Returns list of available Acts, Virtual Acts, and Regulations."""
    return repo.get_acts(portfolio=portfolio, category=category)

@app.get("/api/stats")
def get_stats():
    """Returns platform-wide statistics for the Canopy Legal homepage."""
    acts = repo.get_acts()
    acts_count = sum(1 for a in acts if (a.get('category') or 'act') == 'act')
    regs_count = sum(1 for a in acts if (a.get('category') or 'act') == 'regulation')
    
    total_provisions = 0
    with repo.get_connection("acts") as conn:
        row = conn.execute("SELECT COUNT(*) as c FROM provisions").fetchone()
        if row:
            total_provisions += row['c']
    if repo.regs_db_path != repo.acts_db_path and os.path.exists(repo.regs_db_path):
        with repo.get_connection("regs") as conn:
            row = conn.execute("SELECT COUNT(*) as c FROM provisions").fetchone()
            if row:
                total_provisions += row['c']

    return {
        "acts_count": acts_count,
        "regs_count": regs_count,
        "total_statutes": len(acts),
        "total_provisions": total_provisions,
        "portfolios": [
            {
                "id": "transport",
                "name": "Transport & Heavy Vehicle",
                "description": "National Heavy Vehicle Regulator (NHVR) applied law scheme and national regulations.",
                "badge": "National Scheme",
                "acts": [a for a in acts if a.get('portfolio') == 'transport']
            },
            {
                "id": "commercial",
                "name": "Commercial & Consumer",
                "description": "Foundational competition, consumer protection, and statutory trade practices.",
                "badge": "Commonwealth",
                "acts": [a for a in acts if a.get('portfolio') == 'commercial']
            },
            {
                "id": "financial",
                "name": "Financial Services, Superannuation & Banking",
                "description": "Commonwealth prudential statutory regimes governing superannuation entity covenants, banking executive accountability, insurance contract disclosures, and financial data collection.",
                "badge": "Commonwealth",
                "acts": [a for a in acts if a.get('portfolio') == 'financial']
            },
            {
                "id": "justice",
                "name": "Criminal, Sentencing & Administrative Review",
                "description": "Foundational NSW sentencing procedures, administrative decisions review, and judicial review statutes.",
                "badge": "New South Wales",
                "acts": [a for a in acts if a.get('portfolio') == 'justice']
            }
        ]
    }

@app.get("/api/acts/{act_slug}")
def get_act(act_slug: str):
    """Returns metadata for a specific Act."""
    act = repo.get_act_by_slug(act_slug)
    if not act:
        raise HTTPException(status_code=404, detail="Act not found")
    return act

@app.get("/api/acts/{act_slug}/tree")
def get_act_tree(act_slug: str):
    """Returns hierarchical tree (Chapters, Parts, Divisions, Sections)."""
    tree = repo.get_tree(act_slug)
    return {"act_slug": act_slug, "tree": tree}

@app.get("/api/acts/{act_slug}/provisions/{full_slug:path}/lawparts")
def get_provision_lawparts(act_slug: str, full_slug: str):
    """Returns all Lawpart offence variants linked to this provision from tl_v15.db."""
    prov = repo.get_provision(act_slug, full_slug)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provision '{full_slug}' not found in Act '{act_slug}'")
    sec_num = prov.get("identifier", "")
    return lawpart_bridge.get_offences_for_provision(act_slug, sec_num)

@app.get("/api/acts/{act_slug}/provisions/{full_slug:path}/cases")
def get_provision_cases(act_slug: str, full_slug: str):
    """Returns all caselaw decisions citing this specific statutory provision."""
    prov = repo.get_provision(act_slug, full_slug)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provision '{full_slug}' not found in Act '{act_slug}'")
    sec_num = prov.get("identifier", "")
    return repo.get_cases_citing_provision(act_slug, sec_num)

@app.get("/api/acts/{act_slug}/provisions/{full_slug:path}/info")
def get_provision_info(act_slug: str, full_slug: str):
    """Returns Judicial Commission Lawparts penalties, disqualifications, commentary, and citing caselaw."""
    prov = repo.get_provision(act_slug, full_slug)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provision '{full_slug}' not found in Act '{act_slug}'")

    sec_num = prov.get("identifier", "")
    citing_cases = repo.get_cases_citing_provision(act_slug, sec_num)
    info = prov.get("info") or {}

    return {
        "lawparts": info.get("lawparts", []),
        "count": info.get("count", 0),
        "db_name": info.get("db_name") or lawpart_bridge.db_name,
        "cases": citing_cases,
        "cases_count": len(citing_cases),
        "commentary": info.get("commentary", []),
        "referenced_by": info.get("referenced_by", [])
    }

@app.get("/api/acts/{act_slug}/provisions/{full_slug:path}")
def get_provision(act_slug: str, full_slug: str):
    """Returns atomic provision with elements, breadcrumbs, lawparts, and citing caselaw."""
    prov = repo.get_provision(act_slug, full_slug)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provision '{full_slug}' not found in Act '{act_slug}'")

    sec_num = prov.get("identifier", "")
    citing_cases = repo.get_cases_citing_provision(act_slug, sec_num)
    info = prov.get("info") or {}

    prov["info"] = {
        "lawparts": info.get("lawparts", []),
        "count": info.get("count", 0),
        "db_name": info.get("db_name") or lawpart_bridge.db_name,
        "cases": citing_cases,
        "cases_count": len(citing_cases),
        "commentary": info.get("commentary", []),
        "referenced_by": info.get("referenced_by", [])
    }
    return prov

@app.get("/api/lawparts/search")
def search_lawparts(q: str = Query(..., min_length=2, description="Search by code, section, or keyword")):
    """Omni-search across lawpart offence codes, descriptions, and sections."""
    return lawpart_bridge.search_lawparts(q)

@app.get("/api/acts/{act_slug}/nodes/{node_slug:path}")
def get_node_content(act_slug: str, node_slug: str):
    """Returns structural container (Chapter/Part/Schedule) with all provisions."""
    content = repo.get_structural_node_content(act_slug, node_slug)
    if not content:
        raise HTTPException(status_code=404, detail=f"Structural node '{node_slug}' not found in Act '{act_slug}'")
    return content

@app.get("/api/nodes/{node_id}/provisions")
def get_provisions_for_node(node_id: str):
    """Returns all provisions under a structural container (e.g. whole Part)."""
    provisions = repo.get_provisions_by_node(node_id)
    return {"node_id": node_id, "provisions": provisions}

@app.get("/api/search")
def search_legislation(
    q: str = Query(..., min_length=1, description="Search query string"),
    act_slug: Optional[str] = Query(None, description="Optional Act slug filter"),
    limit: int = Query(40, ge=1, le=100)
):
    """Performs real-time FTS5 BM25 search across provisions."""
    results = repo.search_provisions(query=q, act_slug=act_slug, limit=limit)
    return {"query": q, "act_slug": act_slug, "count": len(results), "results": results}

@app.get("/api/search/unified")
def search_unified_endpoint(
    q: str = Query(..., min_length=1, description="Search query string"),
    scope: str = Query("all", description="Scope filter"),
    court: Optional[str] = Query(None, description="Court filter"),
    year_from: Optional[str] = Query(None, description="Starting year filter"),
    year_to: Optional[str] = Query(None, description="Ending year filter"),
    match_mode: str = Query("all", description="Match mode: all, exact, title"),
    limit: int = Query(50, ge=1, le=100)
):
    """Unified full-text search across caselaw, statutory provisions, and lawparts."""
    clean_court = court.strip() if court and court.strip() else None
    clean_yf = int(year_from.strip()) if year_from and year_from.strip().isdigit() else None
    clean_yt = int(year_to.strip()) if year_to and year_to.strip().isdigit() else None

    res = repo.search_unified(
        query=q,
        scope=scope,
        court=clean_court,
        year_from=clean_yf,
        year_to=clean_yt,
        match_mode=match_mode,
        limit=limit
    )
    
    # Also attach matching lawparts
    if scope in ("all", "legislation", "nsw-acts", "nsw-regs"):
        try:
            lp_res = lawpart_bridge.search_lawparts(q)
            res["lawparts"] = lp_res[:15]
            res["counts"]["lawparts"] = len(lp_res)
            res["counts"]["all"] += len(lp_res)
            res["total_count"] += len(lp_res)
        except Exception:
            res["lawparts"] = []
            res["counts"]["lawparts"] = 0
    else:
        res["lawparts"] = []
        res["counts"]["lawparts"] = 0

    return res

@app.get("/api/search/omnibox")
def search_omnibox(
    q: Optional[str] = Query("", description="Primary query string"),
    lpc: Optional[str] = Query("", description="Pinpoint section or Lawpart code"),
    scope: Optional[str] = Query("all", description="Scope filter")
):
    """Unified autocomplete omnibox endpoint returning categorized matches across statutes, provisions, lawparts, and caselaw."""
    query = (q or "").strip()
    pinpoint = (lpc or "").strip()
    
    out = {
        "statutes": [],
        "provisions": [],
        "lawparts": [],
        "cases": []
    }
    
    include_legislation = scope in ("all", "legislation", "nsw-acts", "nsw-regs", "cth-acts", "cth-regs")
    include_caselaw = scope in ("all", "caselaw", "nsw-caselaw")
    include_lawparts = scope in ("all", "legislation", "nsw-acts", "nsw-regs")

    # 1. Check Lawparts / Offences
    if include_lawparts:
        if pinpoint:
            try:
                lp_res = lawpart_bridge.search_lawparts(pinpoint)
                out["lawparts"] = lp_res[:4]
            except Exception:
                pass
        elif query and (query.isdigit() or (len(query) >= 4 and query[:4].isdigit())):
            try:
                lp_res = lawpart_bridge.search_lawparts(query)
                out["lawparts"] = lp_res[:4]
            except Exception:
                pass

    # 2. Check Statutes
    if query and include_legislation:
        acts = repo.get_acts()
        q_lower = query.lower()
        matched_acts = []
        for a in acts:
            # Apply scope filter on jurisdiction and category
            j_id = a.get("jurisdiction_id", "").lower()
            cat = a.get("category", "act").lower()
            if scope == "nsw-acts" and not (j_id == "nsw" and cat == "act"):
                continue
            if scope == "nsw-regs" and not (j_id == "nsw" and cat == "regulation"):
                continue
            if scope == "cth-acts" and not (j_id == "cth" and cat == "act"):
                continue
            if scope == "cth-regs" and not (j_id == "cth" and cat == "regulation"):
                continue

            title = a.get("short_title", "").lower()
            slug = a.get("slug", "").lower()
            if q_lower in title or q_lower in slug:
                matched_acts.append({
                    "slug": a.get("slug"),
                    "title": a.get("short_title"),
                    "category": a.get("category", "act"),
                    "portfolio": a.get("portfolio", "commercial")
                })
        out["statutes"] = matched_acts[:3]

    # 3. Check Provisions (FTS5 search)
    if (query or pinpoint) and include_legislation:
        search_target = f"{query} {pinpoint}".strip()
        try:
            prov_matches = repo.search_provisions(query=search_target, limit=4)
            filtered_provs = []
            for p in prov_matches:
                act_slug = p.get("act_slug", "")
                if scope == "nsw-acts" and not ("road-transport" in act_slug or "roads-act" in act_slug):
                    continue
                if scope == "nsw-regs" and not ("road-rules" in act_slug or "regulation" in act_slug):
                    continue
                filtered_provs.append({
                    "act_slug": p.get("act_slug"),
                    "full_slug": p.get("full_slug"),
                    "identifier": p.get("identifier"),
                    "title": p.get("title")
                })
            out["provisions"] = filtered_provs[:4]
        except Exception:
            pass
            
    # 4. Check Caselaw (Metadata + Paragraph FTS)
    if query and include_caselaw:
        try:
            case_court = "NSW" if scope == "nsw-caselaw" else None
            cases = repo.search_cases_full_text(query=query, court=case_court, limit=4)
            out["cases"] = [
                {
                    "id": c.get("id"),
                    "title": c.get("title") or c.get("citation"),
                    "mnc": c.get("mnc"),
                    "court": c.get("court"),
                    "year": c.get("year") or (c.get("judgment_date", "")[:4] if c.get("judgment_date") else None),
                    "snippet": c.get("snippet")
                }
                for c in cases[:4]
            ]
        except Exception:
            pass

    return out

# --- AUTHENTICATION, CASELAW & COMMENTARY ENDPOINTS ---

from pydantic import BaseModel

def extract_user_identity(request: Request) -> Dict[str, Any]:
    """
    Extracts authenticated user identity from Cloudflare Access headers/cookies,
    falling back to local developer identity when running on localhost.
    """
    jwt_token = request.headers.get("Cf-Access-Jwt-Assertion") or request.cookies.get("CF_Authorization")
    cf_email = request.headers.get("Cf-Access-Authenticated-User-Email")
    cf_uid = request.headers.get("Cf-Access-Authenticated-User-Id")

    if jwt_token and "." in jwt_token:
        try:
            parts = jwt_token.split(".")
            if len(parts) >= 2:
                padded = parts[1] + "=" * (-len(parts[1]) % 4)
                payload = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")).decode("utf-8"))
                sub = payload.get("sub") or cf_uid or payload.get("email") or cf_email
                email = payload.get("email") or cf_email or ""
                display = payload.get("name") or (email.split("@")[0] if email else "Practitioner")
                if sub or email:
                    return {
                        "authenticated": True,
                        "user_id": f"cf:{sub}" if sub and not str(sub).startswith("cf:") else (sub or f"cf:{email}"),
                        "email": email,
                        "display_name": display,
                        "auth_provider": "cloudflare_access"
                    }
        except Exception:
            pass

    if cf_email or cf_uid:
        uid = cf_uid or cf_email
        display = cf_email.split("@")[0] if cf_email and "@" in cf_email else (cf_email or "Practitioner")
        return {
            "authenticated": True,
            "user_id": f"cf:{uid}",
            "email": cf_email,
            "display_name": display,
            "auth_provider": "cloudflare_access"
        }

    # Check if strict cloud auth is enforced or if running on localhost
    require_cloud_auth = os.environ.get("CANOPY_REQUIRE_CLOUD_AUTH", "0") == "1"
    host = (request.headers.get("host") or "").split(":")[0].lower()
    is_local_host = host in ("127.0.0.1", "localhost", "testserver", "")

    if is_local_host and not require_cloud_auth:
        return {
            "authenticated": True,
            "user_id": "local:dev",
            "email": "local@canopy.dev",
            "display_name": os.environ.get("CANOPY_LOCAL_USER", "Nick C."),
            "auth_provider": "local_dev"
        }

    return {
        "authenticated": False,
        "user_id": None,
        "email": None,
        "display_name": None,
        "auth_provider": None
    }

def require_authenticated_user(request: Request) -> Dict[str, Any]:
    user = extract_user_identity(request)
    if not user.get("authenticated"):
        raise HTTPException(
            status_code=401,
            detail="Authentication required to create, edit, or delete annotations. Please sign in via Cloudflare Access."
        )
    return user

@app.get("/api/me")
def get_current_user_info(request: Request):
    """Returns current user authentication state and Cloudflare ID metadata."""
    user = extract_user_identity(request)
    return {
        **user,
        "login_url": "/api/auth/login",
        "logout_url": "/cdn-cgi/access/logout"
    }

@app.get("/api/auth/login")
def login_redirect(redirect: Optional[str] = Query("/")):
    """
    Protected by Cloudflare Access in production: visiting this route triggers
    the Cloudflare Zero Trust login screen and redirects back to the workspace.
    """
    target = redirect if (redirect and redirect.startswith("/")) else "/"
    return RedirectResponse(url=target)

class CommentaryCreateRequest(BaseModel):
    target_type: str
    target_id: str
    title: str
    body_markdown: str
    author_name: Optional[str] = None
    author_tier: Optional[str] = "practitioner"
    tier: Optional[str] = None
    author_role: Optional[str] = None
    target_paragraph_start: Optional[int] = None
    target_paragraph_end: Optional[int] = None
    visibility: Optional[str] = "public"
    current_act_slug: Optional[str] = None

class CommentaryUpdateRequest(BaseModel):
    title: str
    body_markdown: str
    author_name: Optional[str] = None
    author_tier: Optional[str] = None
    tier: Optional[str] = None
    author_role: Optional[str] = None
    target_paragraph_start: Optional[int] = None
    target_paragraph_end: Optional[int] = None
    visibility: Optional[str] = "public"
    current_act_slug: Optional[str] = None

class CommentaryPreviewRequest(BaseModel):
    body_markdown: str
    current_act_slug: Optional[str] = None

@app.get("/api/cases")
def list_cases(
    q: Optional[str] = Query(None, description="Search query across case titles, citations, catchwords"),
    court: Optional[str] = Query(None, description="Filter by court or tribunal")
):
    """Returns list of ingested caselaw decisions."""
    return repo.get_cases(query=q, court=court)

@app.get("/api/cases/{case_slug}")
def get_case(case_slug: str):
    """Returns full case details with paragraph blocks, statutory citations, and multi-tier commentary."""
    case_obj = repo.get_case_by_slug(case_slug)
    if not case_obj:
        raise HTTPException(status_code=404, detail=f"Case '{case_slug}' not found")
    return case_obj

@app.get("/api/commentary")
def get_commentary(
    target_type: str,
    target_id: str,
    tier: Optional[str] = Query(None),
    paragraph: Optional[int] = Query(None)
):
    """Returns multi-tier commentary items for a case or provision."""
    return repo.get_commentary(target_type=target_type, target_id=target_id, tier=tier, paragraph=paragraph)

@app.get("/api/commentary/{target_type}/{target_id:path}")
def get_commentary_by_path(
    target_type: str,
    target_id: str,
    tier: Optional[str] = Query(None),
    paragraph: Optional[int] = Query(None)
):
    """Returns commentary records grouped per Rule 5.1."""
    return repo.get_commentary(target_type=target_type, target_id=target_id, tier=tier, paragraph=paragraph)

@app.post("/api/commentary")
def create_commentary(req: CommentaryCreateRequest, request: Request):
    """Submits a new commentary entry (requires authenticated user)."""
    user = require_authenticated_user(request)
    effective_tier = req.author_tier or req.tier or "practitioner"
    effective_author_name = (req.author_name or "").strip() or user.get("display_name") or "Practitioner Note"
    return repo.add_commentary(
        target_type=req.target_type,
        target_id=req.target_id,
        title=req.title,
        body_markdown=req.body_markdown,
        author_name=effective_author_name,
        author_tier=effective_tier,
        author_id=user["user_id"],
        author_role=req.author_role,
        target_paragraph_start=req.target_paragraph_start,
        target_paragraph_end=req.target_paragraph_end,
        visibility=req.visibility or "public",
        current_act_slug=req.current_act_slug
    )

@app.put("/api/commentary/{comment_id}")
def update_commentary(comment_id: str, req: CommentaryUpdateRequest, request: Request):
    """Updates an existing commentary entry and recompiles cross-citations (requires authenticated user)."""
    user = require_authenticated_user(request)
    effective_tier = req.author_tier or req.tier
    updated = repo.update_commentary(
        comment_id=comment_id,
        title=req.title,
        body_markdown=req.body_markdown,
        author_name=(req.author_name or "").strip() or None,
        author_tier=effective_tier,
        author_id=user["user_id"],
        author_role=req.author_role,
        target_paragraph_start=req.target_paragraph_start,
        target_paragraph_end=req.target_paragraph_end,
        visibility=req.visibility,
        current_act_slug=req.current_act_slug
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Commentary not found")
    return updated

@app.post("/api/commentary/preview")
def preview_commentary(req: CommentaryPreviewRequest):
    """Compiles live preview HTML and extracts citations for the authoring modal."""
    from .citation_lexer import CitationLexer
    lexer = CitationLexer()
    body_html, citations = lexer.compile_html(req.body_markdown, req.current_act_slug)
    return {"body_html": body_html, "citations": citations}

@app.delete("/api/commentary/{comment_id}")
def delete_commentary(comment_id: str, request: Request):
    """Soft-deletes a commentary entry from data/annotations.db (requires authenticated user)."""
    require_authenticated_user(request)
    success = repo.delete_commentary(comment_id)
    if not success:
        raise HTTPException(status_code=404, detail="Commentary not found")
    return {"deleted": True, "id": comment_id}

# Mount static files
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/")
def serve_index():
    return FileResponse(os.path.join(static_dir, "index.html"))

@app.get("/{full_path:path}")
def catch_all(full_path: str):
    # If file exists in static, serve it; otherwise serve index.html for SPA hash routing
    target = os.path.join(static_dir, full_path)
    if os.path.exists(target) and os.path.isfile(target):
        return FileResponse(target)
    return FileResponse(os.path.join(static_dir, "index.html"))
