/* signal — la map des comptes. Données : graph.json de la branche claude/map-data.
   Tout le texte qui vient des données (bios, one-liners…) passe par textContent : jamais d'innerHTML. */
(() => {
  "use strict";

  const DEFAULT_DATA =
    "https://raw.githubusercontent.com/paulvln1/twitter-monitoring/claude/map-data/graph/graph.json";
  const DATA_URL = new URLSearchParams(location.search).get("data") || DEFAULT_DATA;
  const NEW_DAYS = 7;

  const $ = (id) => document.getElementById(id);
  const svg = d3.select("#graph");
  let G = null;            // graph.json
  let byId = new Map();    // id -> node
  let selected = null;
  let zoom, view, sim;
  // admin : login connecté, contenu actuel de accounts.txt, confirmation de retrait en cours
  const Admin = { login: null, accounts: null, busy: false, confirm: null, error: null };

  // ---------- helpers ----------
  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }
  const fmtNum = (n) =>
    n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
    : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
  const fmtDate = (s) => (s ? s.replaceAll("-", ".") : "");
  const handleOf = (n) => n.handle || n.id;
  const isNew = (n) => {
    if (n.kind !== "candidate" || !n.since || !G) return false;
    const days = (new Date(G.as_of) - new Date(n.since)) / 864e5;
    return days >= 0 && days < NEW_DAYS;
  };
  const initials = (n) => (n.display_name || n.id).replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/)
    .filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "@";
  const radius = (n) => (n.kind === "candidate" ? 20 + 5 * Math.min(n.tweets || 1, 6) : 12);
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);
  const xUrl = (n) => `https://x.com/${encodeURIComponent(handleOf(n))}`;
  const typeLabel = { rt: "retweet", quote: "quote", reply: "reply" };

  // ---------- data ----------
  fetch(DATA_URL, { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch(() => { $("status").textContent = "The map data is not available right now."; });

  function init(data) {
    G = data;
    G.nodes.forEach((n) => byId.set(n.id, n));
    $("status").textContent = "";
    $("updated").textContent = `Updated ${fmtDate(G.as_of)}`;
    $("data-link").href = DATA_URL;
    const cands = G.nodes.filter((n) => n.kind === "candidate");
    const srcs = G.nodes.filter((n) => n.kind === "whitelist");
    $("nav-cand").textContent = `(${cands.length})`;
    $("nav-src").textContent = `(${srcs.length})`;

    renderList(cands);
    renderSources(srcs);
    renderSearch();
    renderGraph();

    const h = decodeURIComponent(location.hash.slice(1)).toLowerCase().replace(/^@/, "");
    if (byId.has(h)) select(h, true);
  }

  // ---------- graph ----------
  function renderGraph() {
    const area = $("map-area");
    const W = area.clientWidth, H = area.clientHeight;
    svg.attr("viewBox", [0, 0, W, H]);

    const nodes = G.nodes.map((n) => ({ ...n }));
    const links = G.edges.map((e) => ({ ...e }));
    const defs = svg.append("defs");
    view = svg.append("g");

    nodes.forEach((n, i) => {
      n.r = radius(n);
      n.pid = `p${i}`;
      const photo = safeUrl(n.photo);
      if (photo) {
        // on n'affiche la photo qu'une fois chargée : sinon on garde les initiales
        const img = new Image();
        img.onload = () => {
          defs.append("pattern").attr("id", n.pid).attr("patternContentUnits", "objectBoundingBox")
            .attr("width", 1).attr("height", 1)
            .append("image").attr("href", photo).attr("width", 1).attr("height", 1)
            .attr("preserveAspectRatio", "xMidYMid slice");
          const g = view.selectAll(".node").filter((d) => d.id === n.id);
          g.select(".photo").attr("fill", `url(#${n.pid})`);
          g.select(".initials").remove();
        };
        img.src = photo;
      }
    });

    sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance((l) => 70 + l.target.r * 2).strength(0.5))
      .force("charge", d3.forceManyBody().strength((d) => (d.kind === "candidate" ? -420 : -220)))
      .force("collide", d3.forceCollide((d) => d.r + 16))
      .force("x", d3.forceX(W / 2).strength(0.07 * Math.max(1, H / W)))
      .force("y", d3.forceY(H / 2).strength(0.07 * Math.max(1, W / H)))
      .stop();
    sim.tick(400);

    const edge = view.append("g").selectAll("line").data(links).join("line")
      .attr("class", "edge")
      .attr("stroke-width", (l) => 0.8 + 0.6 * Math.min(l.weight, 5));

    const node = view.append("g").selectAll("g").data(nodes, (d) => d.id).join("g")
      .attr("class", (d) => `node ${d.kind === "candidate" ? "cand" : "src"}`)
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (d) => `@${handleOf(d)}`)
      .on("click", (ev, d) => { ev.stopPropagation(); select(d.id); })
      .on("keydown", (ev, d) => { if (ev.key === "Enter") select(d.id); });

    node.append("circle").attr("class", "bg").attr("r", (d) => d.r);
    node.append("text").attr("class", "initials").text(initials);
    node.filter((d) => safeUrl(d.photo)).append("circle").attr("class", "photo")
      .attr("r", (d) => d.r).attr("fill", "none");
    node.append("circle").attr("class", "ring").attr("r", (d) => d.r);
    node.append("text").attr("class", "label").attr("y", (d) => d.r + 14).text((d) => `@${handleOf(d)}`);
    node.filter(isNew).append("text").attr("class", "new").attr("y", (d) => -d.r - 6).text("new");
    node.append("text").attr("class", "pending").attr("y", (d) => -d.r - 6).text("pending");

    function draw() {
      edge.attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y)
          .attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y);
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    }
    draw();
    sim.on("tick", draw);

    node.call(d3.drag()
      .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    zoom = d3.zoom().scaleExtent([0.35, 3]).on("zoom", (ev) => view.attr("transform", ev.transform));
    svg.call(zoom).on("dblclick.zoom", null);
    svg.on("click", () => deselect());
    fitAll(false);

    G._sim = { nodes, links, edge, node };
    markPending();
  }

  function fitAll(animate = true) {
    const { nodes } = G._sim || { nodes: sim.nodes() };
    const area = $("map-area");
    const W = area.clientWidth, H = area.clientHeight;
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const pad = 70;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const k = Math.min(1.4, W / (x1 - x0), H / (y1 - y0));
    const t = d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
    (animate ? svg.transition().duration(500) : svg).call(zoom.transform, t);
  }

  function focusNode(id) {
    const n = G._sim.nodes.find((d) => d.id === id);
    if (!n) return;
    const area = $("map-area");
    const panelW = window.innerWidth > 720 ? Math.min(380, area.clientWidth * 0.92) : 0;
    const cx = (area.clientWidth - panelW) / 2;
    const cy = window.innerWidth > 720 ? area.clientHeight / 2 : area.clientHeight * 0.3;
    const k = 1.3;
    svg.transition().duration(550).call(zoom.transform, d3.zoomIdentity.translate(cx - k * n.x, cy - k * n.y).scale(k));
  }

  function highlight(id) {
    const { edge, node } = G._sim;
    if (!id) {
      edge.classed("hl", false).classed("faded", false);
      node.classed("sel", false).classed("faded", false);
      return;
    }
    const near = new Set([id]);
    G._sim.links.forEach((l) => {
      if (l.source.id === id) near.add(l.target.id);
      if (l.target.id === id) near.add(l.source.id);
    });
    edge.classed("hl", (l) => l.source.id === id || l.target.id === id)
        .classed("faded", (l) => !(l.source.id === id || l.target.id === id));
    node.classed("sel", (d) => d.id === id).classed("faded", (d) => !near.has(d.id));
  }

  // ---------- selection & panel ----------
  function select(id, scroll = false) {
    const n = byId.get(id);
    if (!n) return;
    selected = id;
    highlight(id);
    focusNode(id);
    renderPanel(n);
    history.replaceState(null, "", `#${encodeURIComponent(handleOf(n))}`);
    if (scroll) $("map").scrollIntoView({ behavior: "smooth" });
  }

  function deselect() {
    if (!selected) return;
    selected = null;
    highlight(null);
    $("panel").hidden = true;
    history.replaceState(null, "", location.pathname + location.search);
  }

  function renderPanel(n) {
    const body = $("panel-body");
    body.replaceChildren();
    const photo = safeUrl(n.photo);

    body.append(el("div", { class: "p-head" },
      photo ? el("img", { class: "p-photo", src: photo, alt: "", onerror: (e) => e.target.remove() }) : null,
      el("div", {},
        el("div", { class: "p-name" }, n.display_name || `@${handleOf(n)}`,
          isNew(n) ? el("span", { class: "tag-new", text: "new" }) : null),
        el("div", { class: "p-handle", text: `@${handleOf(n)} · ${n.kind === "candidate" ? "discovered" : "source"}` }))));

    if (n.bio) body.append(el("p", { class: "p-bio", text: n.bio }));

    const stats = el("dl", { class: "p-stats" });
    const stat = (k, v) => stats.append(el("dt", { text: k }), el("dd", { text: v }));
    stat("Followers", fmtNum(n.followers));

    if (n.kind === "candidate") {
      stat("Tweets relayed", String(n.tweets));
      stat("On map since", fmtDate(n.since));
      body.append(stats);

      if (n.oneliner) {
        body.append(el("p", { class: "p-label", text: "Why it showed up" }),
                    el("p", { class: "p-oneliner", text: n.oneliner }));
      }
      const relays = G.edges.filter((e) => e.target === n.id)
        .sort((a, b) => b.weight - a.weight);
      body.append(el("p", { class: "p-label", text: `Relayed by (${relays.length})` }),
        el("ul", { class: "p-list" }, ...relays.map((e) => el("li", {},
          el("button", { type: "button", text: `@${handleOf(byId.get(e.source) || { id: e.source })}`, onclick: () => select(e.source) }),
          el("span", { class: "t", text: e.types.map((t) => typeLabel[t] || t).join(" · ") + (e.weight > 1 ? ` ×${e.weight}` : "") })))));

      const tweetUrl = safeUrl(n.latest && n.latest.tweet_url);
      const box = el("div", { class: "p-embed" });
      body.append(el("p", { class: "p-label", text: "Latest relayed tweet" }), box);
      if (tweetUrl) embedTweet(tweetUrl, box);
      else box.append(el("p", { class: "tiny", text: "No preview for this one (imported from an early digest)." }));
    } else {
      const found = G.edges.filter((e) => e.source === n.id).map((e) => byId.get(e.target)).filter(Boolean);
      stat("Discoveries", String(found.length));
      body.append(stats);
      body.append(el("p", { class: "p-label", text: "Discoveries" }));
      if (found.length) {
        body.append(el("ul", { class: "p-list" }, ...found.map((c) => el("li", {},
          el("button", { type: "button", text: `@${handleOf(c)}`, onclick: () => select(c.id) }),
          el("span", { class: "t", text: `${c.tweets} tweets` })))));
      } else {
        body.append(el("p", { class: "tiny", text: "Nobody on the map yet." }));
      }
    }

    body.append(el("a", { class: "p-open blue", href: xUrl(n), target: "_blank", rel: "noopener", text: "↘ Open on X" }));
    renderAdmin(n, body);
    $("panel").hidden = false;
    $("panel").scrollTop = 0;
  }

  // ---------- watchlist (admin) ----------
  // "add" : candidat déjà ajouté à accounts.txt, "remove" : source déjà retirée. Visible au prochain run.
  function pending(n) {
    if (!Admin.accounts) return null;
    const inFile = Admin.accounts.has(n.id);
    if (n.kind === "candidate" && inFile) return "add";
    if (n.kind === "whitelist" && !inFile) return "remove";
    return null;
  }

  function markPending() {
    if (!G || !G._sim) return;
    const { node } = G._sim;
    node.select(".pending").attr("display", (d) => (pending(d) ? null : "none"));
    node.select(".new").attr("display", (d) => (pending(d) ? "none" : null));
  }

  function renderAdmin(n, body) {
    if (!Admin.login || !Admin.accounts) return;
    const box = el("div", { class: "p-admin" }, el("p", { class: "p-label", text: "Watchlist" }));
    const h = `@${handleOf(n)}`;
    const p = pending(n);
    if (p) {
      box.append(el("p", { class: "p-note", text: p === "add"
        ? `${h} is in the watchlist. It becomes a source at the next run.`
        : `${h} was removed from the watchlist. It leaves the sources at the next run.` }));
    } else if (n.kind === "candidate") {
      box.append(el("button", { type: "button", class: "btn blue", disabled: Admin.busy ? "" : null,
        text: Admin.busy ? "Adding…" : "+ Add to watchlist", onclick: () => edit("add", n) }));
    } else if (Admin.confirm === n.id) {
      box.append(el("p", { class: "p-note", text: `Remove ${h} from the watchlist?` }),
        el("div", { class: "btn-row" },
          el("button", { type: "button", class: "btn", disabled: Admin.busy ? "" : null,
            text: Admin.busy ? "Removing…" : "Confirm", onclick: () => edit("remove", n) }),
          el("button", { type: "button", class: "btn ghost", text: "Cancel",
            onclick: () => { Admin.confirm = null; renderPanel(n); } })));
    } else {
      box.append(el("button", { type: "button", class: "btn ghost", text: "Remove from watchlist",
        onclick: () => { Admin.confirm = n.id; Admin.error = null; renderPanel(n); } }));
    }
    if (Admin.error) box.append(el("p", { class: "p-note err", text: Admin.error }));
    body.append(box);
  }

  async function edit(action, n) {
    if (Admin.busy) return;
    Admin.busy = true; Admin.error = null;
    renderPanel(n);
    try {
      const r = await fetch("/api/watchlist", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, handle: handleOf(n) }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `error ${r.status}`);
      Admin.accounts = new Set(data.accounts.map((a) => a.toLowerCase()));
      Admin.confirm = null;
    } catch (e) {
      Admin.error = r401(e) ? "Your session has expired. Log in again." : `Could not save: ${e.message}.`;
    } finally {
      Admin.busy = false;
      markPending();
      if (selected === n.id) renderPanel(n);
    }
  }
  const r401 = (e) => /not signed in/.test(e.message);

  function renderAuth() {
    const box = $("auth");
    if (Admin.login) {
      box.replaceChildren(el("span", { text: `@${Admin.login}` }), el("span", { class: "sep", text: "·" }),
        el("button", { type: "button", class: "linkish blue", text: "Log out", onclick: logout }));
    } else {
      box.replaceChildren(el("a", { class: "blue", href: "/api/login", text: "Log in" }));
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    Admin.login = null; Admin.accounts = null; Admin.confirm = null;
    renderAuth(); markPending();
    if (selected) renderPanel(byId.get(selected));
  }

  async function initAuth() {
    const q = new URLSearchParams(location.search).get("login");
    if (q) {
      $("auth").replaceChildren(el("span", { text: q === "denied" ? "Access denied" : "Login failed" }));
      history.replaceState(null, "", location.pathname + location.hash);
      setTimeout(renderAuth, 4000);
    }
    try {
      const me = await fetch("/api/me", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : {}));
      if (!me.login) return;
      Admin.login = me.login;
      renderAuth();
      const w = await fetch("/api/watchlist", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null));
      if (w && Array.isArray(w.accounts)) {
        Admin.accounts = new Set(w.accounts.map((a) => a.toLowerCase()));
        markPending();
        if (selected) renderPanel(byId.get(selected));
      }
    } catch { /* pas d'API (aperçu local) : le site reste en lecture seule */ }
  }
  initAuth();

  // Embed officiel X, chargé à la demande
  let widgets = null;
  function loadWidgets() {
    if (!widgets) {
      widgets = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://platform.twitter.com/widgets.js";
        s.async = true;
        s.onload = () => (window.twttr && twttr.widgets ? resolve(twttr) : reject());
        s.onerror = reject;
        document.head.append(s);
      });
    }
    return widgets;
  }
  function embedTweet(url, box) {
    const m = url.match(/status\/(\d+)/);
    const fallback = () => box.replaceChildren(
      el("a", { class: "blue", href: url, target: "_blank", rel: "noopener", text: "↘ View the tweet on X" }));
    if (!m) return fallback();
    box.append(el("p", { class: "tiny", text: "Loading tweet…" }));
    loadWidgets()
      .then((tw) => tw.widgets.createTweet(m[1], box, { dnt: true, theme: "light", conversation: "none", align: "left" }))
      .then((node) => { box.querySelector(".tiny")?.remove(); if (!node) fallback(); })
      .catch(fallback);
  }

  // ---------- lists ----------
  function renderList(cands) {
    const list = $("cand-list");
    const sorted = [...cands].sort((a, b) =>
      (b.latest?.date || "").localeCompare(a.latest?.date || "") || b.tweets - a.tweets);
    if (!sorted.length) {
      list.append(el("li", { class: "empty", text: "Nobody has made it onto the map yet." }));
      return;
    }
    for (const n of sorted) {
      const by = n.relayed_by.map((h) => `@${handleOf(byId.get(h) || { id: h })}`).join(", ");
      list.append(el("li", { onclick: () => select(n.id, true) },
        el("span", { class: "r-tag", text: isNew(n) ? "“new”" : "" }),
        el("span", { class: "r-date", text: fmtDate(n.latest?.date) }),
        el("div", {},
          el("div", { class: "r-handle" }, `@${handleOf(n)} `,
            n.display_name ? el("span", { class: "r-name", text: `— ${n.display_name}` }) : null),
          n.oneliner ? el("p", { class: "r-line", text: n.oneliner }) : null,
          el("div", { class: "r-meta" },
            `${n.tweets} tweets relayed · by ${by} · ${fmtNum(n.followers)} followers`,
            el("a", { href: xUrl(n), target: "_blank", rel: "noopener", text: "↘ Open on X",
                      onclick: (e) => e.stopPropagation() })))));
    }
  }

  function renderSources(srcs) {
    const counts = new Map();
    G.edges.forEach((e) => counts.set(e.source, (counts.get(e.source) || 0) + 1));
    const sorted = [...srcs].sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || a.id.localeCompare(b.id));
    $("src-list").append(...sorted.map((n) => el("li", {},
      el("button", { type: "button", text: `@${handleOf(n)}`, onclick: () => select(n.id, true) }),
      counts.get(n.id) ? el("span", { class: "n", text: `→ ${counts.get(n.id)}` }) : null)));
  }

  function renderSearch() {
    $("handles").append(...G.nodes.map((n) => el("option", { value: `@${handleOf(n)}` })));
    const go = () => {
      const q = $("q").value.trim().toLowerCase().replace(/^@/, "");
      if (!q) return;
      const hit = byId.get(q) || G.nodes.find((n) => n.id.startsWith(q) ||
        (n.display_name || "").toLowerCase().includes(q));
      if (hit) { select(hit.id); $("q").blur(); }
    };
    $("search").addEventListener("submit", (e) => { e.preventDefault(); go(); });
    $("q").addEventListener("change", go);
  }

  // ---------- global events ----------
  $("close").addEventListener("click", deselect);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") deselect(); });
  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (!G) return;
      const area = $("map-area");
      svg.attr("viewBox", [0, 0, area.clientWidth, area.clientHeight]);
      selected ? focusNode(selected) : fitAll(false);
    }, 150);
  });
})();
