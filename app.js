(() => {
  "use strict";

  const app = document.querySelector("#app");
  const sidebar = document.querySelector("#sidebar");
  const topbarUser = document.querySelector("#topbar-user");
  const notice = document.querySelector("#notice");
  const config = window.APP_CONFIG || {};
  const rootDomain = String(config.rootDomain || "is-aroace.l.cd")
    .trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");

  const state = {
    client: null,
    session: null,
    user: null,
    role: "user",
    requests: [],
    section: "dns",
    authMode: "landing",
    prefillLabel: "",
    noticeTimer: null,
    notificationChannel: null,
    notificationPoll: null,
    notificationReady: false,
    notificationWatermark: null,
    notifiedIds: new Set(),
  };

  const PALETTE = ["#E28C00", "#ECCD00", "#BBBBBB", "#62AEDC", "#203856"];
  const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const supportedTypes = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA"];
  const BADGE_EMBED_CODE = '<a href="https://is-aroace.l.cd" target="_blank"><img src="https://is-aroace.l.cd/is-badge.png" alt="GET A FREE AROACE DOMAIN!" width="88" height="31" style="image-rendering: -moz-crisp-edges; image-rendering: crisp-edges; image-rendering: pixelated;"></a>';
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const dateText = (value) => value ? new Date(value).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric"
  }) : "—";

  function colorText(text) {
    let letter = 0;
    return [...text].map((char) => {
      if (/\s/.test(char)) return char === " " ? " " : escapeHTML(char);
      const color = PALETTE[letter % PALETTE.length];
      letter += 1;
      return `<span style="color:${color}">${escapeHTML(char)}</span>`;
    }).join("");
  }

  function isConfigured() {
    return typeof config.supabaseUrl === "string" &&
      /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.supabaseUrl) &&
      typeof config.supabasePublishableKey === "string" &&
      config.supabasePublishableKey.length > 20 &&
      !config.supabasePublishableKey.includes("YOUR_") &&
      rootDomain.length > 3 && !rootDomain.includes("example.org");
  }

  function showNotice(message, type = "info") {
    if (!notice) return;
    clearTimeout(state.noticeTimer);
    notice.textContent = message;
    notice.dataset.type = type;
    notice.hidden = false;
    state.noticeTimer = setTimeout(() => { notice.hidden = true; }, 7000);
  }

  function validOptionalUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return { value: null, error: null };
    if (value.length > 2048) return { value: null, error: "Preview link must be 2048 characters or fewer." };
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { value: null, error: "Preview link must begin with https:// or http://." };
      }
      return { value: parsed.href, error: null };
    } catch {
      return { value: null, error: "Enter a valid preview URL, including https://." };
    }
  }

  function signOutAndReset() {
    state.session = null;
    state.user = null;
    state.requests = [];
    state.role = "user";
    state.section = "dns";
    state.authMode = "landing";
    state.notificationReady = false;
    state.notificationWatermark = null;
    state.notifiedIds.clear();
    if (state.notificationPoll) clearInterval(state.notificationPoll);
    state.notificationPoll = null;
    if (state.notificationChannel && state.client) {
      state.client.removeChannel(state.notificationChannel);
      state.notificationChannel = null;
    }
    renderPublic();
  }

  function setShell(signedIn) {
    if (topbarUser) topbarUser.hidden = !signedIn;
    if (sidebar) sidebar.hidden = !signedIn;
    document.body.classList.toggle("signed-in", Boolean(signedIn));
    if (!signedIn) {
      if (topbarUser) topbarUser.innerHTML = "";
      if (sidebar) sidebar.innerHTML = "";
      return;
    }

    topbarUser.innerHTML = `
      <span class="user-email">${escapeHTML(state.user?.email || "Signed in")}</span>
      <button class="button button-small" id="sign-out">Sign out</button>`;
    topbarUser.querySelector("#sign-out")?.addEventListener("click", async () => {
      const { error } = await state.client.auth.signOut();
      if (error) showNotice(error.message, "error");
    });

    const links = state.role === "admin"
      ? [{ id: "home", label: "Home" }, { id: "admin", label: "Applications" }, { id: "dns", label: "DNS records" }, { id: "info", label: "Info" }, { id: "account", label: "Account" }]
      : [{ id: "home", label: "Home" }, { id: "dns", label: "DNS records" }, { id: "info", label: "Info" }, { id: "account", label: "Account" }];

    sidebar.innerHTML = `<nav class="nav-list" aria-label="Main navigation">${links.map((link) => `
      <button class="nav-button" data-section="${link.id}" aria-current="${state.section === link.id ? "page" : "false"}">${link.label}</button>
    `).join("")}</nav>`;
    sidebar.querySelectorAll("[data-section]").forEach((button) => {
      button.addEventListener("click", () => {
        state.section = button.dataset.section;
        renderCurrentView();
      });
    });
  }

  function renderPublic() {
    setShell(false);
    app.className = "main public-main";

    if (!isConfigured()) {
      const warning = `<div class="inline-note">The site owner needs to configure the Supabase URL, publishable key, and root domain in <code>config.js</code>.</div>`;
      if (state.authMode === "landing") {
        renderLanding(warning);
      } else {
        app.innerHTML = `<div class="page-heading"><h1>Configuration needed</h1>${warning}</div><button class="button" id="go-home">Back to home</button>`;
        app.querySelector("#go-home")?.addEventListener("click", () => { state.authMode = "landing"; renderPublic(); });
      }
      return;
    }

    if (state.authMode === "signin" || state.authMode === "reset") {
      renderAuth();
      return;
    }
    if (state.authMode === "request") {
      renderPublicRequest();
      return;
    }
    renderLanding("");
  }

  function renderLanding(warning, signedIn = Boolean(state.user)) {
    app.innerHTML = `
      ${warning || ""}
      <section class="landing-panel" aria-label="Subdomain tools">
        <form id="availability-form" class="availability-form">
          <label for="availability-label">Find a subdomain</label>
          <div class="availability-input-row">
            <input id="availability-label" name="label" maxlength="63" autocomplete="off" spellcheck="false" placeholder="yourname" aria-describedby="availability-suffix" required>
            <span class="domain-suffix" id="availability-suffix">.${escapeHTML(rootDomain)}</span>
          </div>
          <button class="button button-primary" type="submit">Check availability</button>
          <p id="availability-result" class="availability-result" aria-live="polite">Check a name before requesting it.</p>
          <button class="button button-secondary hidden" id="request-available-name" type="button">Request this name</button>
        </form>
        <div class="landing-actions">
          <button class="button button-primary" id="landing-signup" type="button">${signedIn ? "Request a subdomain" : "Request a subdomain"}</button>
          ${signedIn
            ? `<button class="button button-secondary" id="landing-dashboard" type="button">Go to dashboard</button>`
            : `<button class="button button-secondary" id="landing-login" type="button">Log in</button>`}
        </div>
        <p class="microcopy">Subdomains are free. Requests are reviewed before approval.</p>
      </section>
      <footer class="public-footer"><span>is-aroace</span><span>Free DNS for your little corner of the internet.</span></footer>
      <section class="landing-badge" aria-label="Website badge">
        <a href="#copy-badge-code" id="copy-badge-image" aria-label="Copy the free aroace domain badge HTML">
          <img src="https://is-aroace.l.cd/is-badge.png" alt="GET A FREE AROACE DOMAIN!" width="88" height="31" style="image-rendering: -moz-crisp-edges; image-rendering: crisp-edges; image-rendering: pixelated;">
        </a>
        <button type="button" class="button button-secondary button-small" id="copy-badge-code">Get our badge, tap me or the button to copy it!</button>
        <span class="badge-copy-status" id="badge-copy-status" aria-live="polite"></span>
      </section>`;

    const input = app.querySelector("#availability-label");
    const result = app.querySelector("#availability-result");
    const checkButton = app.querySelector("#availability-form button[type='submit']");
    const requestButton = app.querySelector("#request-available-name");
    let availableLabel = "";

    app.querySelector("#availability-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const label = String(input.value || "").trim().toLowerCase();
      availableLabel = "";
      requestButton.classList.add("hidden");
      if (!labelPattern.test(label)) {
        result.textContent = "Use 1–63 letters, numbers, or hyphens; do not start or end with a hyphen.";
        result.dataset.state = "error";
        return;
      }
      checkButton.disabled = true;
      checkButton.textContent = "Checking…";
      result.textContent = "Checking the request list and DNS records…";
      result.dataset.state = "pending";
      try {
        const { data, error } = await state.client.functions.invoke("domain-availability", { body: { label } });
        if (error) {
          let detail = error.message || "Could not check availability.";
          try { const payload = await error.context?.json(); if (payload?.error) detail = payload.error; } catch {}
          throw new Error(detail);
        }
        if (!data?.success) throw new Error(data?.error || "Availability check failed.");
        if (data.available) {
          availableLabel = label;
          result.textContent = `${label}.${rootDomain} appears available to request. An administrator still needs to approve it.`;
          result.dataset.state = "success";
          requestButton.classList.remove("hidden");
        } else {
          result.textContent = `${label}.${rootDomain} is already assigned, requested, or has DNS records.`;
          result.dataset.state = "error";
        }
      } catch (error) {
          result.textContent = `${error.message || "Availability check failed."} If this keeps happening, the owner needs to deploy the domain-availability Edge Function with Verify JWT disabled.`;
        result.dataset.state = "error";
      } finally {
        checkButton.disabled = false;
        checkButton.textContent = "Check availability";
      }
    });

    requestButton?.addEventListener("click", () => {
      state.prefillLabel = availableLabel;
      if (state.user) {
        state.section = "account";
        renderCurrentView();
      } else {
        state.authMode = "request";
        renderPublic();
      }
    });
    app.querySelector("#landing-signup")?.addEventListener("click", () => {
      state.prefillLabel = availableLabel;
      if (state.user) {
        state.section = "account";
        renderCurrentView();
      } else {
        state.authMode = "request";
        renderPublic();
      }
    });
    const loginButton = app.querySelector("#landing-login");
    if (loginButton) loginButton.addEventListener("click", () => { state.authMode = "signin"; renderPublic(); });
    const dashboardButton = app.querySelector("#landing-dashboard");
    if (dashboardButton) dashboardButton.addEventListener("click", () => { state.section = "dns"; renderCurrentView(); });

    const badgeImage = app.querySelector("#copy-badge-image");
    const badgePrompt = app.querySelector("#copy-badge-prompt");
    const badgeButton = app.querySelector("#copy-badge-code");
    const badgeStatus = app.querySelector("#badge-copy-status");

    async function copyBadgeEmbed(event) {
      event?.preventDefault();
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(BADGE_EMBED_CODE);
        } else {
          const temporary = document.createElement("textarea");
          temporary.value = BADGE_EMBED_CODE;
          temporary.setAttribute("readonly", "");
          temporary.style.position = "fixed";
          temporary.style.opacity = "0";
          temporary.style.pointerEvents = "none";
          document.body.appendChild(temporary);
          temporary.select();
          const copied = document.execCommand("copy");
          temporary.remove();
          if (!copied) throw new Error("Copy is not supported in this browser.");
        }

        if (badgeStatus) badgeStatus.textContent = "Badge HTML copied.";
        showNotice("Badge HTML copied to your clipboard.", "success");
      } catch (error) {
        if (badgeStatus) badgeStatus.textContent = "Could not copy automatically. Select and copy the HTML manually.";
        showNotice("Could not access the clipboard. Try using HTTPS and allowing clipboard access.", "error");
      }
    }

    badgeImage?.addEventListener("click", copyBadgeEmbed);
    badgePrompt?.addEventListener("click", copyBadgeEmbed);
    badgeButton?.addEventListener("click", copyBadgeEmbed);
  }

  function renderAuth() {
    const isReset = state.authMode === "reset";
    app.innerHTML = `
      <section class="auth-card">
        <div class="brand-mark brand-mark-small">${colorText("is-aroace")}</div>
        <div class="accent-rule" aria-hidden="true"></div>
        <div class="page-heading"><h1>${isReset ? "Reset password" : "Log in"}</h1><p class="lede">${isReset ? "Enter the email address on your account." : `Welcome back to ${escapeHTML(rootDomain)}.`}</p></div>
        <form id="auth-form" class="form">
          <div class="field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></div>
          ${isReset ? "" : `<div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="current-password" required></div>`}
          <div class="actions"><button class="button button-primary" type="submit">${isReset ? "Send reset link" : "Log in"}</button><button class="button button-quiet" type="button" id="back-home">Back to home</button>${isReset ? "" : `<button class="text-button" type="button" id="forgot-password">Forgot password?</button>`}</div>
        </form>
      </section>`;

    app.querySelector("#auth-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const email = String(form.get("email") || "").trim();
      const button = event.currentTarget.querySelector("button[type='submit']");
      button.disabled = true;
      try {
        if (isReset) {
          const { error } = await state.client.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split("#")[0] });
          if (error) throw error;
          showNotice("If that account exists, a reset email has been sent.", "success");
        } else {
          const { data, error } = await state.client.auth.signInWithPassword({ email, password: String(form.get("password") || "") });
          if (error) throw error;
          state.session = data.session;
          state.user = data.user;
          state.section = "dns";
          await renderCurrentView();
        }
      } catch (error) {
        showNotice(error?.message || "Authentication failed.", "error");
      } finally {
        const current = app.querySelector("#auth-form button[type='submit']");
        if (current) current.disabled = false;
      }
    });
    app.querySelector("#back-home")?.addEventListener("click", () => { state.authMode = "landing"; renderPublic(); });
    const forgot = app.querySelector("#forgot-password");
    if (forgot) forgot.addEventListener("click", () => { state.authMode = "reset"; renderPublic(); });


  }

  function renderPublicRequest() {
    const prefill = escapeHTML(state.prefillLabel);
    app.innerHTML = `
      <section class="auth-card request-card">
        <div class="brand-mark brand-mark-small">${colorText("is-aroace")}</div>
        <div class="accent-rule" aria-hidden="true"></div>
        <div class="page-heading"><h1>Request a subdomain</h1><p class="lede">Requests are reviewed by an administrator. If approved, an account invitation will be sent to your email.</p></div>
        <form id="application-form" class="form">
          <div class="field"><label for="applicant-name">Name</label><input id="applicant-name" name="applicant_name" autocomplete="name" required maxlength="100"></div>
          <div class="field"><label for="applicant-email">Email</label><input id="applicant-email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></div>
          <div class="field"><label for="requested-domain">Desired subdomain</label><div class="form-domain-row"><input id="requested-domain" name="domain" value="${prefill}" required maxlength="63" placeholder="yourname"><span class="domain-suffix">.${escapeHTML(rootDomain)}</span></div></div>
          <div class="field"><label for="application-purpose">What will you use it for?</label><textarea id="application-purpose" name="purpose" required minlength="10" maxlength="1000" placeholder="Tell us what you plan to build."></textarea></div>
          <div class="field"><label for="application-preview">Preview link <span class="optional-label">Optional</span></label><input id="application-preview" name="preview_url" type="url" maxlength="2048" placeholder="https://your-project.example"><span class="field-hint">A demo, project page, repository, or mock-up can help reviewers understand your idea.</span></div>
          <div class="actions"><button class="button button-primary" type="submit">Send request</button><button class="button button-quiet" id="request-back-home" type="button">Back to home</button><button class="text-button" id="request-login" type="button">Already have an account? Log in</button></div>
        </form>
      </section>`;

    app.querySelector("#application-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formEl = event.currentTarget;
      const form = new FormData(formEl);
      const applicantName = String(form.get("applicant_name") || "").trim();
      const email = String(form.get("email") || "").trim().toLowerCase();
      const label = String(form.get("domain") || "").trim().toLowerCase();
      const purpose = String(form.get("purpose") || "").trim();
      const preview = validOptionalUrl(form.get("preview_url"));
      if (!labelPattern.test(label)) return showNotice("Enter a valid subdomain label using letters, numbers, and hyphens.", "error");
      if (purpose.length < 10) return showNotice("Please describe the purpose in at least 10 characters.", "error");
      if (preview.error) return showNotice(preview.error, "error");
      const button = formEl.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = "Sending…";
      try {
        const { error } = await state.client.from("subdomain_requests").insert({
          applicant_name: applicantName,
          email,
          requested_label: label,
          reason: purpose,
          preview_url: preview.value,
          user_id: null,
          status: "pending"
        });
        if (error) throw error;
        app.innerHTML = `<section class="auth-card"><div class="accent-rule"></div><div class="page-heading"><h1>Request received</h1><p class="lede">Your request for <strong>${escapeHTML(label)}.${escapeHTML(rootDomain)}</strong> has been submitted for review. If approved, an account invitation will be sent to ${escapeHTML(email)}.</p></div><button class="button button-primary" id="new-request">Submit another request</button><button class="button button-quiet" id="request-done-home">Back to home</button></section>`;
        app.querySelector("#new-request")?.addEventListener("click", () => { state.prefillLabel = ""; renderPublicRequest(); });
        app.querySelector("#request-done-home")?.addEventListener("click", () => { state.authMode = "landing"; renderPublic(); });
        state.prefillLabel = "";
        showNotice("Request submitted for review.", "success");
      } catch (error) {
        showNotice(error?.code === "23505" ? "That domain already has a pending request or active assignment." : error?.message || "Could not submit the request.", "error");
        button.disabled = false;
        button.textContent = "Send request";
      }
    });
    app.querySelector("#request-back-home")?.addEventListener("click", () => { state.authMode = "landing"; renderPublic(); });
    app.querySelector("#request-login")?.addEventListener("click", () => { state.authMode = "signin"; renderPublic(); });
  }

  async function loadData() {
    const { data: profile, error: profileError } = await state.client.from("profiles").select("role").eq("id", state.user.id).maybeSingle();
    if (profileError) throw profileError;
    state.role = profile?.role === "admin" ? "admin" : "user";

    let query = state.client.from("subdomain_requests")
      .select("id,user_id,applicant_name,email,requested_label,reason,preview_url,status,admin_note,reviewed_by,reviewed_at,created_at")
      .order("created_at", { ascending: false });
    if (state.role !== "admin") query = query.eq("user_id", state.user.id);
    const { data, error } = await query;
    if (error) throw error;
    state.requests = data || [];

    if (state.section === "nameservers") state.section = "dns";
    if (state.role === "admin" && !["home", "admin", "dns", "info", "account"].includes(state.section)) state.section = "admin";
    if (state.role !== "admin" && !["home", "dns", "info", "account"].includes(state.section)) state.section = "dns";
  }

  async function renderCurrentView() {
    if (!state.session || !state.user) { renderPublic(); return; }
    app.className = "main workspace-main";
    app.innerHTML = `<div class="loading-state">Loading your workspace…</div>`;
    try {
      await loadData();
      setShell(true);
      if (state.role === "admin") setupAdminNotifications();
      if (state.section === "home") renderLanding("", true);
      else if (state.section === "account") renderAccountSettings();
      else if (state.section === "info") renderInfo();
      else if (state.role === "admin" && state.section === "admin") renderAdmin();
      else renderDNSSettings();
    } catch (error) {
      setShell(true);
      const detail = error?.message || "Unknown error";
      const uiError = /addEventListener|querySelector|classList|innerHTML/i.test(detail);
      const heading = uiError ? "Workspace interface could not initialize" : "Could not load your workspace";
      const guidance = uiError
        ? "Reload the page after updating the matching app.js and index.html files. If it persists, clear the browser cache."
        : "Check that the latest database migration has been applied and that the profiles and subdomain_requests access policies allow this account to read its records.";
      app.innerHTML = `<div class="page-heading"><h1>${heading}</h1><p class="lede">${guidance}</p></div><p class="small">${escapeHTML(detail)}</p><button class="button" id="retry-load">Retry</button>`;
      app.querySelector("#retry-load")?.addEventListener("click", renderCurrentView);
    }
  }

  function setupAdminNotifications() {
    if (state.notificationReady || !state.client || state.role !== "admin") return;
    state.notificationReady = true;
    const existingIds = new Set(state.requests.map((request) => request.id));
    existingIds.forEach((id) => state.notifiedIds.add(id));
    state.notificationWatermark = new Date().toISOString();

    const announce = (record) => {
      if (!record?.id || state.notifiedIds.has(record.id)) return;
      state.notifiedIds.add(record.id);
      const fullDomain = `${record.requested_label || "A subdomain"}.${rootDomain}`;
      showNotice(`New subdomain request: ${fullDomain}`, "info");
      if (typeof window.Notification === "function" && window.Notification.permission === "granted") {
        try {
          const notification = new window.Notification("New subdomain request", {
            body: `${fullDomain} was requested by ${record.applicant_name || record.email || "an applicant"}.`,
            tag: `request-${record.id}`,
          });
          notification.onclick = () => { window.focus(); state.section = "admin"; renderCurrentView(); notification.close(); };
        } catch { /* In-app notice still works if desktop notification is unavailable. */ }
      }
    };

    state.notificationChannel = state.client.channel("admin-subdomain-requests")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "subdomain_requests" }, (payload) => announce(payload.new))
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("Realtime notifications are unavailable; periodic checks remain enabled.");
        }
      });

    state.notificationPoll = setInterval(async () => {
      if (!state.user || state.role !== "admin" || !state.notificationWatermark) return;
      const until = new Date().toISOString();
      const from = state.notificationWatermark;
      state.notificationWatermark = until;
      const { data, error } = await state.client.from("subdomain_requests")
        .select("id,requested_label,applicant_name,email,created_at")
        .gt("created_at", from)
        .lte("created_at", until)
        .order("created_at", { ascending: true });
      if (!error && Array.isArray(data)) data.forEach(announce);
    }, 45000);
  }

  async function invokeDnsFunction(body) {
    const { data, error } = await state.client.functions.invoke("cloudns-manage-nameservers", { body });
    if (error) {
      let detail = error.message || "DNS function request failed.";
      try { const payload = await error.context?.json(); if (payload?.error) detail = payload.error; } catch {}
      throw new Error(detail);
    }
    if (!data?.success) throw new Error(data?.error || "DNS operation failed.");
    return data;
  }

  function dnsRecordTypeHelp(type) {
    const messages = {
      A: "IPv4 address, e.g. 192.0.2.10",
      AAAA: "IPv6 address, e.g. 2001:db8::10",
      CNAME: "Target hostname, e.g. target.example.net.",
      MX: "Mail exchange: priority and hostname, e.g. 10 mail.example.net.",
      TXT: "Text value; one record per line. Useful for verification and SPF.",
      SRV: "Priority weight port target, e.g. 10 5 443 service.example.net.",
      CAA: "Flags tag value, e.g. 0 issue letsencrypt.org"
    };
    return messages[type] || "One record value per line.";
  }

  function renderInfo() {
    app.innerHTML = `
      <div class="page-heading"><h1>Info</h1></div>
      <section class="section panel-section">
        <h2>Section 1. what do i do with this domain?</h2>
        <p>you use it for your website</p>
      </section>
      <hr class="rule">
      <section class="section panel-section">
        <h2>Section 2. how do i make one</h2>
        <p>find a tutorial online "HTML tutorial" or get a tutorial elsewhere, or use google sites.</p>
      </section>
      <hr class="rule">
      <section class="section panel-section">
        <h2>Section 3. ok i got it, now how do i connect it</h2>
        <p>use dns. when it asks you to add dns, add those under the "DNS Records" tab, leave the prefix blank or @ if you want something.is-aroace.l.cd, else itll be something.something.is-aroace.l.cd.</p>
      </section>`;
  }

