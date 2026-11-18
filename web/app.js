/* signal: the account map. Data: graph.json from the claude/map-data branch.
   Every piece of text that comes from the data (bios, one-liners...) goes through textContent, never innerHTML. */
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
  let selected = null;     // id of the node open in the panel
  let project = null;      // index of the project open in the panel
  let preview = null;      // index of the hovered project
  let zoom, view, sim;
  // admin: signed-in login, current content of watchlist.txt, pending remove confirmation
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
  const HANDLE = /^[a-z0-9_]{1,15}$/i;

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
    renderSearch();
    renderProjects();
    renderGraph();

    const h = decodeURIComponent(location.hash.slice(1)).toLowerCase().replace(/^@/, "");
    if (byId.has(h)) select(h);
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
        // only show the photo once it has loaded; until then, keep the initials
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

    const drag = d3.drag()
      .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => {
        if (!ev.active) sim.alphaTarget(0);
        if (d.pin) d.pin = { x: d.fx, y: d.fy }; else { d.fx = null; d.fy = null; }
      });
    // builds the bubbles
    const build = (enter) => {
      const g = enter.append("g")
        .attr("class", (d) => `node ${d.kind === "candidate" ? "cand" : "src"}`)
        .attr("tabindex", 0)
        .attr("role", "button")
        .attr("aria-label", (d) => `@${handleOf(d)}`)
        .on("click", (ev, d) => { ev.stopPropagation(); select(d.id); })
        .on("keydown", (ev, d) => { if (ev.key === "Enter") select(d.id); });
      g.append("circle").attr("class", "bg").attr("r", (d) => d.r);
      g.append("text").attr("class", "initials").text(initials);
      g.filter((d) => safeUrl(d.photo)).append("circle").attr("class", "photo")
        .attr("r", (d) => d.r).attr("fill", "none");
      g.append("circle").attr("class", "ring").attr("r", (d) => d.r);
      g.append("circle").attr("class", "halo").attr("r", (d) => d.r + 5);
      g.append("text").attr("class", "label").attr("y", (d) => d.r + 14).text((d) => `@${handleOf(d)}`);
      g.filter(isNew).append("text").attr("class", "new").attr("y", (d) => -d.r - 6).text("new");
      g.append("text").attr("class", "pending").attr("y", (d) => -d.r - 6).text("pending");
      g.call(drag);
      return g;
    };
    const layer = view.append("g");
    const node = layer.selectAll("g").data(nodes, (d) => d.id).join(build);

    function draw() {
      G._sim.edge.attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y)
          .attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y);
      G._sim.node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    }
    G._sim = { nodes, links, edge, node, draw, ghosts: new Map(), detached: "" };
    draw();
    sim.on("tick", draw);

    zoom = d3.zoom().scaleExtent([0.35, 3]).on("zoom", (ev) => view.attr("transform", ev.transform));
    svg.call(zoom).on("dblclick.zoom", null);
    svg.on("click", () => deselect());
    fitAll(false);
    markPending(false);
    paintProjects();
  }

  // width taken on the left by the project list (desktop)
  function leftInset() {
    const box = $("projects");
    return !box.hidden && window.innerWidth > 720 ? box.offsetLeft + box.offsetWidth : 0;
  }

  // width taken on the right by the backlog (desktop, panel closed)
  function rightInset() {
    const box = $("backlog");
    return !box.hidden && window.innerWidth > 720 && $("panel").hidden ? box.offsetWidth + 16 : 0;
  }

  function fitAll(animate = true) {
    const nodes = sim.nodes();
    if (!nodes.length) return;
    const area = $("map-area");
    const L = leftInset();
    const W = area.clientWidth - L - rightInset(), H = area.clientHeight;
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const pad = 70;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const k = Math.min(1.4, W / (x1 - x0), H / (y1 - y0));
    const t = d3.zoomIdentity.translate(L + W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
    (animate ? svg.transition().duration(500) : svg).call(zoom.transform, t);
  }

  function focusNode(id) {
    const n = sim.nodes().find((d) => d.id === id); // an account in the backlog is no longer on the map
    if (!n) return;
    const area = $("map-area");
    const panelW = window.innerWidth > 720 ? Math.min(380, area.clientWidth * 0.92) : 0;
    const cx = (leftInset() + area.clientWidth - panelW) / 2;
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
    sim.force("link").links().forEach((l) => {
      if (l.source.id === id) near.add(l.target.id);
      if (l.target.id === id) near.add(l.source.id);
    });
    edge.classed("hl", (l) => near.has(l.source.id) && near.has(l.target.id) && (l.source.id === id || l.target.id === id))
        .classed("faded", (l) => !(l.source.id === id || l.target.id === id));
    node.classed("sel", (d) => d.id === id).classed("faded", (d) => !near.has(d.id));
  }

  // ---------- selection & panel ----------
  function select(id) {
    const n = byId.get(id);
    if (!n) return;
    selected = id;
    project = null;
    paintProjects();
    const onMap = sim.nodes().includes(n);
    highlight(onMap ? id : null); // a backlog account has no bubble: leave the map as it is
    if (onMap) focusNode(id);
    renderPanel(n);
    renderBacklog();
    history.replaceState(null, "", `#${encodeURIComponent(handleOf(n))}`);
  }

  function deselect() {
    if (!selected && project == null) return;
    selected = null;
    project = null;
    paintProjects();
    highlight(null);
    $("panel").hidden = true;
    renderBacklog();
    fitAll();
    history.replaceState(null, "", location.pathname + location.search);
  }

  function renderPanel(n) {
    const body = $("panel-body");
    body.replaceChildren();
    if (n.ghost) return renderGhostPanel(n, body);
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

  function renderGhostPanel(n, body) {
    body.append(el("div", { class: "p-head" }, el("div", {},
      el("div", { class: "p-name", text: `@${n.id}` }),
      el("div", { class: "p-handle", text: "added by hand" }))));
    body.append(el("p", { class: "p-bio", text: "Not on the map yet. Its profile shows up at the next run, and its links once it relays someone." }));
    body.append(el("a", { class: "p-open blue", href: xUrl(n), target: "_blank", rel: "noopener", text: "↘ Open on X" }));
    if (!Admin.login) return;
    const box = el("div", { class: "p-admin" }, el("p", { class: "p-label", text: "Watchlist" }));
    box.append(el("button", { type: "button", class: "btn ghost", disabled: Admin.busy ? "" : null,
      text: Admin.busy ? "Removing…" : "Undo: remove from watchlist", onclick: () => edit("remove", n) }));
    if (Admin.error) box.append(el("p", { class: "p-note err", text: Admin.error }));
    body.append(box);
    $("panel").hidden = false;
    $("panel").scrollTop = 0;
  }

  // ---------- watchlist (admin) ----------
  // "add": discovered account already added to watchlist.txt; "remove": source already removed. Applied at the next run.
  function pending(n) {
    if (!Admin.accounts) return null;
    const inFile = Admin.accounts.has(n.id);
    if (n.kind === "candidate" && inFile) return "add";
    if (n.kind === "whitelist" && !inFile) return "remove";
    return null;
  }

  // Accounts in watchlist.txt that are not on the map yet (added by hand): a ghost entry, listed in the backlog.
  function syncGhosts() {
    const S = G._sim;
    const onMap = new Set(G.nodes.map((n) => n.id));
    const want = Admin.accounts ? [...Admin.accounts].filter((h) => HANDLE.test(h) && !onMap.has(h)) : [];
    const same = want.length === S.ghosts.size && want.every((h) => S.ghosts.has(h));
    if (same) return;
    for (const h of [...S.ghosts.keys()]) if (!want.includes(h)) { S.ghosts.delete(h); byId.delete(h); }
    for (const h of want) {
      if (S.ghosts.has(h)) continue;
      const n = { id: h, handle: h, kind: "candidate", ghost: true, tweets: 0 };
      S.ghosts.set(h, n);
      byId.set(h, n);
    }
  }

  // An account that was just added leaves the map (bubble and links) and moves to the backlog, on the right.
  // A removed account stays on the map, marked "pending", until the run, and is listed in the backlog too.
  function markPending(animate) {
    if (!G || !G._sim) return;
    syncGhosts();
    const { node, edge, nodes, links, draw } = G._sim;
    const isAdd = (d) => pending(d) === "add";
    node.classed("gone", isAdd);
    node.select(".pending").attr("display", (d) => (pending(d) ? null : "none"));
    node.select(".new").attr("display", (d) => (pending(d) ? "none" : null));
    renderBacklog();

    const ids = new Set(nodes.filter(isAdd).map((d) => d.id));
    const key = [...ids].sort().join(",");
    if (key === G._sim.detached) return;
    G._sim.detached = key;

    const off = (l) => ids.has(l.source.id) || ids.has(l.target.id);
    edge.classed("off", off);
    sim.nodes(nodes.filter((n) => !ids.has(n.id)));
    sim.force("link").links(links.filter((l) => !off(l)));
    const refit = () => (selected && !ids.has(selected) && byId.get(selected) && !byId.get(selected).ghost ? focusNode(selected) : fitAll(animate));
    paintProjects();
    if (animate) {
      sim.on("end.pending", () => { sim.on("end.pending", null); refit(); });
      sim.alpha(0.5).restart();
      setTimeout(refit, 80);
    } else {
      sim.tick(250);
      draw();
      refit();
    }
  }

  // ---------- backlog: what changes at the next run ----------
  function renderBacklog() {
    const box = $("backlog");
    const on = !!(Admin.login && Admin.accounts);
    box.hidden = !on;
    if (!on) return;
    const items = [];
    for (const n of byId.values()) {
      const p = n.ghost ? "add" : pending(n);
      if (p) items.push({ n, p });
    }
    items.sort((a, b) => (a.p === b.p ? handleOf(a.n).localeCompare(handleOf(b.n)) : a.p === "add" ? -1 : 1));
    const list = $("backlog-list");
    list.replaceChildren();
    if (!items.length) { list.append(el("li", { class: "empty", text: "Nothing pending." })); return; }
    for (const { n, p } of items) {
      const photo = safeUrl(n.photo);
      const pic = el("span", { class: "b-pic", text: initials(n) });
      if (photo) pic.replaceChildren(el("img", { src: photo, alt: "", onerror: (e) => e.target.remove() }));
      list.append(el("li", {}, el("button", {
        type: "button", class: selected === n.id ? "on" : null,
        onclick: (e) => { e.stopPropagation(); select(n.id); },
      }, pic, el("span", { class: "b-h", text: `@${handleOf(n)}` }),
        el("span", { class: "b-tag", text: p === "add" ? "joining" : "leaving" }))));
    }
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
      markPending(true);
    } catch (e) {
      Admin.error = r401(e) ? "Your session has expired. Log in again." : `Could not save: ${e.message}.`;
    } finally {
      Admin.busy = false;
      if (selected === n.id) byId.has(n.id) ? renderPanel(byId.get(n.id)) : deselect();
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
    $("add-wrap").hidden = !(Admin.login && Admin.accounts);
    if ($("add-wrap").hidden) openAdd(false);
    renderBacklog();
  }

  // ---------- add by hand: a button under the top bar opens a small dialog ----------
  function openAdd(open) {
    $("add-card").hidden = !open;
    $("add-open").setAttribute("aria-expanded", String(open));
    $("add-open").classList.toggle("on", open);
    if (open) { addMsg(""); $("add-input").value = ""; $("add-input").focus(); }
  }
  function addMsg(text, ok = false) {
    $("add-msg").textContent = text;
    $("add-msg").classList.toggle("ok", ok);
  }
  $("add-open").addEventListener("click", (e) => { e.stopPropagation(); openAdd($("add-card").hidden); });
  $("add-cancel").addEventListener("click", () => openAdd(false));
  $("add-card").addEventListener("click", (e) => e.stopPropagation());
  $("add-card").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); openAdd(false); } });
  $("add-form").addEventListener("submit", (e) => { e.preventDefault(); addByHand($("add-input").value); });

  async function addByHand(raw) {
    if (Admin.busy) return;
    const h = String(raw || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?#]/)[0];
    if (!h) return addMsg("Type a username first.");
    if (!HANDLE.test(h)) return addMsg("That's not a valid X username (letters, digits and _, 15 max).");
    if (Admin.accounts.has(h.toLowerCase())) return addMsg(`@${h} is already in the watchlist.`);
    const btn = $("add-submit");
    Admin.busy = true; btn.disabled = true; btn.textContent = "Adding…"; addMsg("");
    try {
      const r = await fetch("/api/watchlist", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", handle: h }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `error ${r.status}`);
      Admin.accounts = new Set(data.accounts.map((a) => a.toLowerCase()));
      Admin.busy = false;
      openAdd(false);
      markPending(true);
      select(h.toLowerCase());
    } catch (e) {
      addMsg(r401(e) ? "Your session has expired. Log in again." : `Could not save: ${e.message}.`);
    } finally {
      Admin.busy = false; btn.disabled = false; btn.textContent = "Add";
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    Admin.login = null; Admin.accounts = null; Admin.confirm = null;
    renderAuth(); markPending(true);
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
        renderAuth();
        markPending(false);
        if (selected) renderPanel(byId.get(selected));
      }
    } catch { /* no API (local preview): the site stays read-only */ }
  }
  initAuth();

  // Official X embed, loaded on demand
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

  // ---------- today's projects (the digest's "Nouveaux projets" section, in English) ----------
  const projects = () => (G && G.projects && Array.isArray(G.projects.items) ? G.projects.items : null);
  const projectAccounts = (p) => (p.accounts || []).filter((h) => byId.has(h));

  function renderProjects() {
    const items = projects();
    const box = $("projects");
    if (!items) return;
    $("projects-date").textContent = fmtDate(G.projects.date);
    const list = $("projects-list");
    if (!items.length) list.append(el("li", { class: "empty", text: "No new project today." }));
    items.forEach((p, i) => list.append(el("li", {},
      el("button", {
        type: "button", "data-i": i,
        onclick: (e) => { e.stopPropagation(); selectProject(i); },
        onmouseenter: () => { preview = i; paintProjects(); },
        onmouseleave: () => { preview = null; paintProjects(); },
        onfocus: () => { preview = i; paintProjects(); },
        onblur: () => { preview = null; paintProjects(); },
      }, el("span", { class: "n", text: String(i + 1).padStart(2, "0") }),
         el("span", { class: "title", text: p.title })))));
    if (window.innerWidth <= 720) box.open = false;
    box.hidden = false;
  }

  // green: every account behind today's projects; on hover or click, only that project's accounts.
  function paintProjects() {
    if (!G || !G._sim) return;
    const items = projects() || [];
    const { node, edge } = G._sim;
    const focus = preview != null ? preview : project;
    const lit = new Set((focus != null ? [items[focus]] : items).filter(Boolean).flatMap(projectAccounts));
    const isLit = (l) => lit.has(l.source.id) && lit.has(l.target.id);
    node.classed("lit", (d) => lit.has(d.id));
    edge.classed("lit", isLit);
    document.querySelectorAll("#projects-list button").forEach((b) =>
      b.classList.toggle("on", Number(b.dataset.i) === focus));
    if (focus != null) {
      node.classed("faded", (d) => !lit.has(d.id));
      edge.classed("faded", (l) => !isLit(l)).classed("hl", false);
      node.classed("sel", false);
    } else if (selected && sim.nodes().some((d) => d.id === selected)) {
      highlight(selected);
    } else {
      highlight(null);
    }
  }

  function selectProject(i) {
    const p = (projects() || [])[i];
    if (!p) return;
    selected = null;
    project = i;
    paintProjects();
    renderProjectPanel(p);
    history.replaceState(null, "", location.pathname + location.search);
  }

  function renderProjectPanel(p) {
    const body = $("panel-body");
    body.replaceChildren();
    body.append(el("p", { class: "p-label first", text: `New project · ${fmtDate(G.projects.date)}` }),
      el("div", { class: "p-name", text: p.title }));
    if (p.tag) body.append(el("p", { class: "p-handle", text: p.tag }));
    const parts = [["what", "What it is"], ["how", "How it works"], ["who", "Who it's for"], ["try", "Try it"]];
    for (const [k, label] of parts) {
      if (p[k]) body.append(el("p", { class: "p-label", text: label }), el("p", { class: "p-text", text: p[k] }));
    }
    const links = (p.links || []).filter((l) => safeUrl(l.url));
    if (links.length) {
      body.append(el("p", { class: "p-links" }, ...links.map((l) =>
        el("a", { class: "blue", href: l.url, target: "_blank", rel: "noopener", text: `↘ ${l.label}` }))));
    }
    const accs = projectAccounts(p).map((h) => byId.get(h));
    if (accs.length) {
      body.append(el("p", { class: "p-label", text: "On the map" }),
        el("ul", { class: "p-list" }, ...accs.map((n) => el("li", {},
          el("button", { type: "button", text: `@${handleOf(n)}`, onclick: () => select(n.id) }),
          el("span", { class: "t", text: n.id === p.author ? "posted it" : n.kind === "whitelist" ? "relayed it" : "featured" })))));
    }
    const url = safeUrl(p.tweet_url);
    if (url) body.append(el("a", { class: "p-open blue", href: url, target: "_blank", rel: "noopener", text: "↘ Open the tweet on X" }));
    $("panel").hidden = false;
    $("panel").scrollTop = 0;
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
