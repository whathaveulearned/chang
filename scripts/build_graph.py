#!/usr/bin/env python3
"""Rich knowledge-graph builder for the star-map website.

Reads the source wiki (markdown + frontmatter) and emits a dense, typed graph
to public/data/graph.json. Far richer than wiki_index.py's _index.json:

  - Promotes frequently-referenced-but-pageless names (克尔凯郭尔, 黑格尔 …)
    to first-class "ghost" nodes so the philosophy backbone actually forms.
  - Uses `related:` frontmatter as a curated, bidirectional edge layer.
  - Adds shared-tag associative edges for specific (rare) tags, surfacing
    latent structure between pages that never link directly.
  - Carries each node's summary/description, tags, domain, judgment so the
    detail panel shows real content instead of a file path.
  - Typed, weighted edges: related | link | source | tag.

Usage:
  python scripts/build_graph.py [WIKI_DIR]
  (defaults to ../chang-wiki/wiki relative to this repo)
"""

import json
import re
import sys
from collections import Counter, defaultdict
from typing import Optional
from datetime import datetime
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parent.parent
DEFAULT_WIKI = REPO.parent / "chang-wiki" / "wiki"
OUT = REPO / "public" / "data" / "graph.json"

EXCLUDED_FILES = {
    "_schema.md", "_log.md", "_index.json", "overview.md", "inbox-digest.md",
    "inbox-archive.md", "_attention.md", "_protocols.md", "_template.md",
}
EXCLUDED_DIRS = {"raw", "_template"}

FM_RE = re.compile(r"\A(?:﻿)?---\r?\n(.*?)\r?\n---", re.DOTALL)

CENTER_TITLE = "常天喆"

# Ghost promotion: a [[name]] with no page, referenced by at least this many
# distinct pages, becomes its own node.
GHOST_MIN_REFS = 2

# Shared-tag edges: only tags appearing on this many pages (inclusive) are
# specific enough to imply a real association. Generic tags (1 page = useless,
# 7+ pages = too broad) are skipped.
TAG_MIN_PAGES = 2
TAG_MAX_PAGES = 6

# Names that look like people, so ghosts get a sensible type. Everything else
# defaults to a concept. Tuned for this wiki's content.
KNOWN_PEOPLE = {
    "克尔凯郭尔", "黑格尔", "海德格尔", "马克思", "谢林", "阿伦特", "卡夫卡",
    "列奥·施特劳斯", "矣晓沅", "谢幸", "尼采", "萨特", "胡塞尔", "康德",
    "弗洛伊德", "荣格", "拉康", "福柯", "庄子", "叔本华", "维特根斯坦",
    "索绪尔", "克里斯特娃", "阿奎那", "安瑟伦", "笛卡尔", "边沁", "莱维纳斯",
}


def parse_scalar(v: str):
    return v.strip().strip("'\"")


def parse_frontmatter(content: str) -> dict:
    m = FM_RE.match(content)
    if not m:
        return {}
    out, cur = {}, None
    for raw in m.group(1).splitlines():
        line = raw.rstrip()
        st = line.strip()
        if not st or st.startswith("#"):
            continue
        if cur and line[:1].isspace() and st.startswith("- ") and isinstance(out.get(cur), list):
            out[cur].append(parse_scalar(st[2:]))
            continue
        cur = None
        k, sep, v = line.partition(":")
        if not sep:
            continue
        k, v = k.strip(), v.strip()
        if not v:
            out[k] = []
            cur = k
            continue
        if v.startswith("[") and v.endswith("]"):
            # Lists may be plain `[a, b]` or wikilink lists in the wild form
            # `[[a], [b], [c]]` (first item double-bracketed, rest single).
            # Strip every bracket, then split — robust to both shapes.
            cleaned = v.replace("[", "").replace("]", "")
            out[k] = [
                parse_scalar(x).split("|")[0].strip()
                for x in cleaned.split(",")
                if x.strip()
            ]
            continue
        out[k] = parse_scalar(v)
    return out