function renderDNSSettings() {
  const isAdmin = state.role === "admin";
  const approved = state.requests.filter((item) =>
    item.status === "approved" && (isAdmin || item.user_id === state.user.id)
  );
  const myDomains = approved.filter((item) => item.user_id === state.user.id);
  const otherDomains = isAdmin
    ? approved.filter((item) => item.user_id !== state.user.id)
    : [];

  const renderDomainGroup = (domains) => `
    ${domains.length
      ? `<div class="domain-settings-list">${domains.map((request) => `
        <section class="domain-card" data-domain-card data-request-id="${escapeHTML(request.id)}">
          <div class="domain-card-heading">
            <div>
              <p class="eyebrow">${isAdmin
                ? `OWNER: ${escapeHTML(request.email || request.applicant_name || "Unknown")}`
                : "APPROVED SUBDOMAIN"}</p>
              <h2>${escapeHTML(request.requested_label)}.${escapeHTML(rootDomain)}</h2>
            </div>
            <span class="status status-approved">Approved</span>
          </div>

          ${isAdmin ? `
            <div class="actions" style="margin:0 0 12px">
              <button class="button button-danger button-small"
                type="button" data-admin-delete-domain="${escapeHTML(request.id)}">
                Delete subdomain and all its DNS
              </button>
            </div>` : ""}

          <p class="small">Use <code>@</code> for this subdomain itself, or a name like <code>www</code>, <code>mail</code>, or <code>_acme-challenge</code> for a record beneath it.</p>

          <div class="legacy-ns-warning hidden" data-legacy-warning>
            We found an old NS delegation for this subdomain. Saving a DNS record below will remove that delegation so records can be managed here.
          </div>

          <div class="record-list" data-record-list>
            <p class="small">Loading DNS records…</p>
          </div>

          <form class="record-form" data-record-form>
            <h3>Add or replace a record</h3>
            <div class="record-form-grid">
              <div class="field">
                <label>Host</label>
                <input name="recordName" value="@" required maxlength="253" placeholder="@ or www">
                <span class="field-hint">Relative to this subdomain.</span>
              </div>
              <div class="field">
                <label>Type</label>
                <select name="type">
                  ${supportedTypes.map((type) => `<option value="${type}">${type}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label>TTL (seconds)</label>
                <input name="ttl" type="number" min="60" max="86400" step="60" value="3600" required>
              </div>
            </div>

            <div class="field">
              <label>Record value(s)</label>
              <textarea name="records" rows="3" required spellcheck="false" placeholder="One value per line"></textarea>
              <span class="field-hint" data-type-help>${dnsRecordTypeHelp("A")}</span>
            </div>

            <div class="actions">
              <button class="button button-primary" type="submit">Save DNS record</button>
              <span class="small" data-record-result aria-live="polite"></span>
            </div>
          </form>
        </section>
      `).join("")}</div>`
      : `<p class="empty compact-empty">No approved subdomains in this section.</p>`}
  `;

  app.innerHTML = `
    <div class="page-heading">
      <p class="eyebrow">${isAdmin ? "ADMIN CONTROL PANEL" : "YOUR WORKSPACE"}</p>
      <h1>DNS records</h1>
      <p class="lede">
        ${isAdmin
          ? "Manage DNS records for every approved subdomain. You can also remove a subdomain and its DNS records."
          : "Add and edit A, AAAA, CNAME, MX, TXT, SRV, and CAA records for your approved subdomains."}
        DNS is managed here—no external nameserver setup is needed.
      </p>
    </div>

    ${isAdmin ? `
      <section class="section panel-section">
        <h2>MY domains</h2>
        ${renderDomainGroup(myDomains)}
      </section>

      <hr class="rule">

      <section class="section panel-section">
        <h2>Others' domains</h2>
        ${renderDomainGroup(otherDomains)}
      </section>
    ` : myDomains.length
      ? renderDomainGroup(myDomains)
      : `
        <section class="empty-state">
          <h2>No approved subdomains yet</h2>
          <p>Your DNS editor appears here after an administrator approves one of your requests.</p>
          <button class="button button-primary" id="request-first-domain">Request a subdomain</button>
        </section>
      `}
  `;

  const requestFirst = app.querySelector("#request-first-domain");
  requestFirst?.addEventListener("click", () => {
    state.section = "account";
    renderCurrentView();
  });

  app.querySelectorAll("[data-domain-card]").forEach((card) => {
    const requestId = card.dataset.requestId;
    const request = approved.find((item) => item.id === requestId);
    const recordsContainer = card.querySelector("[data-record-list]");
    const warning = card.querySelector("[data-legacy-warning]");
    const form = card.querySelector("[data-record-form]");
    const help = form?.querySelector("[data-type-help]");
    const typeSelect = form?.querySelector("[name='type']");
    const result = form?.querySelector("[data-record-result]");

    if (!request || !recordsContainer || !form || !typeSelect || !result) return;

    let legacyNsFound = false;

    const fullRecordHost = (host) => {
      const relative = String(host || "@");
      return relative === "@"
        ? `${request.requested_label}.${rootDomain}`
        : `${relative}.${request.requested_label}.${rootDomain}`;
    };

    typeSelect.addEventListener("change", () => {
      if (help) help.textContent = dnsRecordTypeHelp(typeSelect.value);
    });

    const loadRecords = async () => {
      recordsContainer.innerHTML = `<p class="small">Loading DNS records…</p>`;

      const data = await invokeDnsFunction({ action: "get", requestId });
      legacyNsFound = Boolean(data.legacyNsFound);

      if (warning) warning.classList.toggle("hidden", !legacyNsFound);

      const records = Array.isArray(data.records) ? data.records : [];

      if (!records.length) {
        recordsContainer.innerHTML = `<p class="empty compact-empty">No DNS records yet. Add your first one below.</p>`;
        return;
      }

      recordsContainer.innerHTML = records.map((record) => `
        <article class="record-row">
          <div class="record-meta">
            <span class="record-type">${escapeHTML(record.type)}</span>
            <strong>${escapeHTML(fullRecordHost(record.host))}</strong>
            <span class="small">TTL ${escapeHTML(record.ttl)}</span>
          </div>
          <pre class="record-values">${escapeHTML((record.records || []).join("\n"))}</pre>
          <button class="button button-danger button-small"
            data-delete-record
            data-host="${escapeHTML(record.host)}"
            data-type="${escapeHTML(record.type)}"
            type="button">
            Delete record set
          </button>
        </article>
      `).join("");

      recordsContainer.querySelectorAll("[data-delete-record]").forEach((button) => {
        button.addEventListener("click", async () => {
          const host = button.dataset.host;
          const type = button.dataset.type;
          const displayHost = fullRecordHost(host);

          if (!window.confirm(`Delete the ${type} record set for ${displayHost}?`)) return;

          button.disabled = true;

          try {
            await invokeDnsFunction({
              action: "delete",
              requestId,
              recordName: host,
              type
            });

            showNotice(`${type} records deleted for ${displayHost}.`, "success");
            await loadRecords();
          } catch (error) {
            showNotice(error.message || "Could not delete the record set.", "error");
            button.disabled = false;
          }
        });
      });
    };

    loadRecords().catch((error) => {
      recordsContainer.innerHTML = `
        <p class="inline-note">
          Could not load DNS records: ${escapeHTML(error.message || "Unknown error")}
        </p>`;
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const values = new FormData(form);
      const recordName = String(values.get("recordName") || "@").trim().toLowerCase();
      const type = String(values.get("type") || "A").toUpperCase();
      const ttl = Number(values.get("ttl"));
      const records = String(values.get("records") || "")
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);

      if (!recordName || recordName.length > 253) {
        result.textContent = "Enter @ or a relative host name.";
        return;
      }

      if (!supportedTypes.includes(type)) {
        result.textContent = "That record type is not supported.";
        return;
      }

      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
        result.textContent = "TTL must be between 60 and 86400 seconds.";
        return;
      }

      if (!records.length || records.length > 25 || records.some((entry) => entry.length > 1000)) {
        result.textContent = "Enter between 1 and 25 record values, one per line.";
        return;
      }

      const button = form.querySelector("button[type='submit']");
      if (!button) return;

      button.disabled = true;
      result.textContent = legacyNsFound
        ? "Switching from old NS delegation and saving…"
        : "Saving to DNS…";

      try {
        await invokeDnsFunction({
          action: "set",
          requestId,
          recordName,
          type,
          ttl,
          records
        });

        form.querySelector("[name='records']").value = "";
        result.textContent = "DNS record saved.";

        showNotice(`Saved ${type} record for ${fullRecordHost(recordName)}.`, "success");
        await loadRecords();
      } catch (error) {
        result.textContent = error.message || "Could not save the DNS record.";
        showNotice(result.textContent, "error");
      } finally {
        button.disabled = false;
      }
    });

    const adminDelete = card.querySelector("[data-admin-delete-domain]");

    adminDelete?.addEventListener("click", async () => {
      if (!isAdmin) return;

      const fullDomain = `${request.requested_label}.${rootDomain}`;

      if (!window.confirm(
        `ADMIN ACTION: Permanently delete ${fullDomain}, its DNS records, and its assignment? This cannot be undone.`
      )) return;

      const confirmation = window.prompt(
        `Type DELETE ${request.requested_label} to confirm removal of ${fullDomain}.`
      );

      if (confirmation !== `DELETE ${request.requested_label}`) {
        showNotice("Deletion cancelled.", "info");
        return;
      }

      adminDelete.disabled = true;
      adminDelete.textContent = "Deleting…";

      try {
        await invokeAccountFunction({ action: "delete-domain", requestId });
        showNotice(`${fullDomain} and its DNS records were deleted.`, "success");
        await renderCurrentView();
      } catch (error) {
        adminDelete.disabled = false;
        adminDelete.textContent = "Delete subdomain and all its DNS";
        showNotice(error.message || "Could not delete subdomain.", "error");
      }
    });
  });
}
  async function invokeAccountFunction(body) {
    const { data, error } = await state.client.functions.invoke("account-management", { body });
    if (error) {
      let detail = error.message || "Account action failed.";
      try { const payload = await error.context?.json(); if (payload?.error) detail = payload.error; } catch {}
      throw new Error(detail);
    }
    if (!data?.success) throw new Error(data?.error || "Account action failed.");
    return data;
  }

  function renderAccountSettings() {
    const mine = state.requests.filter((item) => item.user_id === state.user.id);
    const approved = mine.filter((item) => item.status === "approved");
    const pending = mine.filter((item) => item.status === "pending");
    app.innerHTML = `
      <div class="page-heading"><p class="eyebrow">YOUR PROFILE</p><h1>Account</h1><p class="lede">Request new subdomains, manage your assignments, and control your account.</p></div>
      <section class="section panel-section"><h2>Request another subdomain</h2><p class="lede">Requests are reviewed by an administrator. A preview link is optional and may help reviewers understand your project.</p>
        <form id="request-domain-form" class="form">
          <div class="field"><label for="more-domain">Desired subdomain</label><div class="form-domain-row"><input id="more-domain" name="domain" required maxlength="63" placeholder="yourname"><span class="domain-suffix">.${escapeHTML(rootDomain)}</span></div></div>
          <div class="field"><label for="more-purpose">Purpose</label><textarea id="more-purpose" name="purpose" required minlength="10" maxlength="1000" placeholder="What will you use this subdomain for?"></textarea></div>
          <div class="field"><label for="more-preview">Preview link <span class="optional-label">Optional</span></label><input id="more-preview" name="preview_url" type="url" maxlength="2048" placeholder="https://your-project.example"><span class="field-hint">Demo, project page, repository, or mock-up.</span></div>
          <div class="actions"><button class="button button-primary" type="submit">Submit domain request</button><span class="small" id="request-domain-result" aria-live="polite"></span></div>
        </form>
      </section>
      <hr class="rule">
      <section class="section panel-section"><h2>Your requests</h2>${pending.length ? `<div class="request-list">${pending.map((request) => `<article class="request-mini"><div class="domain-card-heading"><strong>${escapeHTML(request.requested_label)}.${escapeHTML(rootDomain)}</strong><span class="status status-pending">Pending review</span></div><p class="small">Submitted ${dateText(request.created_at)}.</p>${request.preview_url ? `<a href="${escapeHTML(request.preview_url)}" target="_blank" rel="noopener noreferrer">Open preview link</a>` : ""}</article>`).join("")}</div>` : `<p class="small">You have no requests waiting for review.</p>`}</section>
      <hr class="rule">
      <section class="section panel-section"><h2>Your approved subdomains</h2>${approved.length ? `<div class="request-list">${approved.map((request) => `<article class="request-mini"><strong>${escapeHTML(request.requested_label)}.${escapeHTML(rootDomain)}</strong><p class="small">Delete only if you are sure. You can request the name again if it is available, but approval is not automatic.</p><button class="button button-danger" data-delete-domain="${escapeHTML(request.id)}">Delete this subdomain</button><span class="small" data-delete-result="${escapeHTML(request.id)}" aria-live="polite"></span></article>`).join("")}</div>` : `<p class="empty compact-empty">You have no approved subdomains assigned to this account.</p>`}</section>
      <hr class="rule">
      <section class="section panel-section"><h2>Delete account</h2><p class="lede">This permanently deletes your app account, requests, and DNS records for your assigned subdomains. The parent domain and Supabase project remain.</p><button class="button button-danger" id="delete-account">Delete my account</button></section>
      <hr class="rule">
      <section class="section panel-section"><h2>Sign out</h2><p class="small">Sign out without deleting your account or domains.</p><button class="button button-secondary" id="account-sign-out">Sign out</button></section>`;

    const moreDomainInput = app.querySelector("#more-domain");
    if (moreDomainInput && state.prefillLabel) {
      moreDomainInput.value = state.prefillLabel;
      state.prefillLabel = "";
    }

    app.querySelector("#request-domain-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const label = String(values.get("domain") || "").trim().toLowerCase();
      const purpose = String(values.get("purpose") || "").trim();
      const preview = validOptionalUrl(values.get("preview_url"));
      const result = form.querySelector("#request-domain-result");
      if (!labelPattern.test(label)) { result.textContent = "Use 1–63 letters, numbers, or hyphens; do not start or end with a hyphen."; return; }
      if (purpose.length < 10) { result.textContent = "Please describe the purpose in at least 10 characters."; return; }
      if (preview.error) { result.textContent = preview.error; return; }
      const button = form.querySelector("button[type='submit']");
      button.disabled = true;
      result.textContent = "Submitting request…";
      try {
        await invokeAccountFunction({ action: "request-domain", requestedLabel: label, reason: purpose, previewUrl: preview.value });
        showNotice(`Request for ${label}.${rootDomain} submitted for review.`, "success");
        await renderCurrentView();
      } catch (error) {
        result.textContent = error.message || "Could not submit request.";
        showNotice(result.textContent, "error");
        button.disabled = false;
      }
    });

    app.querySelectorAll("[data-delete-domain]").forEach((button) => button.addEventListener("click", async () => {
      const requestId = button.dataset.deleteDomain;
      const request = approved.find((item) => item.id === requestId);
      if (!request) return;
      const fullDomain = `${request.requested_label}.${rootDomain}`;
      if (!window.confirm(`Permanently delete DNS records for ${fullDomain}? This cannot be undone.`)) return;
      button.disabled = true;
      const result = app.querySelector(`[data-delete-result="${CSS.escape(requestId)}"]`);
      result.textContent = "Deleting records…";
      try {
        await invokeAccountFunction({ action: "delete-domain", requestId });
        showNotice(`${fullDomain} was deleted.`, "success");
        await renderCurrentView();
      } catch (error) {
        result.textContent = error.message || "Could not delete subdomain.";
        showNotice(result.textContent, "error");
        button.disabled = false;
      }
    }));

    app.querySelector("#delete-account")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      if (!window.confirm("Delete your account, requests, and all DNS records for your assigned subdomains? This cannot be undone. The parent domain and Supabase project will remain.")) return;
      if (window.prompt('Type DELETE to permanently delete your account and its DNS records.') !== "DELETE") {
        showNotice("Account deletion cancelled.", "info");
        return;
      }
      button.disabled = true;
      button.textContent = "Deleting account…";
      try {
        await invokeAccountFunction({ action: "delete-account", confirmation: "DELETE" });
        await state.client.auth.signOut({ scope: "local" });
        signOutAndReset();
        showNotice("Your account and assigned DNS records were deleted.", "success");
      } catch (error) {
        button.disabled = false;
        button.textContent = "Delete my account";
        showNotice(error.message || "Account deletion failed.", "error");
      }
    });
    app.querySelector("#account-sign-out")?.addEventListener("click", async () => {
      const { error } = await state.client.auth.signOut();
      if (error) showNotice(error.message, "error");
    });
  }

  function safeLink(url) {
    const checked = validOptionalUrl(url);
    if (checked.error || !checked.value) return "—";
    return `<a href="${escapeHTML(checked.value)}" target="_blank" rel="noopener noreferrer">Open preview ↗</a>`;
  }

  function renderAdmin() {
    const pending = state.requests.filter((item) => item.status === "pending").length;
    const approved = state.requests.filter((item) => item.status === "approved").length;
    const rows = state.requests.length ? state.requests.map((request) => `
      <tr>
        <td><span class="table-primary">${escapeHTML(request.requested_label)}.${escapeHTML(rootDomain)}</span></td>
        <td>${escapeHTML(request.email || "—")}</td>
        <td>${escapeHTML(request.reason || "")}</td>
        <td>${safeLink(request.preview_url)}</td>
        <td><span class="status ${request.status === "approved" ? "status-approved" : request.status === "pending" ? "status-pending" : "status-muted"}">${escapeHTML(request.status)}</span></td>
        <td>${request.status === "pending" ? `<div class="table-actions"><button class="button button-primary button-small" data-approve="${escapeHTML(request.id)}">${request.user_id ? "Approve request" : "Approve & invite"}</button><button class="button button-secondary button-small" data-reject="${escapeHTML(request.id)}">Reject</button></div>` : `<span class="small">${dateText(request.created_at)}</span>`}</td>
      </tr>`).join("") : `<tr><td colspan="6"><div class="empty">No requests yet.</div></td></tr>`;

    const canNotify = typeof window.Notification === "function";
    const permissionLabel = !canNotify ? "Desktop notifications unavailable in this browser" : window.Notification.permission === "granted" ? "Desktop notifications enabled" : window.Notification.permission === "denied" ? "Desktop notifications blocked in browser settings" : "Enable desktop notifications";

    app.innerHTML = `
      <div class="page-heading"><p class="eyebrow">ADMIN CONTROL PANEL</p><h1>Applications</h1><p class="lede">Review requests, follow preview links, and approve subdomains.</p></div>
      <div class="stats"><div class="stat"><div class="stat-value">${pending}</div><div class="stat-label">Pending requests</div></div><div class="stat"><div class="stat-value">${approved}</div><div class="stat-label">Approved subdomains</div></div></div>
      <section class="section panel-section"><div class="section-header-row"><div><h2>Request notifications</h2><p class="small">New requests show an in-app notice. Desktop notifications work while this site is open if you enable them.</p></div><button id="enable-notifications" class="button button-secondary button-small" ${!canNotify || window.Notification.permission !== "default" ? "disabled" : ""}>${permissionLabel}</button></div></section>
      <section class="section panel-section"><div class="table-wrap"><table><thead><tr><th>Requested domain</th><th>Email</th><th>Purpose</th><th>Preview</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div></section>
      <hr class="rule"><section class="section panel-section"><div class="section-header-row"><div><h2>DNS API connection</h2><p class="small">Check the server-side deSEC token and zone.</p></div><button id="test-dns" class="button button-secondary">Test deSEC connection</button></div><span id="dns-test-result" class="small" aria-live="polite">Not tested yet.</span></section>`;

    const notifyButton = app.querySelector("#enable-notifications");
    if (notifyButton && canNotify && window.Notification.permission === "default") {
      notifyButton.addEventListener("click", async () => {
        const permission = await window.Notification.requestPermission();
        notifyButton.textContent = permission === "granted" ? "Desktop notifications enabled" : permission === "denied" ? "Blocked in browser settings" : "Enable desktop notifications";
        notifyButton.disabled = permission !== "default";
        if (permission === "granted") showNotice("Desktop notifications are enabled for new requests.", "success");
      });
    }

    app.querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", async () => {
      const request = state.requests.find((item) => item.id === button.dataset.approve);
      if (!request) return;
      const existingUser = Boolean(request.user_id);
      const prompt = existingUser
        ? `Approve ${request.requested_label}.${rootDomain} and link it to existing account ${request.email}?`
        : `Approve ${request.requested_label}.${rootDomain} and send an account invitation to ${request.email}?`;
      if (!window.confirm(prompt)) return;
      button.disabled = true;
      button.textContent = "Approving…";
      try {
        let data;
        if (existingUser) {
          data = await invokeAccountFunction({ action: "approve-linked-request", requestId: request.id });
        } else {
          const { data: responseData, error } = await state.client.functions.invoke("cloudns-approve-request", { body: { requestId: request.id } });
          if (error) {
            let detail = error.message || "Approval failed.";
            try { const payload = await error.context?.json(); if (payload?.error) detail = payload.error; } catch {}
            throw new Error(detail);
          }
          data = responseData;
        }
        if (!data?.success) throw new Error(data?.error || "Approval failed.");
        showNotice(data.message || (existingUser ? `Approved and linked ${request.email}.` : `Approved. Invitation sent to ${request.email}.`), "success");
        await renderCurrentView();
      } catch (error) {
        showNotice(error.message || "Could not approve request.", "error");
        button.disabled = false;
        button.textContent = existingUser ? "Approve request" : "Approve & invite";
      }
    }));

    app.querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", async () => {
      const request = state.requests.find((item) => item.id === button.dataset.reject);
      if (!request || !window.confirm(`Reject ${request.requested_label}.${rootDomain}?`)) return;
      button.disabled = true;
      const { error } = await state.client.from("subdomain_requests")
        .update({ status: "rejected", reviewed_by: state.user.id, reviewed_at: new Date().toISOString() })
        .eq("id", request.id).eq("status", "pending");
      if (error) { showNotice(error.message, "error"); button.disabled = false; return; }
      showNotice("Request rejected.", "success");
      await renderCurrentView();
    }));

    app.querySelector("#test-dns")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const result = app.querySelector("#dns-test-result");
      button.disabled = true;
      result.textContent = "Testing…";
      try {
        const { data, error } = await state.client.functions.invoke("cloudns-check", { body: {} });
        if (error) {
          let detail = error.message || "Function request failed.";
          try { const payload = await error.context?.json(); if (payload?.error) detail = payload.error; } catch {}
          throw new Error(detail);
        }
        if (!data?.success) throw new Error(data?.error || "Connection could not be verified.");
        result.textContent = data.message || "deSEC API responded.";
        showNotice("deSEC connection check completed.", "success");
      } catch (error) {
        result.textContent = error.message || "Connection test failed.";
        showNotice(result.textContent, "error");
      } finally { button.disabled = false; }
    });
  }

  async function start() {
    const footerDomain = document.querySelector("#footer-domain");
    if (footerDomain) footerDomain.textContent = rootDomain;
    const headerHome = document.querySelector("#header-home");
    if (headerHome) {
      headerHome.addEventListener("click", (event) => {
        event.preventDefault();
        if (state.user) {
          state.section = "home";
          renderCurrentView();
        } else {
          state.authMode = "landing";
          renderPublic();
        }
      });
    }
    const brandDomain = document.querySelector("#header-domain");
    if (brandDomain) brandDomain.textContent = `.${rootDomain.split(".").slice(1).join(".")}`;
    if (!window.supabase?.createClient) {
      app.innerHTML = `<div class="page-heading"><h1>Supabase client did not load</h1><p class="lede">Check your internet connection and the Supabase script in index.html.</p></div>`;
      return;
    }
    if (!isConfigured()) { renderPublic(); return; }

    state.client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    state.client.auth.onAuthStateChange((event, session) => {
      state.session = session;
      state.user = session?.user || null;
      if (!state.user) {
        if (event === "SIGNED_OUT") state.authMode = "landing";
        if (state.notificationPoll) clearInterval(state.notificationPoll);
        state.notificationPoll = null;
        state.notificationReady = false;
        if (state.notificationChannel) state.client.removeChannel(state.notificationChannel);
        state.notificationChannel = null;
        renderPublic();
      } else {
        setTimeout(() => renderCurrentView(), 0);
      }
    });
    const { data, error } = await state.client.auth.getSession();
    if (error) { showNotice(error.message, "error"); renderPublic(); return; }
    state.session = data.session;
    state.user = data.session?.user || null;
    if (state.user) await renderCurrentView(); else renderPublic();
  }

  start();
})();
