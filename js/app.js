(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────
  var SUPABASE_URL  = "https://gstthezgniwvqqsqpcjf.supabase.co";
  var SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzdHRoZXpnbml3dnFxc3FwY2pmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5ODQ5MDksImV4cCI6MjEwNTU2MDkwOX0.hyNq4XX3DFZOBUmrAHwinHWboY1OTQNjKXveviHTJws";

  var db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // Used to work out which city VC is in from his phone's location (radius in km).
  var CITY_FENCES = [
    { city: "Mumbai",   lat: 19.0760, lon:   72.8777, km: 100 },
    { city: "Delhi",    lat: 28.6139, lon:   77.2090, km: 100 },
    { city: "Bay Area", lat: 37.4530, lon: -122.1817, km: 100 }
  ];

  var CONTACT_FIELDS =
    "id,full_name,surname,firstname,organisation,designation,phone,email,bio_context," +
    "photo_filename,genre,subgenre,location,has_vc_met,how_message_goes,recency_score,last_met_date";

  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  // ── State ────────────────────────────────────────────────
  var currentCategory   = null;  // { id, name, slug }
  var currentContacts   = [];    // contacts for open category (unsorted)
  var allContacts       = {};    // id -> contact, every contact (used for cross-category suggestions)
  var venues            = {};    // city -> venue name
  var vapidPublic       = null;
  var vcCity            = null;
  var selectedIds       = new Set();
  var checkboxMode      = false;
  var searchQuery       = "";
  var sortMode          = "default";
  var inviteMeta        = null;  // set when the draft was opened from a nudge
  var inviteFrom        = "list";
  var suggestions       = [];    // [{ c, via, rank, shared }]
  var suggestExpanded   = false;
  var suggestSeq        = 0;
  var suggestTimer      = null;
  var pendingDeepLink   = null;
  var appReady          = false;

  // ── Helpers ──────────────────────────────────────────────
  var PLACEHOLDER_SVG =
    '<svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.9-2.2 4.9-4.9S14.7 2.2 12' +
    ' 2.2 7.1 4.4 7.1 7.1 9.3 12 12 12zm0 2.4c-3.3 0-9.8 1.6-9.8 4.9v2.5h19.6v-2.5c0-3.3-6.5-4.9-9.8-4.9z"/></svg>';

  function esc(str) {
    if (str == null) return "";
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function show(id)   { document.getElementById(id).hidden = false; }
  function hide(id)   { document.getElementById(id).hidden = true; }
  function el(id)     { return document.getElementById(id); }
  function setHTML(id, html) { document.getElementById(id).innerHTML = html; }

  function formatDate(iso) {            // "2026-10-12" -> "12 Oct 2026"
    if (!iso) return "";
    var p = String(iso).split("-");
    if (p.length < 3) return String(iso);
    return parseInt(p[2], 10) + " " + MONTHS[parseInt(p[1], 10) - 1] + " " + p[0];
  }
  function dayLabel(d) { return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]; }
  function nextDatesText() {            // "Fri 16 Oct or Sat 17 Oct"
    var a = new Date(); a.setDate(a.getDate() + 1);
    var b = new Date(); b.setDate(b.getDate() + 2);
    return dayLabel(a) + " or " + dayLabel(b);
  }

  // ── Layer navigation ─────────────────────────────────────
  var LAYERS = ["layer-login", "layer-home", "layer-list", "layer-invite", "layer-nudges"];
  function showLayer(id) {
    LAYERS.forEach(function (l) { el(l).hidden = (l !== id); });
  }

  function goLogin() {
    showLayer("layer-login");
  }
  function goHome() {
    showLayer("layer-home");
    inviteMeta = null;
    resetCheckbox();
  }
  function goList(cat) {
    currentCategory = cat;
    inviteMeta = null;
    selectedIds.clear();
    searchQuery = "";
    sortMode = "default";
    el("list-search").value = "";
    el("sort-select").value = "default";
    showLayer("layer-list");
    el("list-title").textContent = cat.name;
    el("list-sub").textContent   = "Loading…";
    setHTML("card-list", '<div class="spinner-wrap">Loading contacts…</div>');
    resetCheckbox();
    loadContacts(cat.id);
  }
  function goInvite(from) {
    inviteFrom = from || "list";
    showLayer("layer-invite");
    renderInvite();
    refreshSuggestions();
  }
  function goNudges() {
    showLayer("layer-nudges");
    renderNudges();
  }

  // ── Auth ─────────────────────────────────────────────────
  el("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = el("login-email").value.trim();
    var pass  = el("login-password").value;
    var btn   = el("login-btn");
    var errEl = el("login-error");
    btn.disabled = true; btn.textContent = "Signing in…";
    errEl.hidden = true;
    db.auth.signInWithPassword({ email: email, password: pass })
      .then(function (res) {
        if (res.error) throw res.error;
        btn.disabled = false; btn.textContent = "Sign in";
        startApp();
      })
      .catch(function (err) {
        errEl.textContent = err.message || "Sign-in failed. Check your credentials.";
        errEl.hidden = false;
        btn.disabled = false; btn.textContent = "Sign in";
      });
  });

  el("sign-out-btn").addEventListener("click", function () {
    db.auth.signOut().then(function () {
      appReady = false;
      selectedIds.clear();
      goLogin();
    });
  });

  // ── App startup ──────────────────────────────────────────
  function startApp() {
    goHome();
    setHTML("category-list", '<div class="spinner-wrap">Loading…</div>');
    db.from("categories")
      .select("id, name, slug, display_order")
      .order("display_order")
      .then(function (res) {
        if (res.error) { console.error(res.error); return; }
        renderCategories(res.data);
      });
    loadReference().then(function () {
      appReady = true;
      runPendingDeepLink();
      reportLocationIfVcPhone();
    });
  }

  // Everything the suggestions and nudges need, loaded once per session.
  function loadReference() {
    var pC = db.from("contacts").select(CONTACT_FIELDS).limit(2000).then(function (res) {
      if (res.error) { console.error(res.error); return; }
      (res.data || []).forEach(function (c) { allContacts[c.id] = c; });
    });
    var pV = db.from("venues").select("city,venue").then(function (res) {
      if (res.error) { console.warn(res.error); return; }
      venues = {};
      (res.data || []).forEach(function (v) { venues[v.city] = v.venue; });
    });
    var pS = db.from("app_settings").select("key,value").then(function (res) {
      if (res.error) { console.warn(res.error); return; }
      (res.data || []).forEach(function (r) {
        if (r.key === "vc_city") vcCity = (r.value && r.value.city) || null;
        if (r.key === "vapid_public") vapidPublic = r.value;
      });
    });
    return Promise.all([pC, pV, pS]).catch(function (e) { console.error(e); });
  }

  // Check existing session on load
  pendingDeepLink = parseDeepLink(window.location.hash);
  db.auth.getSession().then(function (res) {
    if (res.data && res.data.session) {
      startApp();
    } else {
      goLogin();
    }
  });

  // ── Categories ───────────────────────────────────────────
  function renderCategories(cats) {
    // For each category, fetch contact count separately (simple & works with RLS)
    var countPromises = cats.map(function (c) {
      return db.from("contact_categories")
        .select("contact_id", { count: "exact", head: true })
        .eq("category_id", c.id)
        .then(function (r) { return { cat: c, count: r.count || 0 }; });
    });

    Promise.all(countPromises).then(function (results) {
      var html = results.map(function (r) {
        return (
          '<button class="category-tile" data-id="' + esc(r.cat.id) +
          '" data-slug="' + esc(r.cat.slug) +
          '" data-name="' + esc(r.cat.name) + '" type="button">' +
          '<span class="category-tile__name">' + esc(r.cat.name) + '</span>' +
          '<span class="category-tile__count">' + r.count + ' contacts</span>' +
          '<span class="category-tile__chevron" aria-hidden="true">&#8250;</span>' +
          '</button>'
        );
      }).join("");
      setHTML("category-list", html);

      document.querySelectorAll("#category-list .category-tile").forEach(function (btn) {
        btn.addEventListener("click", function () {
          goList({
            id:   btn.dataset.id,
            slug: btn.dataset.slug,
            name: btn.dataset.name,
          });
        });
      });
    });
  }

  el("nudges-tile").addEventListener("click", goNudges);

  // ── Contacts ─────────────────────────────────────────────
  function loadContacts(categoryId) {
    db.from("contact_categories")
      .select("contacts(" + CONTACT_FIELDS + ")")
      .eq("category_id", categoryId)
      .then(function (res) {
        if (res.error) { console.error(res.error); return; }
        var contacts = res.data
          .map(function (r) { return r.contacts; })
          .filter(Boolean);
        contacts.forEach(function (c) { allContacts[c.id] = c; });
        currentContacts = contacts;
        renderVisibleContacts();
      });
  }

  function cmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  function surnameKey(c) {
    var s = (c.surname || "").trim();
    if (!s || s === "." || s === "-") s = (c.firstname || c.full_name || "").trim();
    return s.toLowerCase();
  }
  function givenKey(c) { return (c.firstname || c.full_name || "").toLowerCase(); }

  function sortContacts(arr, mode) {
    var out = arr.slice();
    if (mode === "az" || mode === "za") {
      out.sort(function (a, b) {
        var r = cmp(surnameKey(a), surnameKey(b)) || cmp(givenKey(a), givenKey(b));
        return mode === "za" ? -r : r;
      });
    } else if (mode === "recent") {
      out.sort(function (a, b) {
        var x = a.last_met_date || "", y = b.last_met_date || "";
        if (x !== y) {
          if (!x) return 1;
          if (!y) return -1;
          return x < y ? 1 : -1;               // newest first
        }
        return cmp(surnameKey(a), surnameKey(b)) || cmp(givenKey(a), givenKey(b));
      });
    } else {
      out.sort(function (a, b) {
        var ga = (a.genre || "").toLowerCase();
        var gb = (b.genre || "").toLowerCase();
        if (ga !== gb) return ga < gb ? -1 : 1;
        var sa = (a.subgenre || "").toLowerCase();
        var sb = (b.subgenre || "").toLowerCase();
        if (sa !== sb) return sa < sb ? -1 : 1;
        var sna = (a.surname || a.full_name || "").toLowerCase();
        var snb = (b.surname || b.full_name || "").toLowerCase();
        if (sna !== snb) return sna < snb ? -1 : 1;
        return (a.firstname || "").toLowerCase() < (b.firstname || "").toLowerCase() ? -1 : 1;
      });
    }
    return out;
  }

  // Search-filtered, then sorted by the chosen mode. Select all acts on exactly this list.
  function visibleContacts() {
    var list = currentContacts;
    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      list = list.filter(function (c) {
        return (c.full_name || "").toLowerCase().indexOf(q) !== -1;
      });
    }
    return sortContacts(list, sortMode);
  }

  function renderVisibleContacts() {
    var list = visibleContacts();
    if (searchQuery) {
      el("list-sub").textContent = list.length + " of " + currentContacts.length + " contacts";
    } else {
      el("list-sub").textContent = currentContacts.length + " contacts";
    }
    renderContactList(list);
  }

  el("list-search").addEventListener("input", function () {
    searchQuery = el("list-search").value.trim();
    renderVisibleContacts();
    updateSelectBar(true);
  });

  el("sort-select").addEventListener("change", function () {
    sortMode = el("sort-select").value;
    renderVisibleContacts();
  });

  function renderContactList(contacts) {
    var html = "";
    var lastSection = null;

    if (sortMode === "recent" && contacts.length &&
        !contacts.some(function (c) { return c.last_met_date; })) {
      html += '<div class="spinner-wrap" style="padding:14px 0;font-size:13px;color:#aaa">' +
              'No last-met dates recorded yet, so this follows surname order.</div>';
    }

    contacts.forEach(function (c) {
      if (sortMode === "default") {
        var section = [(c.genre || ""), (c.subgenre || "")].filter(Boolean).join(" · ");
        if (section && section !== lastSection) {
          html += '<div class="section-header">' + esc(section) + '</div>';
          lastSection = section;
        }
      }
      html += cardHtml(c);
    });

    if (!html) html = '<div class="spinner-wrap" style="color:#aaa">No contacts found.</div>';
    setHTML("card-list", html);
  }

  function avatarHtml(c) {
    if (c.photo_filename) {
      // Render the img plus a hidden fallback placeholder; if the photo
      // fails to load (e.g. photos/ not deployed), swap to the placeholder
      // instead of showing a broken-image icon.
      return '<img class="avatar" src="photos/' + encodeURIComponent(c.photo_filename) + '" alt="" loading="lazy" ' +
        'onerror="this.style.display=\'none\'; this.nextElementSibling.style.display=\'flex\';">' +
        '<div class="avatar-placeholder" style="display:none">' + PLACEHOLDER_SVG + '</div>';
    }
    return '<div class="avatar-placeholder">' + PLACEHOLDER_SVG + '</div>';
  }

  function roleLine(c) {
    var parts = [];
    if (c.organisation) parts.push(c.organisation);
    if (c.designation)  parts.push(c.designation);
    return esc(parts.join(" · "));
  }

  function contactRowHtml(c) {
    var bits = [];
    if (c.phone) {
      var digits = c.phone.replace(/[^\d+]/g, "");
      bits.push('<a href="tel:' + encodeURIComponent(digits) + '">' + esc(c.phone) + '</a>');
    }
    if (c.email) {
      bits.push('<a href="mailto:' + encodeURIComponent(c.email) + '">' + esc(c.email) + '</a>');
    }
    return bits.length
      ? '<div class="card-contact">' + bits.join("") + '</div>'
      : "";
  }

  function cardHtml(c) {
    var isSelected = selectedIds.has(c.id);
    var checkHtml  = checkboxMode
      ? '<div class="card-check">' + (isSelected ? "✓" : "") + '</div>'
      : "";
    var metTag = c.has_vc_met
      ? '<span class="met-tag">Met</span>'
      : "";
    var lastMet = c.last_met_date
      ? '<span class="met-tag met-tag--date">Last met ' + esc(formatDate(c.last_met_date)) + '</span>'
      : "";
    var context = c.bio_context
      ? '<div class="card-context"><span class="card-context-label">Context</span>' + esc(c.bio_context) + '</div>'
      : "";
    var classes = "card" +
      (checkboxMode ? " selectable" : "") +
      (isSelected ? " selected" : "");

    return (
      '<article class="' + classes + '" data-id="' + esc(c.id) + '">' +
        '<div class="card-top">' +
          (checkboxMode ? checkHtml : '') +
          avatarHtml(c) +
          '<div class="card-id">' +
            '<div class="card-name">' + esc(c.full_name) + '</div>' +
            '<div class="card-role">' + roleLine(c) + '</div>' +
            metTag + lastMet +
          '</div>' +
        '</div>' +
        context +
        (checkboxMode ? '' : contactRowHtml(c)) +
      '</article>'
    );
  }

  // ── Checkbox / Select mode ───────────────────────────────
  el("select-btn").addEventListener("click", function () {
    checkboxMode = !checkboxMode;
    el("select-btn").textContent = checkboxMode ? "Cancel" : "Select";
    el("select-btn").classList.toggle("active", checkboxMode);
    selectedIds.clear();
    suggestions = [];
    updateSelectBar(true);
    renderVisibleContacts();
  });

  function resetCheckbox() {
    checkboxMode = false;
    selectedIds.clear();
    suggestions = [];
    suggestExpanded = false;
    el("select-btn").textContent = "Select";
    el("select-btn").classList.remove("active");
    hide("select-bar");
    hide("suggest-bar");
  }

  // Single delegated listener on the list container, attached once.
  // Toggles selection state directly on the clicked card without
  // re-rendering the whole list or re-binding listeners (which previously
  // caused listeners to pile up and made deselecting unreliable).
  el("card-list").addEventListener("click", function (e) {
    if (!checkboxMode) return;
    var card = e.target.closest(".card.selectable");
    if (!card) return;
    var id = card.dataset.id;
    var nowSelected = !selectedIds.has(id);
    if (nowSelected) selectedIds.add(id); else selectedIds.delete(id);
    card.classList.toggle("selected", nowSelected);
    var checkEl = card.querySelector(".card-check");
    if (checkEl) checkEl.textContent = nowSelected ? "✓" : "";
    updateSelectBar();
  });

  function updateSelectBar(skipSuggest) {
    if (!checkboxMode) {
      hide("select-bar");
      renderSuggest();
      return;
    }
    show("select-bar");
    var n = selectedIds.size;
    el("select-count").textContent = n + " selected";
    el("draft-btn").disabled = (n === 0);
    var vis = visibleContacts();
    var allSel = vis.length > 0 && vis.every(function (c) { return selectedIds.has(c.id); });
    el("select-all-btn").textContent = allSel ? "Clear all" : "Select all";
    if (!skipSuggest) scheduleSuggest(); else renderSuggest();
  }

  // Select all acts on what is currently visible (respecting search and sort).
  el("select-all-btn").addEventListener("click", function () {
    var vis = visibleContacts();
    var allSel = vis.length > 0 && vis.every(function (c) { return selectedIds.has(c.id); });
    if (allSel) {
      selectedIds.clear();
    } else {
      vis.forEach(function (c) { selectedIds.add(c.id); });
    }
    renderVisibleContacts();
    updateSelectBar();
  });

  el("draft-btn").addEventListener("click", function () { goInvite("list"); });

  // ── Connected-people suggestions ─────────────────────────
  function scheduleSuggest() {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(refreshSuggestions, 200);
  }

  function refreshSuggestions() {
    var ids = Array.from(selectedIds);
    var seq = ++suggestSeq;
    if (!ids.length) { suggestions = []; renderSuggest(); return; }
    db.rpc("connected_contacts", { p_ids: ids }).then(function (res) {
      if (seq !== suggestSeq) return;               // a newer request superseded this one
      if (res.error) {
        console.warn(res.error);
        suggestions = [];
      } else {
        suggestions = (res.data || []).map(function (r) {
          var c = allContacts[r.contact_id];
          return c ? { c: c, via: r.via, rank: r.rank, shared: r.shared } : null;
        }).filter(Boolean);
      }
      renderSuggest();
    });
  }

  function chipHtml(s) {
    var c = s.c;
    var sub = "via " + s.via + (c.organisation ? " · " + c.organisation : "");
    return '<button class="suggest-chip" type="button" data-add="' + esc(c.id) + '">' +
      '<span class="suggest-chip__text">' +
        '<span class="suggest-chip__name">' + esc(c.full_name) + '</span>' +
        '<span class="suggest-chip__via">' + esc(sub) + '</span>' +
      '</span>' +
      '<span class="suggest-chip__add" aria-hidden="true">+</span>' +
    '</button>';
  }

  function suggestMarkup(limit, label) {
    var shown = suggestExpanded ? suggestions : suggestions.slice(0, limit);
    var toggle = suggestions.length > limit
      ? '<button class="link-btn" type="button" data-act="toggle">' +
        (suggestExpanded ? "Show fewer" : "See all (" + suggestions.length + ")") + '</button>'
      : "";
    return '<div class="suggest-head"><span>' + label + '</span>' + toggle + '</div>' +
           '<div class="suggest-chips">' + shown.map(chipHtml).join("") + '</div>';
  }

  function renderSuggest() {
    // list screen strip
    var bar = el("suggest-bar");
    var onList = !el("layer-list").hidden && checkboxMode && suggestions.length > 0;
    if (onList) { bar.innerHTML = suggestMarkup(3, "Often invited together"); bar.hidden = false; }
    else { bar.hidden = true; }

    // invite screen block
    var box = document.getElementById("invite-suggest");
    if (box) {
      if (!el("layer-invite").hidden && suggestions.length > 0) {
        box.innerHTML = '<div class="invite-section-label">Also consider</div>' + suggestMarkup(3, "Connected to this list");
      } else {
        box.innerHTML = "";
      }
    }
  }

  function onSuggestClick(e) {
    var tog = e.target.closest("[data-act='toggle']");
    if (tog) { suggestExpanded = !suggestExpanded; renderSuggest(); return; }
    var chip = e.target.closest("[data-add]");
    if (!chip) return;
    selectedIds.add(chip.dataset.add);
    if (!el("layer-invite").hidden) {
      renderInvite();
      refreshSuggestions();
    } else {
      renderVisibleContacts();
      updateSelectBar();
    }
  }
  el("suggest-bar").addEventListener("click", onSuggestClick);

  // ── Invite draft ─────────────────────────────────────────
  function inviteContacts() {
    var out = [];
    var seen = {};
    // Lists keep the order the person saw on screen; nudges keep anchor first.
    if (currentCategory && !(inviteMeta && inviteMeta.order === "given")) {
      sortContacts(currentContacts, sortMode).forEach(function (c) {
        if (selectedIds.has(c.id)) { out.push(c); seen[c.id] = true; }
      });
    }
    Array.from(selectedIds).forEach(function (id) {
      var c = allContacts[id];
      if (c && !seen[id]) { out.push(c); seen[id] = true; }
    });
    return out;
  }

  function renderInvite() {
    var selected = inviteContacts();
    var n = selected.length;
    var subTail = inviteMeta ? " · from nudge" : (currentCategory ? " · " + currentCategory.name : "");
    el("invite-sub").textContent = n + (n === 1 ? " invitation" : " invitations") + subTail;

    if (!n) {
      setHTML("invite-body", '<div class="spinner-wrap" style="color:#aaa">No one selected. Go back and select contacts first.</div>');
      return;
    }

    var lines = selected.map(function (c, i) {
      var addressing = c.how_message_goes || c.full_name || "";
      var org = c.organisation ? " (" + c.organisation + ")" : "";
      return (i + 1) + ". " + addressing + org;
    });

    var message = lines.join("\n");

    var eventName = (inviteMeta && inviteMeta.eventName) || (currentCategory ? currentCategory.name : "[Event]");
    var dateText  = (inviteMeta && inviteMeta.dateText)  || "[Date]";
    var venueText = (inviteMeta && inviteMeta.venue)     || "[Venue]";
    var draftMessage =
      "Hi [Name],\n\n" +
      "Hope you're doing well. VC would love for you (and [Spouse/Partner]) to join for " + eventName +
      ", on " + dateText + " at [Time], at " + venueText + ".\n\n" +
      "Do let us know if this works for you.\n\n" +
      "Warm regards,\n[Your name]";

    var peopleRows = selected.map(function (c, i) {
      return '<div class="invite-person" data-id="' + esc(c.id) + '">' +
        '<span><span class="invite-num">' + (i + 1) + '</span><span>' + esc(c.full_name) + '</span></span>' +
        '<button class="invite-remove" type="button" aria-label="Remove">&times;</button>' +
        '</div>';
    }).join("");

    var banner = inviteMeta && inviteMeta.banner
      ? '<div class="nudge-banner"><strong>' + esc(inviteMeta.banner) + '</strong>' +
        esc(inviteMeta.bannerSub || "") + '</div>'
      : "";

    var html =
      banner +
      '<div class="invite-people" id="invite-people">' + peopleRows + '</div>' +
      '<div id="invite-suggest"></div>' +

      '<div class="invite-section-label">Guest list · ' + n + (n === 1 ? ' invitation' : ' invitations') + '</div>' +
      '<div class="invite-message-box" id="invite-text">' + esc(message) + '</div>' +
      '<button class="copy-btn" id="copy-list-btn" type="button">Copy list</button>' +
      '<p class="invite-note">Copy and paste into WhatsApp as the invite list' +
      (inviteMeta || !currentCategory ? '' : ' for ' + esc(currentCategory.name)) + '.</p>' +

      '<div class="invite-section-label">Draft message</div>' +
      '<div class="invite-message-box" id="invite-draft-text" contenteditable="true">' + esc(draftMessage) + '</div>' +
      '<button class="copy-btn" id="copy-draft-btn" type="button">Copy message</button>' +
      '<p class="invite-note">Editable template — fill in the bracketed [placeholders] before sending, or edit directly here.</p>';

    setHTML("invite-body", html);
    renderSuggest();

    el("invite-suggest").addEventListener("click", onSuggestClick);

    el("invite-people").addEventListener("click", function (e) {
      var btn = e.target.closest(".invite-remove");
      if (!btn) return;
      var row = btn.closest(".invite-person");
      var id = row.dataset.id;
      selectedIds.delete(id);
      renderInvite();
      refreshSuggestions();
    });

    function wireCopyButton(btnId, getText) {
      el(btnId).addEventListener("click", function () {
        var text = getText();
        navigator.clipboard.writeText(text).then(function () {
          var btn = el(btnId);
          var original = btn.dataset.label || btn.textContent;
          btn.dataset.label = original;
          btn.textContent = "Copied ✓";
          btn.classList.add("copied");
          setTimeout(function () {
            btn.textContent = original;
            btn.classList.remove("copied");
          }, 2000);
        }).catch(function () {
          var ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          el(btnId).textContent = "Copied ✓";
        });
      });
    }

    wireCopyButton("copy-list-btn", function () { return message; });
    wireCopyButton("copy-draft-btn", function () { return el("invite-draft-text").innerText; });
  }

  // ── Back buttons ─────────────────────────────────────────
  el("back-to-home").addEventListener("click", goHome);
  el("back-to-list").addEventListener("click", function () {
    if (inviteFrom === "list" && currentCategory) {
      showLayer("layer-list");
      updateSelectBar(true);
      renderVisibleContacts();
      refreshSuggestions();
    } else {
      selectedIds.clear();
      goHome();
    }
  });
  el("back-from-nudges").addEventListener("click", goHome);

  // ── Nudge deep links (from a notification or the Nudges screen) ──
  function parseDeepLink(hash) {
    if (!hash || hash.indexOf("#nudge?") !== 0) return null;
    var q = new URLSearchParams(hash.slice("#nudge?".length));
    var a = q.get("a");
    if (!a) return null;
    return {
      a: a,
      c: (q.get("c") || "").split(",").filter(Boolean),
      city: q.get("city") || "",
      k: q.get("k") || "recent"
    };
  }

  function runPendingDeepLink() {
    if (!pendingDeepLink) return;
    var dl = pendingDeepLink;
    pendingDeepLink = null;
    try { history.replaceState(null, "", window.location.pathname + window.location.search); } catch (e) {}
    openNudgeInvite(dl);
  }

  function openNudgeInvite(dl) {
    var ids = [dl.a].concat(dl.c).filter(function (id) { return allContacts[id]; });
    if (!ids.length) { goHome(); return; }
    selectedIds = new Set(ids);
    currentCategory = null;
    checkboxMode = false;
    var anchor = allContacts[dl.a];
    var heading = { recent: "Just met: ", reconnect: "Reconnect: ", test: "TEST nudge: " }[dl.k] || "Nudge: ";
    var venue = venues[dl.city] || "";
    inviteMeta = {
      order: "given",
      eventName: "lunch or dinner",
      dateText: nextDatesText(),
      venue: venue,
      banner: heading + (anchor ? anchor.full_name : ""),
      bannerSub: (venue ? "Suggested for " + venue + ". " : "") + "Dates, time and message below are editable."
    };
    suggestExpanded = false;
    goInvite("nudge");
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (e) {
      if (!e.data || e.data.type !== "deeplink" || !e.data.url) return;
      var i = e.data.url.indexOf("#");
      var dl = parseDeepLink(i >= 0 ? e.data.url.slice(i) : "");
      if (!dl) return;
      pendingDeepLink = dl;
      if (appReady) runPendingDeepLink();
    });
  }

  // ── VC's city (from his phone's location, or set by hand) ──
  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function nearestCity(lat, lon) {
    var best = null, bestKm = Infinity;
    CITY_FENCES.forEach(function (f) {
      var d = haversineKm(lat, lon, f.lat, f.lon);
      if (d <= f.km && d < bestKm) { best = f.city; bestKm = d; }
    });
    return best;
  }

  function saveCity(city, source) {
    var now = new Date().toISOString();
    return db.from("app_settings")
      .update({ value: { city: city || null, source: source, at: now }, updated_at: now })
      .eq("key", "vc_city")
      .then(function (res) {
        if (res.error) throw res.error;
        vcCity = city || null;
      });
  }

  function isVcPhone() {
    try { return window.localStorage.getItem("vcss_is_vc_phone") === "1"; } catch (e) { return false; }
  }

  // Only VC's own phone reports a location, so staff opening the app never move VC's city.
  function reportLocationIfVcPhone() {
    if (!isVcPhone() || !("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      var city = nearestCity(pos.coords.latitude, pos.coords.longitude);
      if (city && city !== vcCity) saveCity(city, "auto").catch(function (e) { console.warn(e); });
    }, function () { /* permission refused or no fix: keep the current city */ },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 6 * 3600 * 1000 });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && appReady) reportLocationIfVcPhone();
  });

  // ── Push notifications ───────────────────────────────────
  function pushSupported() {
    return ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);
  }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function isStandalone() {
    return window.navigator.standalone === true ||
           (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }
  function urlB64ToUint8Array(b64) {
    var pad = "=".repeat((4 - b64.length % 4) % 4);
    var raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function getPushState() {
    if (!pushSupported()) return Promise.resolve({ supported: false });
    return navigator.serviceWorker.ready
      .then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) { return { supported: true, permission: Notification.permission, sub: sub }; })
      .catch(function () { return { supported: false }; });
  }

  function deviceLabel() { return isVcPhone() ? "VC's phone" : "Staff phone"; }

  function enablePush() {
    if (!vapidPublic) return Promise.reject(new Error("Notification key is not loaded yet. Reopen the app and try again."));
    return Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") {
        throw new Error("Permission was not granted. On iPhone: Settings > Notifications > VCSS.");
      }
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      var opts = { userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidPublic) };
      return reg.pushManager.getSubscription().then(function (existing) {
        return existing || reg.pushManager.subscribe(opts);
      }).catch(function () {
        // An old subscription made with a different key: drop it and start fresh.
        return reg.pushManager.getSubscription()
          .then(function (s) { return s ? s.unsubscribe() : null; })
          .then(function () { return reg.pushManager.subscribe(opts); });
      });
    }).then(function (sub) {
      var j = sub.toJSON();
      return db.from("push_subscriptions").upsert({
        endpoint: j.endpoint, p256dh: j.keys.p256dh, auth_secret: j.keys.auth,
        label: deviceLabel(), active: true
      }, { onConflict: "endpoint" }).then(function (res) {
        if (res.error) throw res.error;
      });
    });
  }

  function disablePush() {
    return getPushState().then(function (st) {
      if (!st.sub) return null;
      var endpoint = st.sub.endpoint;
      return st.sub.unsubscribe().then(function () {
        return db.from("push_subscriptions").delete().eq("endpoint", endpoint);
      });
    });
  }

  function setStatus(node, text, kind) {
    if (!node) return;
    node.className = "status-line" + (kind === "ok" ? " status-ok" : (kind === "bad" ? " status-bad" : ""));
    node.textContent = text;
  }

  function pollPush(reqId, out, tries) {
    db.rpc("push_result", { p_request_id: reqId }).then(function (res) {
      var d = res.data;
      if (res.error || !d) { setStatus(out, "Could not read the result of the test.", "bad"); return; }
      if (d.status === "pending") {
        if (tries >= 20) { setStatus(out, "Still waiting for a result. If nothing arrives, try again in a minute.", "bad"); return; }
        setTimeout(function () { pollPush(reqId, out, tries + 1); }, 1000);
        return;
      }
      var r0 = null;
      try { r0 = JSON.parse(d.body).results[0]; } catch (e) {}
      if (d.http_status === 200 && r0 && r0.ok) {
        setStatus(out, "Sent ✓ It should appear within a few seconds. Lock the phone to see it on the lock screen, then tap it.", "ok");
      } else if (r0 && (r0.status === 404 || r0.status === 410)) {
        setStatus(out, "This phone's notification link has expired. Turn notifications off, then on again.", "bad");
      } else {
        setStatus(out, "The push service refused it" + (r0 && r0.status ? " (code " + r0.status + ")" : "") +
          ". " + ((r0 && r0.error) || d.error || ""), "bad");
      }
    });
  }

  function sendTestNotification(out) {
    setStatus(out, "Sending…", "");
    getPushState().then(function (st) {
      if (!st.sub) throw new Error("This phone is not turned on for notifications yet.");
      return db.rpc("send_test_push", { p_endpoint: st.sub.endpoint });
    }).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      var d = res.data || {};
      if (d.status !== "sent") throw new Error("Could not start the test (" + (d.status || "unknown") + ").");
      pollPush(d.request_id, out, 0);
    }).catch(function (e) { setStatus(out, e.message, "bad"); });
  }

  // ── Nudges screen ────────────────────────────────────────
  function renderNudges() {
    setHTML("nudges-body", '<div class="spinner-wrap">Loading…</div>');
    Promise.all([
      db.rpc("get_nudge"),
      db.from("nudge_log").select("sent_at,kind,title").neq("kind", "test")
        .order("sent_at", { ascending: false }).limit(3),
      getPushState()
    ]).then(function (r) { buildNudgesHtml(r[0], r[1], r[2]); });
  }

  function buildNudgesHtml(rn, rlog, st) {
    var n = rn && rn.data;
    var nextHtml;
    if (!rn || rn.error || !n) {
      nextHtml = '<p class="muted">Could not load the next nudge. Reopen this screen to try again.</p>';
    } else if (n.status === "ok") {
      nextHtml = '<h3>' + esc(n.title) + '</h3><p>' + esc(n.body) + '</p>' +
        '<button id="open-nudge-btn" class="copy-btn" type="button" data-url="' + esc(n.url) + '">Open draft invite</button>';
    } else if (n.status === "no_city") {
      nextHtml = "<p>VC's city is not set yet. Choose it below, or turn on “This is VC's phone” on his phone.</p>";
    } else if (n.status === "none") {
      nextHtml = "<p>No one is due right now. Nudges begin as soon as last-met dates are loaded.</p>";
    } else {
      nextHtml = '<p class="muted">No nudge available (' + esc(n.status) + ').</p>';
    }

    var logRows = (rlog && rlog.data && rlog.data.length)
      ? rlog.data.map(function (r) {
          return '<div class="log-row"><strong>' + esc(r.title || r.kind) + '</strong><br>' +
                 '<span class="muted">' + esc(formatDate(String(r.sent_at).slice(0, 10))) + '</span></div>';
        }).join("")
      : '<p class="muted">None sent yet.</p>';

    var cityOpts = '<option value="">Not set</option>' + Object.keys(venues).map(function (cty) {
      return '<option value="' + esc(cty) + '"' + (cty === vcCity ? " selected" : "") + '>' +
             esc(cty) + ' (' + esc(venues[cty]) + ')</option>';
    }).join("");

    var deviceHtml;
    if (!st.supported || (isIOS() && !isStandalone())) {
      deviceHtml = '<p>Notifications work from the Home Screen app. Open VCSS from its Home Screen icon (iPhone with iOS 16.4 or later).</p>';
    } else if (st.permission === "denied") {
      deviceHtml = '<p class="status-bad">Notifications are blocked for VCSS. On iPhone: Settings &gt; Notifications &gt; VCSS &gt; Allow.</p>';
    } else if (st.sub) {
      deviceHtml = '<p class="status-ok"><strong>Notifications are on for this phone ✓</strong></p>' +
        '<button id="test-push-btn" class="copy-btn" type="button">Send test notification now</button>' +
        '<button id="disable-push-btn" class="btn-secondary" type="button">Turn notifications off</button>';
    } else {
      deviceHtml = '<p>Notifications are off for this phone.</p>' +
        '<button id="enable-push-btn" class="copy-btn" type="button">Turn on notifications</button>';
    }

    var html =
      '<div class="nudge-card"><div class="invite-section-label" style="margin-top:0">Next nudge</div>' + nextHtml + '</div>' +

      '<div class="nudge-card"><div class="invite-section-label" style="margin-top:0">VC is in</div>' +
        '<select id="city-select" class="nudge-select">' + cityOpts + '</select>' +
        '<p class="muted">Sets the venue and who is suggested. VC\'s phone updates this by itself when it is opened.</p>' +
      '</div>' +

      '<div class="nudge-card"><div class="invite-section-label" style="margin-top:0">This phone</div>' +
        deviceHtml +
        '<div id="push-status" class="status-line"></div>' +
        '<label class="toggle-row"><input type="checkbox" id="vc-phone-toggle"' + (isVcPhone() ? " checked" : "") + '>' +
        '<span>This is VC\'s phone. Keeps VC\'s city up to date from this phone\'s location (asks permission once). Leave off on any other phone.</span></label>' +
      '</div>' +

      '<div class="nudge-card"><div class="invite-section-label" style="margin-top:0">Last nudges sent</div>' + logRows + '</div>' +

      '<p class="invite-note">At most one nudge every 3 days, sent around 6 am and 10 am in VC\'s city.</p>';

    setHTML("nudges-body", html);
    wireNudges();
  }

  function wireNudges() {
    var status = el("push-status");

    var openBtn = document.getElementById("open-nudge-btn");
    if (openBtn) openBtn.addEventListener("click", function () {
      var u = openBtn.dataset.url || "";
      var dl = parseDeepLink(u.slice(u.indexOf("#")));
      if (dl) openNudgeInvite(dl);
    });

    el("city-select").addEventListener("change", function (e) {
      saveCity(e.target.value, "manual").then(function () {
        setStatus(status, "VC's city saved.", "ok");
      }).catch(function (err) { setStatus(status, "Could not save: " + (err.message || err), "bad"); });
    });

    var enableBtn = document.getElementById("enable-push-btn");
    if (enableBtn) enableBtn.addEventListener("click", function () {
      enableBtn.disabled = true;
      setStatus(status, "Turning on…", "");
      enablePush().then(function () { renderNudges(); })
        .catch(function (err) { enableBtn.disabled = false; setStatus(status, err.message || String(err), "bad"); });
    });

    var testBtn = document.getElementById("test-push-btn");
    if (testBtn) testBtn.addEventListener("click", function () { sendTestNotification(status); });

    var offBtn = document.getElementById("disable-push-btn");
    if (offBtn) offBtn.addEventListener("click", function () {
      disablePush().then(function () { renderNudges(); })
        .catch(function (err) { setStatus(status, err.message || String(err), "bad"); });
    });

    el("vc-phone-toggle").addEventListener("change", function (e) {
      try { window.localStorage.setItem("vcss_is_vc_phone", e.target.checked ? "1" : "0"); } catch (x) {}
      getPushState().then(function (st) {
        if (st.sub) {
          return db.from("push_subscriptions").update({ label: deviceLabel() }).eq("endpoint", st.sub.endpoint);
        }
      });
      if (e.target.checked) reportLocationIfVcPhone();
      setStatus(status, e.target.checked ? "This phone will now keep VC's city up to date." : "This phone no longer updates VC's city.", "ok");
    });
  }

})();