def extract_wikilinks(content: str) -> list[str]:
    content = re.sub(r"```[\s\S]*?```", "", content)
    content = re.sub(r"`[^`\n]*`", "", content)
    return re.findall(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", content)


def normalize(t: str) -> str:
    return t.strip().replace("\\", "/").removesuffix(".md").strip("/")


def extract_description(content: str) -> str:
    """First substantive paragraph after the title or a known section."""
    body = FM_RE.sub("", content)
    # strip first H1
    body = re.sub(r"^\s*#\s+.*$", "", body, count=1, flags=re.MULTILINE)
    for para in body.split("\n\n"):
        p = para.strip()
        if not p:
            continue
        if p.startswith("#") or p.startswith("|") or p.startswith("-") or p.startswith(">"):
            continue
        # strip markdown emphasis + wikilink brackets for clean prose
        p = re.sub(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", r"\1", p)
        p = re.sub(r"\*\*([^*]+)\*\*", r"\1", p)
        p = p.replace("`", "").strip()
        if len(p) >= 12:
            return p[:240]
    return ""


def clean_title(title: str) -> str:
    """Strip decorative brackets and a leading personal-name prefix so labels
    read clean (e.g. 【哲学评鉴】X → X, 常天喆-个人简历 → 个人简历)."""
    t = re.sub(r"【[^】]*】", "", title)
    t = re.sub(r"^\s*\[[^\]]*\]\s*", "", t)
    # drop a leading "常天喆" prefix on derived/source titles, never on the
    # bare center node itself (handled by the `or title` fallback)
    stripped = re.sub(r"^常天喆[\s·\-—–_、:：]+", "", t).strip()
    t = stripped or t.strip()
    return t or title


# Node types whose labels reveal private/raw material and should stay hidden
# in the ambient (zoomed-out) view.
PRIVATE_TYPES = {"source", "source-summary", "timeline"}


def short_title(title: str) -> str:
    """A graph-legible display name: cut a long descriptive title at its first
    structural break (： — 、, etc.) and keep the meaningful head."""
    t = title.strip()
    if len(t) <= 14:
        return t
    for sep in ["——", "：", ":", "—", "·", "，", ",", " "]:
        if sep in t:
            head = t.split(sep)[0].strip()
            if 2 <= len(head) <= 16:
                return head
    return t[:14] + "…"


def page_aliases(path: str, title: str) -> set[str]:
    pp = PurePosixPath(path)
    aliases = {normalize(pp.with_suffix("").as_posix()), normalize(pp.stem), normalize(title)}
    if pp.name in {"profile.md", "tracker.md", "notes.md"}:
        aliases.add(normalize(pp.parent.name))
        aliases.add(normalize(pp.parent.as_posix()))
    return {a for a in aliases if a}


def main():
    wiki = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_WIKI
    if not wiki.exists():
        print(f"ERROR: wiki dir not found: {wiki}", file=sys.stderr)
        sys.exit(1)

    pages = []
    for p in sorted(wiki.rglob("*.md")):
        rel = p.relative_to(wiki)
        if p.name in EXCLUDED_FILES:
            continue
        if any(part in EXCLUDED_DIRS for part in rel.parts):
            continue
        if "EXAMPLE" in str(rel):
            continue
        content = p.read_text(encoding="utf-8-sig")
        fm = parse_frontmatter(content)
        path = str(rel).replace("\\", "/")
        title = str(fm.get("title") or rel.stem)
        if title in {"profile", "tracker", "notes"}:
            title = rel.parent.name
        pages.append({
            "path": path,
            "title": title,
            "type": fm.get("type", "unknown"),
            "domain": fm.get("domain") or [],
            "tags": fm.get("tags") or [],
            "aliases": fm.get("aliases") or [],
            "related": fm.get("related") or [],
            "judgment": fm.get("judgment", ""),
            "confidence": fm.get("confidence", "unknown"),
            "updated": fm.get("updated", ""),
            "created": fm.get("created", ""),
            "summary": str(fm.get("summary") or "") or extract_description(content),
            "label": str(fm.get("label") or ""),
            "en": str(fm.get("en") or ""),
            "featured": str(fm.get("featured") or "").lower() == "true",
            "body_links": extract_wikilinks(content),
        })

    # ---- alias → path lookup ----
    lookup = defaultdict(set)
    for pg in pages:
        for a in page_aliases(pg["path"], pg["title"]):
            lookup[a.lower()].add(pg["path"])
        for al in pg["aliases"]:
            lookup[normalize(al).lower()].add(pg["path"])

    def resolve(link: str) -> Optional[str]:
        hits = sorted(lookup.get(normalize(link).lower(), set()))
        return hits[0] if hits else None

    # ---- ghost promotion ----
    ghost_refs = defaultdict(set)
    for pg in pages:
        names = set(pg["body_links"]) | set(pg["related"])
        for name in names:
            if name.endswith(".md") or "/" in name:
                continue
            if resolve(name):
                continue
            ghost_refs[normalize(name)].add(pg["path"])

    ghosts = {}
    for name, refs in ghost_refs.items():
        if len(refs) < GHOST_MIN_REFS:
            continue
        gid = f"ghost:{name}"
        ghosts[name] = gid
        lookup[name.lower()].add(gid)
        is_person = name in KNOWN_PEOPLE
        pages.append({
            "path": gid,
            "title": name,
            "type": "entity" if is_person else "concept",
            "domain": [],
            "tags": [],
            "aliases": [],
            "related": [],
            "judgment": "",
            "confidence": "ghost",
            "updated": "",
            "created": "",
            "summary": "",
            "body_links": [],
            "ghost": True,
        })

    path_set = {pg["path"] for pg in pages}

    # ---- edges (typed, weighted, deduped) ----
    edges = {}

    def add_edge(a, b, kind, w):
        if a == b or a not in path_set or b not in path_set:
            return
        key = (a, b) if a < b else (b, a)
        e = edges.get(key)
        if e is None:
            edges[key] = {"source": key[0], "target": key[1], "weight": w, "kinds": {kind}}
        else:
            e["weight"] += w
            e["kinds"].add(kind)

    for pg in pages:
        if pg.get("ghost"):
            continue
        # related frontmatter — curated backbone, strongest
        for name in pg["related"]:
            tgt = resolve(name)
            if tgt:
                add_edge(pg["path"], tgt, "related", 2.5)
        # body wikilinks
        for name in pg["body_links"]:
            tgt = resolve(name)
            if tgt:
                kind = "source" if "sources/" in tgt or "sources/" in pg["path"] else "link"
                add_edge(pg["path"], tgt, kind, 1.0)

    # shared-tag associative edges
    tag_pages = defaultdict(list)
    for pg in pages:
        for t in pg["tags"]:
            tag_pages[t].append(pg["path"])
    for tag, plist in tag_pages.items():
        n = len(set(plist))
        if not (TAG_MIN_PAGES <= n <= TAG_MAX_PAGES):
            continue
        uniq = sorted(set(plist))
        # rarer tags imply stronger association
        w = 0.9 if n <= 3 else 0.55
        for i in range(len(uniq)):
            for j in range(i + 1, len(uniq)):
                add_edge(uniq[i], uniq[j], "tag", w)

    # ---- degree + prune isolated ----
    degree = Counter()
    for e in edges.values():
        degree[e["source"]] += 1
        degree[e["target"]] += 1
    kept = [pg for pg in pages if degree[pg["path"]] > 0]
    kept_ids = {pg["path"] for pg in kept}
    links = [
        {"source": e["source"], "target": e["target"],
         "weight": round(e["weight"], 2), "kinds": sorted(e["kinds"])}
        for e in edges.values()
        if e["source"] in kept_ids and e["target"] in kept_ids
    ]

    nodes = []
    for pg in kept:
        is_center = pg["title"] == CENTER_TITLE
        # display name: explicit label > center's own name > shortened clean title
        if pg.get("label"):
            disp = pg["label"]
        elif is_center:
            disp = pg["title"]
        else:
            disp = short_title(clean_title(pg["title"]))
        nodes.append({
            "id": pg["path"],
            "title": disp,
            "type": pg["type"],
            "domain": pg["domain"],
            "tags": pg["tags"],
            "judgment": pg["judgment"],
            "confidence": pg["confidence"],
            "updated": pg["updated"],
            "summary": pg["summary"],
            "degree": degree[pg["path"]],
            "ghost": pg.get("ghost", False),
            # private = don't surface its label in the ambient view
            "private": pg["type"] in PRIVATE_TYPES,
            "en": pg.get("en", ""),
            "featured": pg.get("featured", False),
        })

    out = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "node_count": len(nodes),
        "edge_count": len(links),
        "ghost_count": sum(1 for n in nodes if n["ghost"]),
        "nodes": nodes,
        "links": links,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    kinds = Counter()
    for l in links:
        for k in l["kinds"]:
            kinds[k] += 1
    print(f"nodes: {len(nodes)} (ghosts: {out['ghost_count']})  edges: {len(links)}")
    print("edge kinds:", dict(kinds))
    print(f"wrote {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
