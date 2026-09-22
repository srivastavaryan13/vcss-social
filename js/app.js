(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────
  var SUPABASE_URL  = "https://gstthezgniwvqqsqpcjf.supabase.co";
  var SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzdHRoZXpnbml3dnFxc3FwY2pmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5ODQ5MDksImV4cCI6MjEwNTU2MDkwOX0.hyNq4XX3DFZOBUmrAHwinHWboY1OTQNjKXveviHTJws";

  var db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── State ────────────────────────────────────────────────
  var currentCategory   = null;  // { id, name, slug }
  var currentContacts   = [];    // contacts for open category
  var selectedIds       = new Set();
  var checkboxMode      = false;

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

  // ── Layer navigation ─────────────────────────────────────
  function goLogin() {
    show("layer-login"); hide("layer-home"); hide("layer-list"); hide("layer-invite");
  }
  function goHome() {
    hide("layer-login"); show("layer-home"); hide("layer-list"); hide("layer-invite");
    resetCheckbox();
  }
  function goList(cat) {
    currentCategory = cat;
    selectedIds.clear();
    hide("layer-login"); hide("layer-home"); show("layer-list"); hide("layer-invite");
    el("list-title").textContent = cat.name;
    el("list-sub").textContent   = "Loading…";
    setHTML("card-list", '<div class="spinner-wrap">Loading contacts…</div>');
    resetCheckbox();
    loadContacts(cat.id);
  }
  function goInvite() {
    hide("layer-list"); show("layer-invite");
    renderInvite();
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
        startApp();
      })
      .catch(function (err) {
        errEl.textContent = err.message || "Sign-in failed. Check your credentials.";
        errEl.hidden = false;
        btn.disabled = false; btn.textContent = "Sign in";
      });
  });

  el("sign-out-btn").addEventListener("click", function () {
    db.auth.signOut().then(function () { goLogin(); });
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
  }

  // Check existing session on load
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

      document.querySelectorAll(".category-tile").forEach(function (btn) {
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

  // ── Contacts ─────────────────────────────────────────────
  function loadContacts(categoryId) {
    db.from("contact_categories")
      .select("contacts(id,full_name,surname,firstname,organisation,designation,phone,email,bio_context,photo_filename,genre,subgenre,has_vc_met,how_message_goes)")
      .eq("category_id", categoryId)
      .then(function (res) {
        if (res.error) { console.error(res.error); return; }
        var contacts = res.data
          .map(function (r) { return r.contacts; })
          .filter(Boolean);
        currentContacts = sortContacts(contacts);
        el("list-sub").textContent = currentContacts.length + " contacts";
        renderContactList(currentContacts);
      });
  }

  function sortContacts(arr) {
    return arr.slice().sort(function (a, b) {
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

  function renderContactList(contacts) {
    var html = "";
    var lastSection = null;

    contacts.forEach(function (c) {
      var section = [(c.genre || ""), (c.subgenre || "")].filter(Boolean).join(" · ");
      if (section && section !== lastSection) {
        html += '<div class="section-header">' + esc(section) + '</div>';
        lastSection = section;
      }
      html += cardHtml(c);
    });

    if (!html) html = '<div class="spinner-wrap" style="color:#aaa">No contacts found.</div>';
    setHTML("card-list", html);

    if (checkboxMode) attachCardListeners();
  }

  function avatarHtml(c) {
    if (c.photo_filename) {
      return '<img class="avatar" src="photos/' + encodeURIComponent(c.photo_filename) + '" alt="" loading="lazy">';
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
            metTag +
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
    updateSelectBar();
    renderContactList(currentContacts);
    if (checkboxMode) attachCardListeners();
  });

  function resetCheckbox() {
    checkboxMode = false;
    selectedIds.clear();
    el("select-btn").textContent = "Select";
    el("select-btn").classList.remove("active");
    hide("select-bar");
  }

  function attachCardListeners() {
    document.querySelectorAll(".card.selectable").forEach(function (card) {
      card.addEventListener("click", function () {
        var id = card.dataset.id;
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        updateSelectBar();
        // re-render just this card
        var contact = currentContacts.find(function (c) { return c.id === id; });
        if (contact) card.outerHTML = cardHtml(contact);
        // re-attach after outerHTML swap
        attachCardListeners();
      });
    });
  }

  function updateSelectBar() {
    var n = selectedIds.size;
    if (n > 0) {
      show("select-bar");
      el("select-count").textContent = n + (n === 1 ? " selected" : " selected");
    } else {
      hide("select-bar");
    }
  }

  el("draft-btn").addEventListener("click", goInvite);

  // ── Invite draft ─────────────────────────────────────────
  function renderInvite() {
    var selected = currentContacts.filter(function (c) { return selectedIds.has(c.id); });
    el("invite-sub").textContent = selected.length + " contacts · " + (currentCategory ? currentCategory.name : "");

    var lines = selected.map(function (c) {
      var addressing = c.how_message_goes || c.full_name || "";
      var org = c.organisation ? " (" + c.organisation + ")" : "";
      return addressing + org;
    });

    var message = lines.join("\n");

    var html =
      '<div class="invite-message-box" id="invite-text">' + esc(message) + '</div>' +
      '<button class="copy-btn" id="copy-btn" type="button">Copy list</button>' +
      '<p class="invite-note">Copy and paste into WhatsApp as the invite list for ' +
      esc(currentCategory ? currentCategory.name : "") + '.</p>';

    setHTML("invite-body", html);

    el("copy-btn").addEventListener("click", function () {
      navigator.clipboard.writeText(message).then(function () {
        var btn = el("copy-btn");
        btn.textContent = "Copied ✓";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.textContent = "Copy list";
          btn.classList.remove("copied");
        }, 2000);
      }).catch(function () {
        // fallback
        var ta = document.createElement("textarea");
        ta.value = message;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        el("copy-btn").textContent = "Copied ✓";
      });
    });
  }

  // ── Back buttons ─────────────────────────────────────────
  el("back-to-home").addEventListener("click", goHome);
  el("back-to-list").addEventListener("click", function () {
    hide("layer-invite"); show("layer-list");
  });

})();
