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
    passwordRecovery: false,
    prefillLabel: "",
    noticeTimer: null,
    notificationChannel: null,
    notificationPoll: null,
    notificationReady: false,
    notificationWatermark: null,
    notifiedIds: new Set(),
    websiteRequestId: null,
    websiteEntries: [],
    websiteCurrentPath: "",
    websiteOpenTabs: [],
    websiteEditor: null,
    websiteFallbackEditor: null,
    websiteSaveTimer: null,
    websiteSaving: false,
    websiteDirty: false,
    websiteCurrentFile: null,
    websiteSelectedFolder: "",
    websiteSelectedEntryPath: "",
    websiteSelectedEntryKind: "",
    websiteProgrammaticChange: false,
    websiteEditorModels: new Map(),
  };

  const PALETTE = ["#E28C00", "#ECCD00", "#666666", "#62AEDC", "#203856"];
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

  function browserSupportsPush() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isStandalone = window.matchMedia?.("(display-mode: standalone)").matches ||
      navigator.standalone === true;

    return Boolean(
      window.isSecureContext &&
      typeof window.Notification === "function" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      config.pushPublicKey &&
      (!isIOS || isStandalone)
    );
  }

  function pushUnavailableMessage() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isIOS && !(window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true)) {
      return "On iPhone or iPad, add this website to your Home Screen and open it there before enabling notifications.";
    }
    return "Push notifications need to be configured by the site owner and supported by your browser.";
  }

  function base64UrlToUint8Array(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = window.atob(base64);
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function createApplicantNotificationToken() {
    if (!window.crypto?.getRandomValues || !window.crypto?.subtle) return null;
    const random = window.crypto.getRandomValues(new Uint8Array(32));
    const token = bytesToBase64Url(random);
    const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { token, hash };
  }

  async function savePushSubscription(scope, extra = {}) {
    if (!browserSupportsPush()) {
      throw new Error("Push notifications are not configured or supported in this browser.");
    }
    const permission = await window.Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error(permission === "denied"
        ? "Notifications are blocked in browser settings. Allow notifications for this site and try again."
        : "Notification permission was not granted.");
    }

    await navigator.serviceWorker.register("/sw.js?update=20261109-pushfix2", { scope: "/" });
    const registration = await navigator.serviceWorker.ready;
    const applicationServerKey = base64UrlToUint8Array(String(config.pushPublicKey));
    let subscription = await registration.pushManager.getSubscription();

    // A subscription created with an older VAPID public key cannot be used
    // with the current private key. Replace it instead of silently saving it.
    if (subscription?.options?.applicationServerKey) {
      const existingKey = new Uint8Array(subscription.options.applicationServerKey);
      const keysMatch = existingKey.length === applicationServerKey.length &&
        existingKey.every((byte, index) => byte === applicationServerKey[index]);
      if (!keysMatch) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
    }

    const { data, error } = await state.client.functions.invoke("manage-push-subscription", {
      body: { scope, subscription: subscription.toJSON(), ...extra }
    });
    if (error) {
      let detail = error.message || "Could not save the notification subscription.";
      try { const payload = await error.context?.json(); if (payload?.error) detail = payload.error; } catch {}
      throw new Error(detail);
    }
    if (!data?.success) throw new Error(data?.error || "Could not save the notification subscription.");
    return data;
  }

  function signOutAndReset() {
    state.session = null;
    state.user = null;
    state.requests = [];
    state.role = "user";
    state.section = "dns";
    state.authMode = "landing";
    state.passwordRecovery = false;
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

    const hasApprovedSites = state.requests.some((item) => item.status === "approved" && (state.role === "admin" || item.user_id === state.user?.id));
    const links = state.role === "admin"
      ? [{ id: "home", label: "Home" }, { id: "admin", label: "Applications" }, { id: "dns", label: "DNS Records" }, ...(hasApprovedSites ? [{ id: "website", label: "Website" }] : []), { id: "info", label: "Info" }, { id: "account", label: "Account" }]
      : [{ id: "home", label: "Home" }, { id: "dns", label: "DNS Records" }, ...(hasApprovedSites ? [{ id: "website", label: "Website" }] : []), { id: "info", label: "Info" }, { id: "account", label: "Account" }];

    sidebar.innerHTML = `<nav class="nav-list" aria-label="Main navigation">${links.map((link) => `
      <button class="nav-button" data-section="${link.id}" aria-current="${state.section === link.id ? "page" : "false"}">${link.label}</button>
    `).join("")}</nav>`;
    sidebar.querySelectorAll("[data-section]").forEach((button) => {
      button.addEventListener("click", async () => {
        const nextSection = button.dataset.section;
        if (state.section === "website" && nextSection !== "website") {
          await saveWebsiteFile(false);
          cleanupWebsiteEditor();
        }
        state.section = nextSection;
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
    if (state.authMode === "password-update") {
      renderPasswordUpdate();
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
        <button type="button" class="badge-copy-prompt" id="copy-badge-prompt">Get our badge, tap me or the button to copy it!</button>
        <button type="button" class="button button-secondary button-small" id="copy-badge-code">Copy badge HTML</button>
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
        <div class="page-heading"><h1>${isReset ? "Reset password" : "Log in"}</h1><p class="lede">${isReset ? "Enter the email address on your account and we’ll send a secure reset link." : `Welcome back to ${escapeHTML(rootDomain)}.`}</p></div>
        <form id="auth-form" class="form">
          <div class="field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></div>
          ${isReset ? "" : `<div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="current-password" required></div>`}
          <div class="actions"><button class="button button-primary" type="submit">${isReset ? "Send reset link" : "Log in"}</button><button class="button button-quiet" type="button" id="back-home">Back to home</button>${isReset ? "" : `<button class="text-button" type="button" id="forgot-password">Forgot password?</button>`}</div>
        </form>
        ${isReset ? "" : `<div class="auth-passkey-divider"><span>or</span></div><button class="button button-secondary" id="signin-passkey" type="button">Sign in with a passkey</button><p class="small">Use a passkey saved on this device or in your password manager.</p>`}
      </section>`;

    app.querySelector("#auth-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const email = String(form.get("email") || "").trim();
      const button = event.currentTarget.querySelector("button[type='submit']");
      button.disabled = true;
      try {
        if (isReset) {
          const redirectTo = `${window.location.origin}${window.location.pathname}`;
          const { error } = await state.client.auth.resetPasswordForEmail(email, { redirectTo });
          if (error) throw error;
          showNotice("If that account exists, a password reset email has been sent.", "success");
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

    app.querySelector("#signin-passkey")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      if (!state.client.auth.signInWithPasskey) {
        showNotice("Passkeys need the latest Supabase JavaScript library (v2.105.0 or later) and must be enabled in Supabase Authentication settings.", "error");
        return;
      }
      button.disabled = true;
      button.textContent = "Waiting for passkey…";
      try {
        const { data, error } = await state.client.auth.signInWithPasskey();
        if (error) throw error;
        state.session = data.session;
        state.user = data.user;
        state.section = "dns";
        await renderCurrentView();
      } catch (error) {
        showNotice(error?.message || "Passkey sign-in failed.", "error");
      } finally {
        const current = app.querySelector("#signin-passkey");
        if (current) { current.disabled = false; current.textContent = "Sign in with a passkey"; }
      }
    });
  }

  function renderPasswordUpdate() {
    app.innerHTML = `
      <section class="auth-card password-recovery-card">
        <div class="brand-mark brand-mark-small">${colorText("is-aroace")}</div>
        <div class="accent-rule" aria-hidden="true"></div>
        <div class="page-heading"><h1>Choose a new password</h1><p class="lede">Your reset link is verified. Set a new password for your account.</p></div>
        <form id="password-update-form" class="form">
          <div class="field"><label for="new-password">New password</label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
          <div class="field"><label for="confirm-password">Confirm new password</label><input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required></div>
          <div class="actions"><button class="button button-primary" type="submit">Update password</button><button class="button button-quiet" id="recovery-cancel" type="button">Back to home</button></div>
        </form>
      </section>`;

    app.querySelector("#password-update-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const password = String(form.get("password") || "");
      const confirmation = String(form.get("confirmPassword") || "");
      if (password.length < 8) return showNotice("Use at least 8 characters for your new password.", "error");
      if (password !== confirmation) return showNotice("The passwords do not match.", "error");
      const button = event.currentTarget.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = "Updating…";
      try {
        const { error } = await state.client.auth.updateUser({ password });
        if (error) throw error;
        state.passwordRecovery = false;
        state.authMode = "landing";
        showNotice("Your password has been updated.", "success");
        state.section = "dns";
        await renderCurrentView();
      } catch (error) {
        showNotice(error?.message || "Could not update your password. Request a fresh reset link and try again.", "error");
        const current = app.querySelector("#password-update-form button[type='submit']");
        if (current) { current.disabled = false; current.textContent = "Update password"; }
      }
    });
    app.querySelector("#recovery-cancel")?.addEventListener("click", async () => {
      state.passwordRecovery = false;
      state.authMode = "landing";
      await state.client.auth.signOut({ scope: "local" });
      renderPublic();
    });
  }

  function renderPublicRequest() {
    const prefill = escapeHTML(state.prefillLabel);
    let applicantNotificationToken = null;
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
        try { applicantNotificationToken = await createApplicantNotificationToken(); } catch (tokenError) {
          console.warn("Could not prepare optional applicant push notifications:", tokenError);
          applicantNotificationToken = null;
        }
        const { error } = await state.client.from("subdomain_requests").insert({
          applicant_name: applicantName,
          email,
          requested_label: label,
          reason: purpose,
          preview_url: preview.value,
          notification_token_hash: applicantNotificationToken?.hash || null,
          user_id: null,
          status: "pending"
        });
        if (error) throw error;
        const pushReady = Boolean(applicantNotificationToken && browserSupportsPush());
        app.innerHTML = `<section class="auth-card"><div class="accent-rule"></div><div class="page-heading"><h1>Request received</h1><p class="lede">Your request for <strong>${escapeHTML(label)}.${escapeHTML(rootDomain)}</strong> has been submitted for review. If approved, an account invitation will be sent to ${escapeHTML(email)}.</p></div><div class="section panel-section"><button class="button button-secondary" id="enable-applicant-push" type="button" ${pushReady ? "" : "disabled"}>${pushReady ? "Enable status notifications (optional)" : "Push notifications unavailable"}</button><p class="small" id="applicant-push-status" aria-live="polite">${pushReady ? "Get a notification if your request is accepted or declined, even when this site is closed." : escapeHTML(pushUnavailableMessage())}</p></div><button class="button button-primary" id="new-request">Submit another request</button><button class="button button-quiet" id="request-done-home">Back to home</button></section>`;
        app.querySelector("#enable-applicant-push")?.addEventListener("click", async (pushEvent) => {
          const pushButton = pushEvent.currentTarget;
          const status = app.querySelector("#applicant-push-status");
          pushButton.disabled = true;
          pushButton.textContent = "Enabling…";
          try {
            await savePushSubscription("applicant", { notificationToken: applicantNotificationToken.token });
            pushButton.textContent = "Status notifications enabled";
            if (status) status.textContent = "This device will be notified when your request is accepted or declined.";
            applicantNotificationToken = null;
            showNotice("Status notifications enabled.", "success");
          } catch (pushError) {
            pushButton.disabled = false;
            pushButton.textContent = "Enable status notifications (optional)";
            if (status) status.textContent = pushError.message || "Could not enable notifications.";
            showNotice(pushError.message || "Could not enable notifications.", "error");
          }
        });
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
      .select("id,user_id,applicant_name,email,requested_label,reason,preview_url,status,admin_note,reviewed_by,reviewed_at,created_at,website_published,website_published_at")
      .order("created_at", { ascending: false });
    if (state.role !== "admin") query = query.eq("user_id", state.user.id);
    const { data, error } = await query;
    if (error) throw error;
    state.requests = data || [];

    if (state.section === "nameservers") state.section = "dns";
    const hasApprovedSites = state.requests.some((item) => item.status === "approved" && (state.role === "admin" || item.user_id === state.user.id));
    if (state.role === "admin" && !["home", "admin", "dns", "website", "info", "account"].includes(state.section)) state.section = "admin";
    if (state.role !== "admin" && !["home", "dns", "website", "info", "account"].includes(state.section)) state.section = "dns";
    if (state.section === "website" && !hasApprovedSites) state.section = "dns";
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
      else if (state.section === "website") await renderWebsiteEditor();
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
    const otherDomains = isAdmin ? approved.filter((item) => item.user_id !== state.user.id) : [];

    const renderDomainGroup = (domains) => `      ${domains.length
        ? `<div class="domain-settings-list">${domains.map((request) => `
          <section class="domain-card" data-domain-card data-request-id="${escapeHTML(request.id)}">
            <div class="domain-card-heading">
              <div>
                
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
            ${request.website_published ? `<p class="inline-note">A website is published on this subdomain. The apex A, AAAA, CNAME, NS, DS, and DNAME records are reserved for website routing. Unpublish the website before changing those records.</p>` : ""}
            <div class="legacy-ns-warning hidden" data-legacy-warning>We found an old NS delegation for this subdomain. Saving a DNS record below will remove that delegation so records can be managed here.</div>
            <div class="record-list" data-record-list><p class="small">Loading DNS records…</p></div>
            <form class="record-form" data-record-form>
              <h3>Add or replace a record</h3>
              <div class="record-form-grid">
                <div class="field"><label>Host</label><input name="recordName" value="@" required maxlength="253" placeholder="@ or www"><span class="field-hint">Relative to this subdomain.</span></div>
                <div class="field"><label>Type</label><select name="type">${supportedTypes.map((type) => `<option value="${type}">${type}</option>`).join("")}</select></div>
                <div class="field"><label>TTL (seconds)</label><input name="ttl" type="number" min="60" max="86400" step="60" value="3600" required></div>
              </div>
              <div class="field"><label>Record value(s)</label><textarea name="records" rows="3" required spellcheck="false" placeholder="One value per line"></textarea><span class="field-hint" data-type-help>${dnsRecordTypeHelp("A")}</span></div>
              <div class="actions"><button class="button button-primary" type="submit">Save DNS record</button><span class="small" data-record-result aria-live="polite"></span></div>
            </form>
          </section>
        `).join("")}</div>`
        : `<p class="empty compact-empty">No approved subdomains in this section.</p>`}`;

    app.innerHTML = `
      <div class="page-heading">
        
        <h1>DNS records</h1>
        <p class="lede">
          ${isAdmin
            ? "Manage DNS records for every approved subdomain. You can also remove a subdomain and its DNS records."
            : "Add and edit A, AAAA, CNAME, MX, TXT, SRV, and CAA records for your approved subdomains."}
          DNS is managed here—no external nameserver setup is needed.
        </p>
      </div>
      ${isAdmin ? `
        <section class="section panel-section"><h2>MY domains</h2>${renderDomainGroup(myDomains)}</section>
        <hr class="rule">
        <section class="section panel-section"><h2>Others' domains</h2>${renderDomainGroup(otherDomains)}</section>
      ` : myDomains.length ? renderDomainGroup(myDomains) : `<section class="empty-state"><h2>No approved subdomains yet</h2><p>Your DNS editor appears here after an administrator approves one of your requests.</p><button class="button button-primary" id="request-first-domain">Request a subdomain</button></section>`}
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
            <button class="button button-danger button-small" data-delete-record
              data-host="${escapeHTML(record.host)}" data-type="${escapeHTML(record.type)}" type="button">
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
              await invokeDnsFunction({ action: "delete", requestId, recordName: host, type });
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
        recordsContainer.innerHTML = `<p class="inline-note">Could not load DNS records: ${escapeHTML(error.message || "Unknown error")}</p>`;
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = new FormData(form);
        const recordName = String(values.get("recordName") || "@").trim().toLowerCase();
        const type = String(values.get("type") || "A").toUpperCase();
        const ttl = Number(values.get("ttl"));
        const records = String(values.get("records") || "")
          .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);

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

        if (request.website_published && recordName === "@" && ["A", "AAAA", "CNAME"].includes(type)) {
          result.textContent = "This record conflicts with the published website. Unpublish the website first.";
          return;
        }
        const button = form.querySelector("button[type='submit']");
        if (!button) return;
        button.disabled = true;
        result.textContent = legacyNsFound ? "Switching from old NS delegation and saving…" : "Saving to DNS…";

        try {
          await invokeDnsFunction({ action: "set", requestId, recordName, type, ttl, records });
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
        if (!window.confirm(`ADMIN ACTION: Permanently delete ${fullDomain}, its DNS records, and its assignment? This cannot be undone.`)) return;

        const confirmation = window.prompt(`Type DELETE ${request.requested_label} to confirm removal of ${fullDomain}.`);
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

  async function invokeWebsiteFunction(body) {
    const { data, error } = await state.client.functions.invoke("manage-website", { body });
    if (error) {
      let detail = error.message || "Website request failed.";
      try { const payload = await error.context?.json(); if (payload?.error) detail = payload.error; } catch {}
      throw new Error(detail);
    }
    if (!data?.success) throw new Error(data?.error || "Website operation failed.");
    return data;
  }

  function base64ToBytes(value) {
    const binary = window.atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function bytesToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return window.btoa(binary);
  }

  function websiteLanguage(path) {
    const ext = String(path || "").split(".").pop().toLowerCase();
    return ({
      html: "html", htm: "html", css: "css", js: "javascript", mjs: "javascript",
      json: "json", md: "markdown", txt: "plaintext", xml: "xml", svg: "xml",
      yml: "yaml", yaml: "yaml", ts: "typescript", tsx: "typescript", jsx: "javascript",
      scss: "scss", less: "less", sh: "shell", py: "python", sql: "sql",
    })[ext] || "plaintext";
  }

  function isWebsiteTextFile(path, mimeType = "") {
    const ext = String(path || "").split(".").pop().toLowerCase();
    return ["html", "htm", "css", "js", "mjs", "json", "md", "txt", "xml", "svg", "yml", "yaml", "ts", "tsx", "jsx", "scss", "less", "sh", "py", "sql", "webmanifest", "csv"].includes(ext) || String(mimeType).startsWith("text/");
  }

  function websiteFileName(path) {
    return String(path || "").split("/").pop() || String(path || "");
  }

  function cleanupWebsiteEditor() {
    if (state.websiteSaveTimer) clearTimeout(state.websiteSaveTimer);
    state.websiteSaveTimer = null;
    if (state.websiteEditor) {
      try { state.websiteEditor.dispose(); } catch {}
      state.websiteEditor = null;
    }
    state.websiteEditorModels.clear();
    state.websiteFallbackEditor = null;
    state.websiteDirty = false;
    state.websiteSaving = false;
    state.websiteCurrentPath = "";
    state.websiteCurrentFile = null;
    state.websiteOpenTabs = [];
  }

  let monacoLoaderPromise = null;
  function loadMonacoEditor() {
    if (window.monaco?.editor) return Promise.resolve(window.monaco);
    if (monacoLoaderPromise) return monacoLoaderPromise;
    const cdnRoot = "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/";
    monacoLoaderPromise = new Promise((resolve, reject) => {
      const begin = () => {
        if (!window.require?.config) { reject(new Error("The code editor loader is unavailable.")); return; }
        window.MonacoEnvironment = {
          getWorkerUrl: () => `data:text/javascript;charset=utf-8,${encodeURIComponent(`self.MonacoEnvironment={baseUrl:"${cdnRoot}"};importScripts("${cdnRoot}vs/base/worker/workerMain.js");`)}`,
        };
        window.require.config({ paths: { vs: `${cdnRoot}vs` } });
        window.require(["vs/editor/editor.main"], () => {
          if (window.monaco?.editor) resolve(window.monaco);
          else reject(new Error("The code editor did not initialize."));
        }, reject);
      };
      if (window.require?.config) { begin(); return; }
      const script = document.createElement("script");
      script.src = `${cdnRoot}vs/loader.js`;
      script.async = true;
      script.onload = begin;
      script.onerror = () => reject(new Error("Could not load the online code editor. Use the text editor fallback below."));
      document.head.appendChild(script);
    }).catch((error) => {
      monacoLoaderPromise = null;
      throw error;
    });
    return monacoLoaderPromise;
  }

  function websiteStatus(message, isError = false) {
    const status = app.querySelector("#website-save-status");
    if (status) {
      status.textContent = message;
      status.dataset.error = isError ? "true" : "false";
    }
  }

  function websiteEditorValue() {
    if (state.websiteEditor) return state.websiteEditor.getValue();
    if (state.websiteFallbackEditor) return state.websiteFallbackEditor.value;
    return "";
  }

  function setWebsiteEditorValue(value, path) {
    const container = app.querySelector("#website-monaco-editor");
    const fallback = app.querySelector("#website-editor-fallback");
    if (!container || !fallback) return;
    if (state.websiteEditor) {
      state.websiteEditor.setValue(value);
      const model = state.websiteEditor.getModel();
      if (model) window.monaco.editor.setModelLanguage(model, websiteLanguage(path));
      return;
    }
    fallback.value = value;
    state.websiteFallbackEditor = fallback;
  }

  async function saveWebsiteFile(showSaved = false) {
    if (!state.websiteCurrentPath || !state.websiteCurrentFile || !isWebsiteTextFile(state.websiteCurrentPath, state.websiteCurrentFile.mime_type)) return true;
    if (!state.websiteDirty) return true;
    const content = websiteEditorValue();
    websiteStatus("Saving…");
    state.websiteSaving = true;
    try {
      const encoded = bytesToBase64(new TextEncoder().encode(content));
      const data = await invokeWebsiteFunction({
        action: "save-file",
        requestId: state.websiteRequestId,
        path: state.websiteCurrentPath,
        contentBase64: encoded,
        mimeType: state.websiteCurrentFile.mime_type || "text/plain; charset=utf-8",
      });
      state.websiteCurrentFile.updated_at = data.file?.updated_at || new Date().toISOString();
      state.websiteCurrentFile.content_base64 = encoded;
      state.websiteDirty = false;
      state.websiteSaving = false;
      websiteStatus(showSaved ? "Saved" : "All changes saved");
      return true;
    } catch (error) {
      state.websiteSaving = false;
      websiteStatus(error.message || "Could not save changes", true);
      showNotice(error.message || "Could not save the website file.", "error");
      return false;
    }
  }

  function scheduleWebsiteSave() {
    state.websiteDirty = true;
    websiteStatus("Unsaved changes");
    if (state.websiteSaveTimer) clearTimeout(state.websiteSaveTimer);
    state.websiteSaveTimer = setTimeout(() => {
      state.websiteSaveTimer = null;
      saveWebsiteFile(false);
    }, 900);
  }

  async function getWebsiteFile(path) {
    return invokeWebsiteFunction({ action: "get-file", requestId: state.websiteRequestId, path });
  }

  function renderWebsiteTree() {
    const tree = app.querySelector("#website-file-tree");
    if (!tree) return;
    const entries = [...state.websiteEntries].sort((a, b) => {
      const depthA = String(a.path).split("/").length;
      const depthB = String(b.path).split("/").length;
      if (depthA !== depthB) return depthA - depthB;
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return String(a.path).localeCompare(String(b.path));
    });
    tree.innerHTML = entries.map((entry) => {
      const depth = String(entry.path).split("/").length - 1;
      const selected = entry.path === state.websiteSelectedEntryPath;
      const symbol = entry.kind === "folder" ? "▸" : "";
      return `<button type="button" class="website-file-row ${selected ? "is-selected" : ""}" data-website-path="${escapeHTML(entry.path)}" data-entry-kind="${escapeHTML(entry.kind)}" style="--tree-depth:${depth}"><span class="website-file-symbol">${symbol || "·"}</span><span class="website-file-label">${escapeHTML(websiteFileName(entry.path))}</span></button>`;
    }).join("") || `<p class="small website-empty-files">No files yet.</p>`;
    tree.querySelectorAll("[data-website-path]").forEach((button) => {
      button.addEventListener("click", async () => {
        const path = button.dataset.websitePath;
        state.websiteSelectedEntryPath = path;
        state.websiteSelectedEntryKind = button.dataset.entryKind;
        if (button.dataset.entryKind === "folder") {
          state.websiteSelectedFolder = path;
          const deleteButton = app.querySelector("#website-delete-entry");
          if (deleteButton) deleteButton.disabled = false;
          renderWebsiteTree();
          return;
        }
        state.websiteSelectedFolder = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
        const deleteButton = app.querySelector("#website-delete-entry");
        if (deleteButton) deleteButton.disabled = false;
        await openWebsiteFile(path);
      });
    });
  }

  async function openWebsiteFile(path) {
    if (state.websiteCurrentPath === path) return;
    if (state.websiteCurrentPath && state.websiteCurrentPath !== path) {
      const saved = await saveWebsiteFile(false);
      if (!saved) return;
    }
    const entry = state.websiteEntries.find((item) => item.path === path && item.kind === "file");
    if (!entry) return;
    try {
      websiteStatus("Opening…");
      const result = await getWebsiteFile(path);
      state.websiteCurrentPath = path;
      state.websiteCurrentFile = result.file;
      if (!state.websiteOpenTabs.includes(path)) state.websiteOpenTabs.push(path);
      renderWebsiteTabs();
      const binary = !isWebsiteTextFile(path, result.file.mime_type);
      const editorWrap = app.querySelector("#website-editor-wrap");
      if (binary) {
        if (state.websiteEditor) { state.websiteEditor.dispose(); state.websiteEditor = null; }
        state.websiteFallbackEditor = null;
        if (editorWrap) editorWrap.innerHTML = `<div class="website-binary-note"><strong>${escapeHTML(websiteFileName(path))}</strong><p>This is a binary asset. It is stored and can be used by your site, but it is not opened as text.</p><p class="small">Reference it from HTML, for example <code>&lt;img src="/${escapeHTML(path)}" alt=""&gt;</code>.</p></div>`;
      } else {
        if (!app.querySelector("#website-monaco-editor") && editorWrap) {
          if (state.websiteEditor) { state.websiteEditor.dispose(); state.websiteEditor = null; }
          editorWrap.innerHTML = `<div id="website-monaco-editor" class="website-monaco-editor"></div><textarea id="website-editor-fallback" class="website-editor-fallback" spellcheck="false" aria-label="Website source code" hidden></textarea>`;
        }
        const text = new TextDecoder().decode(base64ToBytes(result.file.content_base64));
        try {
          const monaco = await loadMonacoEditor();
          const host = app.querySelector("#website-monaco-editor");
          if (!host) return;
          if (!state.websiteEditor) {
            state.websiteEditor = monaco.editor.create(host, {
              value: text,
              language: websiteLanguage(path),
              theme: "vs-dark",
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13,
              lineHeight: 21,
              tabSize: 2,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              renderLineHighlight: "line",
              padding: { top: 12, bottom: 12 },
              overviewRulerLanes: 0,
              scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
            });
            state.websiteEditor.onDidChangeModelContent(() => {
              if (!state.websiteProgrammaticChange) scheduleWebsiteSave();
            });
          } else {
            state.websiteProgrammaticChange = true;
            state.websiteEditor.setValue(text);
            monaco.editor.setModelLanguage(state.websiteEditor.getModel(), websiteLanguage(path));
            state.websiteProgrammaticChange = false;
          }
          const textarea = app.querySelector("#website-editor-fallback");
          if (textarea) textarea.hidden = true;
        } catch (error) {
          const textarea = app.querySelector("#website-editor-fallback");
          if (!textarea) throw error;
          textarea.hidden = false;
          textarea.value = text;
          state.websiteFallbackEditor = textarea;
          textarea.addEventListener("input", scheduleWebsiteSave);
          websiteStatus("Text editor mode · syntax editor unavailable");
        }
      }
      if (!state.websiteDirty) websiteStatus("Saved");
      renderWebsiteTree();
    } catch (error) {
      showNotice(error.message || "Could not open this file.", "error");
    }
  }

  function renderWebsiteTabs() {
    const tabs = app.querySelector("#website-open-tabs");
    if (!tabs) return;
    tabs.innerHTML = state.websiteOpenTabs.map((path) => `
      <button type="button" class="website-tab ${path === state.websiteCurrentPath ? "is-active" : ""}" data-website-tab="${escapeHTML(path)}">
        <span>${escapeHTML(websiteFileName(path))}</span><span class="website-tab-close" data-close-tab="${escapeHTML(path)}" aria-label="Close ${escapeHTML(websiteFileName(path))}">×</span>
      </button>`).join("");
    tabs.querySelectorAll("[data-website-tab]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        const closeTarget = event.target.closest("[data-close-tab]");
        const path = button.dataset.websiteTab;
        if (closeTarget) {
          if (path === state.websiteCurrentPath && !(await saveWebsiteFile(false))) return;
          state.websiteOpenTabs = state.websiteOpenTabs.filter((item) => item !== path);
          if (path === state.websiteCurrentPath) {
            state.websiteCurrentPath = "";
            state.websiteCurrentFile = null;
            if (state.websiteEditor) state.websiteEditor.setValue("");
            const next = state.websiteOpenTabs[state.websiteOpenTabs.length - 1];
            if (next) await openWebsiteFile(next);
            else {
              const wrap = app.querySelector("#website-editor-wrap");
              if (wrap) wrap.innerHTML = `<div class="website-editor-placeholder">Select a file to start editing.</div>`;
            }
          }
          renderWebsiteTabs();
          renderWebsiteTree();
          return;
        }
        await openWebsiteFile(path);
      });
    });
  }

  function websiteAssetPath(raw, currentPath, domain) {
    const value = String(raw || "").trim();
    if (!value || /^(?:[a-z]+:|\/\/|#|data:|blob:)/i.test(value)) return null;
    try {
      const base = new URL(`https://${domain}/${currentPath}`);
      const resolved = new URL(value, base);
      if (resolved.hostname !== domain) return null;
      const decoded = decodeURIComponent(resolved.pathname).replace(/^\/+/, "");
      const parts = decoded.split("/");
      if (parts.some((part) => part === ".." || part === ".")) return null;
      return decoded;
    } catch { return null; }
  }

  async function renderWebsitePreview() {
    await saveWebsiteFile(false);
    const frame = app.querySelector("#website-preview-frame");
    if (!frame) return;
    const activeIndexPath = state.websiteCurrentPath && /(?:^|\/)index\.html$/i.test(state.websiteCurrentPath)
      ? state.websiteCurrentPath
      : "index.html";
    const previewEntry = state.websiteEntries.find((item) => item.path === activeIndexPath && item.kind === "file");
    if (!previewEntry) {
      frame.srcdoc = "<!doctype html><p style='font-family:Arial;padding:24px'>Create an <code>index.html</code> file to preview this folder. Root preview uses <code>/index.html</code>.</p>";
      return;
    }
    const domain = `${state.requests.find((item) => item.id === state.websiteRequestId)?.requested_label || "site"}.${rootDomain}`;
    try {
      const { file } = await getWebsiteFile(activeIndexPath);
      const html = new TextDecoder().decode(base64ToBytes(file.content_base64));
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const candidates = [
        ...parsed.querySelectorAll("script[src], img[src], source[src], video[src], audio[src], link[href]")
      ];
      for (const node of candidates) {
        const attribute = node.hasAttribute("src") ? "src" : "href";
        const raw = node.getAttribute(attribute);
        const assetPath = websiteAssetPath(raw, activeIndexPath, domain);
        if (!assetPath) continue;
        try {
          const assetResponse = await getWebsiteFile(assetPath);
          const asset = assetResponse.file;
          const assetMime = String(asset.mime_type || "application/octet-stream");
          if (node.tagName.toLowerCase() === "script") {
            const code = new TextDecoder().decode(base64ToBytes(asset.content_base64)).replace(/<\/script/gi, "<\\/script");
            node.removeAttribute("src");
            node.textContent = code;
          } else if (node.tagName.toLowerCase() === "link" && /stylesheet/i.test(node.getAttribute("rel") || "")) {
            const css = new TextDecoder().decode(base64ToBytes(asset.content_base64)).replace(/<\/style/gi, "<\\/style");
            const style = parsed.createElement("style");
            style.textContent = css;
            node.replaceWith(style);
          } else {
            node.setAttribute(attribute, `data:${assetMime};base64,${asset.content_base64}`);
          }
        } catch { /* Missing local assets stay as their original URL in the preview. */ }
      }
      parsed.querySelectorAll("base").forEach((node) => node.remove());
      frame.srcdoc = `<!doctype html>${parsed.documentElement.outerHTML}`;
      websiteStatus("Preview updated");
    } catch (error) {
      websiteStatus("Preview unavailable", true);
      showNotice(error.message || "Could not build the preview.", "error");
    }
  }

  async function renderWebsiteEditor() {
    cleanupWebsiteEditor();
    const domains = state.requests.filter((item) => item.status === "approved" && (state.role === "admin" || item.user_id === state.user.id));
    if (!domains.length) {
      app.innerHTML = `<div class="page-heading"><h1>Website</h1><p class="lede">The website editor appears after a subdomain is approved.</p></div>`;
      return;
    }
    if (!domains.some((item) => item.id === state.websiteRequestId)) state.websiteRequestId = domains[0].id;
    const selected = domains.find((item) => item.id === state.websiteRequestId);
    const fullDomain = `${selected.requested_label}.${rootDomain}`;
    if (!document.querySelector("#website-ide-styles")) {
      const style = document.createElement("style");
      style.id = "website-ide-styles";
      style.textContent = `
        .website-ide {
          --ide-bg: #0d1117;
          --ide-panel: #111821;
          --ide-panel-2: #161f2b;
          --ide-border: #263241;
          --ide-text: #d7e0ea;
          --ide-muted: #8795a6;
          display: flex;
          flex-direction: column;
          width: 100%;
          min-height: calc(100vh - 132px);
          overflow: hidden;
          color: var(--ide-text);
          background: var(--ide-bg);
          border: 1px solid var(--ide-border);
          border-radius: 12px;
          box-shadow: 0 12px 36px rgba(0,0,0,.16);
        }
        .website-ide, .website-ide * { box-sizing: border-box; }
        .website-ide-topbar {
          position: relative;
          z-index: 5;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          min-height: 56px;
          padding: 9px 14px;
          background: var(--ide-panel);
          border-bottom: 1px solid var(--ide-border);
        }
        .website-ide-domain-controls { display:flex; align-items:center; gap:9px; min-width:0; }
        .website-ide-domain-controls select {
          max-width: min(62vw, 360px);
          min-width: 150px;
          color: var(--ide-text);
          background: var(--ide-panel-2);
          border: 1px solid var(--ide-border);
          border-radius: 7px;
          padding: 8px 30px 8px 10px;
        }
        .website-ide .website-info-button {
          width: 30px; height: 30px; min-width: 30px; padding: 0;
          color: var(--ide-muted); border: 1px solid var(--ide-border);
          background: transparent; border-radius: 7px;
        }
        .website-ide-open-site {
          color: #a9c7ff !important;
          border: 1px solid var(--ide-border) !important;
          background: transparent !important;
          white-space: nowrap;
        }
        .website-ide-menu { position:relative; margin-left:auto; }
        .website-ide-menu > summary {
          display:flex; align-items:center; justify-content:center;
          width:36px; height:36px; border:1px solid var(--ide-border);
          border-radius:8px; color:var(--ide-text); background:var(--ide-panel-2);
          cursor:pointer; list-style:none; font-size:23px; line-height:1;
          letter-spacing:1px; user-select:none;
        }
        .website-ide-menu > summary::-webkit-details-marker { display:none; }
        .website-ide-menu[open] > summary,
        .website-ide-menu > summary:hover { background:#202c3b; border-color:#40536a; }
        .website-ide-menu-popover {
          position:absolute; top:43px; right:0; z-index:20;
          display:flex; flex-direction:column; gap:4px;
          width:210px; padding:7px;
          background:#151e29; border:1px solid #344255;
          border-radius:10px; box-shadow:0 14px 38px rgba(0,0,0,.42);
        }
        .website-ide-menu-popover .button {
          width:100%; justify-content:flex-start; text-align:left;
          color:var(--ide-text) !important; background:transparent !important;
          border:0 !important; border-radius:6px; padding:9px 10px;
        }
        .website-ide-menu-popover .button:hover:not(:disabled) { background:#243244 !important; }
        .website-ide-menu-popover .button:disabled { opacity:.38; }
        .website-ide-menu-popover .website-menu-divider {
          height:1px; margin:4px 2px; background:var(--ide-border);
        }
        .website-ide-menu-popover .website-save-status {
          padding:5px 10px; color:var(--ide-muted); font-size:12px;
        }
        .website-ide-menu-popover .website-save-status[data-error="true"] { color:#ff8c8c; }
        .website-ide-workbench {
          display:grid; grid-template-columns:230px minmax(0,1fr);
          flex:1; min-height:560px; height:calc(100vh - 190px);
          background:var(--ide-bg);
        }
        .website-ide .website-explorer {
          min-width:0; overflow:auto; padding:0;
          background:var(--ide-panel); border-right:1px solid var(--ide-border);
        }
        .website-ide .website-pane-heading {
          position:sticky; top:0; z-index:1;
          display:flex; justify-content:space-between; gap:8px;
          padding:13px 14px 11px; color:#aebdce;
          background:var(--ide-panel); border-bottom:1px solid var(--ide-border);
          font-size:11px; font-weight:700; letter-spacing:.09em;
        }
        .website-ide .website-pane-heading .small { color:var(--ide-muted); font-weight:400; letter-spacing:0; }
        .website-ide .website-file-tree { padding:8px 7px; }
        .website-ide .website-file-row {
          display:flex; align-items:center; gap:8px; width:100%;
          min-height:31px; padding:5px 8px 5px calc(8px + var(--tree-depth)*13px);
          color:#b9c6d5; background:transparent; border:0; border-radius:5px;
          text-align:left; font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          cursor:pointer;
        }
        .website-ide .website-file-row:hover { background:#1b2735; color:#eef5ff; }
        .website-ide .website-file-row.is-selected { color:#fff; background:#203149; }
        .website-ide .website-file-symbol { color:#8194aa; flex:none; }
        .website-ide .website-empty-files { padding:8px; color:var(--ide-muted); }
        .website-ide .website-code-area {
          display:flex; flex-direction:column; min-width:0; min-height:0;
          height:100%; background:var(--ide-bg);
        }
        .website-ide .website-open-tabs {
          min-height:38px; background:#101720; border-bottom:1px solid var(--ide-border);
        }
        .website-ide .website-editor-wrap {
          flex:1; min-height:480px; height:calc(100vh - 260px);
          background:#0d1117; overflow:hidden;
        }
        .website-ide .website-monaco-editor { width:100%; height:100%; min-height:480px; }
        .website-ide .website-editor-fallback {
          width:100%; height:100%; min-height:480px; resize:none;
          padding:16px; color:#d7e0ea; background:#0d1117;
          border:0; outline:none; font:13px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          tab-size:2;
        }
        .website-ide .website-editor-placeholder,
        .website-ide .website-binary-note {
          padding:28px; color:#a9b7c7; background:#0d1117;
          font:13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .website-ide .website-editor-placeholder { min-height:100%; }
        .website-ide .website-binary-note p { color:var(--ide-muted); }
        .website-ide .website-statusbar {
          display:flex; justify-content:space-between; gap:12px;
          min-height:27px; padding:5px 12px; color:#aebbd0;
          background:#17283b; border-top:1px solid #263b54;
          font:11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .website-ide .website-preview-area { display:none !important; }
        @media (max-width:700px) {
          .website-ide { min-height:calc(100vh - 100px); border-radius:8px; }
          .website-ide-workbench { grid-template-columns:112px minmax(0,1fr); height:calc(100vh - 170px); }
          .website-ide .website-pane-heading { padding:11px 8px; font-size:10px; }
          .website-ide .website-pane-heading .small { display:none; }
          .website-ide .website-file-row { font-size:11px; overflow:hidden; }
          .website-ide-domain-controls select { min-width:0; max-width:52vw; font-size:12px; }
          .website-ide .website-editor-wrap { height:calc(100vh - 230px); }
        }
      `;
      document.head.appendChild(style);
    }

    app.innerHTML = `
      <section class="website-ide">
        <header class="website-ide-topbar">
          <div class="website-ide-domain-controls">
            <select id="website-domain-select" aria-label="Select subdomain">${domains.map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === selected.id ? "selected" : ""}>${escapeHTML(item.requested_label)}.${escapeHTML(rootDomain)}</option>`).join("")}</select>
            <button class="button button-small button-quiet website-info-button" id="website-info" type="button" aria-label="Website editor information" title="What is this?">i</button>
            <a class="button button-secondary button-small website-ide-open-site" href="https://${escapeHTML(fullDomain)}/" target="_blank" rel="noopener noreferrer" ${selected.website_published ? "" : "hidden"}>Open site ↗</a>
          </div>
          <details class="website-ide-menu">
            <summary aria-label="Website actions" title="Website actions">⋮</summary>
            <div class="website-ide-menu-popover">
              <button class="button button-small" id="website-new-file" type="button">＋ New file</button>
              <button class="button button-small" id="website-upload-file" type="button">↑ Upload file</button>
              <button class="button button-small" id="website-new-folder" type="button">＋ New folder</button>
              <button class="button button-small" id="website-delete-entry" type="button" disabled>⌫ Delete selected</button>
              <div class="website-menu-divider"></div>
              <span id="website-save-status" class="website-save-status">Saved</span>
              <button class="button button-small" id="website-save" type="button">Save changes</button>
              <button class="button button-small ${selected.website_published ? "button-danger" : "button-primary"}" id="website-publish" type="button">${selected.website_published ? "Unpublish site" : "Publish site"}</button>
              <button class="button button-small" id="website-refresh-preview" type="button">Refresh preview</button>
            </div>
          </details>
          <input id="website-upload-input" type="file" hidden>
        </header>
        <div class="website-ide-workbench">
          <aside class="website-explorer">
            <div class="website-pane-heading"><span>EXPLORER</span><span class="small">${state.websiteEntries.length} items</span></div>
            <div id="website-file-tree" class="website-file-tree"><p class="small">Loading files…</p></div>
          </aside>
          <section class="website-code-area">
            <div id="website-open-tabs" class="website-open-tabs"></div>
            <div id="website-editor-wrap" class="website-editor-wrap"><div class="website-editor-placeholder">Loading your files…</div></div>
            <div class="website-statusbar"><span>${escapeHTML(fullDomain)}</span><span id="website-language-status">HTML</span></div>
          </section>
          <section class="website-preview-area" aria-hidden="true">
            <iframe id="website-preview-frame" title="Website preview" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" srcdoc="<!doctype html><p style='font-family:Arial;padding:24px'>Loading preview…</p>"></iframe>
          </section>
        </div>
      </section>
    `;

    app.querySelector(".website-ide-menu")?.addEventListener("click", (event) => {
      if (event.target.closest("button")) {
        queueMicrotask(() => {
          const menu = app.querySelector(".website-ide-menu");
          if (menu) menu.open = false;
        });
      }
    });

    app.querySelector("#website-info")?.addEventListener("click", () => {
      const popup = document.createElement("dialog");
      popup.className = "website-info-dialog";
      popup.innerHTML = `<div class="website-info-dialog-content"><button class="button button-small button-quiet website-info-close" type="button" aria-label="Close">×</button><h2>What is this?</h2><p>if you dont know how to do the dns thing use this to directly edit the code of your page.</p></div>`;
      document.body.appendChild(popup);
      popup.addEventListener("click", (event) => { if (event.target === popup) popup.close(); });
      popup.querySelector(".website-info-close")?.addEventListener("click", () => popup.close());
      popup.addEventListener("close", () => popup.remove(), { once: true });
      popup.showModal();
    });

    app.querySelector("#website-domain-select")?.addEventListener("change", async (event) => {
      if (!(await saveWebsiteFile(false))) return;
      cleanupWebsiteEditor();
      state.websiteRequestId = event.target.value;
      state.websiteCurrentPath = "";
      state.websiteCurrentFile = null;
      state.websiteOpenTabs = [];
      state.websiteSelectedFolder = "";
      renderCurrentView();
    });

    app.querySelector("#website-save")?.addEventListener("click", () => saveWebsiteFile(true));
    app.querySelector("#website-refresh-preview")?.addEventListener("click", renderWebsitePreview);
    app.querySelector("#website-new-file")?.addEventListener("click", async () => {
      const name = window.prompt("New file name (example: about.html):");
      if (!name) return;
      const folder = window.prompt("Folder path (leave blank for the site root):", state.websiteSelectedFolder || "");
      if (folder === null) return;
      const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, "");
      const cleanName = name.trim().replace(/^\/+/, "");
      const path = [cleanFolder, cleanName].filter(Boolean).join("/");
      if (!path || path.split("/").some((part) => part === ".." || part === ".") || !cleanName || cleanName.includes("/")) {
        showNotice("Enter a valid relative file path.", "error");
        return;
      }
      if (state.websiteEntries.some((item) => item.path === path)) {
        showNotice("A file or folder already exists at that path.", "error");
        return;
      }
      try {
        const mime = ({ html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml" })[path.split(".").pop().toLowerCase()] || "text/plain; charset=utf-8";
        if (cleanFolder) await invokeWebsiteFunction({ action: "create-folder", requestId: state.websiteRequestId, path: cleanFolder });
        await invokeWebsiteFunction({ action: "save-file", requestId: state.websiteRequestId, path, mimeType: mime, contentBase64: bytesToBase64(new TextEncoder().encode("")) });
        if (!state.websiteEntries.some((item) => item.path === path)) state.websiteEntries.push({ path, kind: "file", mime_type: mime });
        state.websiteSelectedFolder = cleanFolder;
        renderWebsiteTree();
        await openWebsiteFile(path);
      } catch (error) { showNotice(error.message || "Could not create the file.", "error"); }
    });
    app.querySelector("#website-new-folder")?.addEventListener("click", async () => {
      const path = window.prompt("New folder path (example: images or assets/icons):", state.websiteSelectedFolder || "");
      if (!path) return;
      try {
        await invokeWebsiteFunction({ action: "create-folder", requestId: state.websiteRequestId, path });
        const parts = path.trim().replace(/^\/+|\/+$/g, "").split("/");
        parts.forEach((_, index) => {
          const folderPath = parts.slice(0, index + 1).join("/");
          if (!state.websiteEntries.some((item) => item.path === folderPath)) state.websiteEntries.push({ path: folderPath, kind: "folder", mime_type: "inode/directory" });
        });
        state.websiteSelectedFolder = path.trim().replace(/^\/+|\/+$/g, "");
        renderWebsiteTree();
        showNotice("Folder created.", "success");
      } catch (error) { showNotice(error.message || "Could not create the folder.", "error"); }
    });
    app.querySelector("#website-upload-file")?.addEventListener("click", () => app.querySelector("#website-upload-input")?.click());
    app.querySelector("#website-upload-input")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const folder = window.prompt(`Folder path for ${file.name} (leave blank for the site root):`, state.websiteSelectedFolder || "");
      if (folder === null) { event.target.value = ""; return; }
      const path = [folder.trim().replace(/^\/+|\/+$/g, ""), file.name].filter(Boolean).join("/");
      if (file.size > 2 * 1024 * 1024) {
        showNotice("Each uploaded file must be 2 MiB or smaller.", "error");
        event.target.value = "";
        return;
      }
      try {
        if (!(await saveWebsiteFile(false))) return;
        const folderPath = folder.trim().replace(/^\/+|\/+$/g, "");
        if (folderPath) await invokeWebsiteFunction({ action: "create-folder", requestId: state.websiteRequestId, path: folderPath });
        const base64 = bytesToBase64(await file.arrayBuffer());
        const mime = file.type || "application/octet-stream";
        await invokeWebsiteFunction({ action: "save-file", requestId: state.websiteRequestId, path, mimeType: mime, contentBase64: base64 });
        const old = state.websiteEntries.findIndex((item) => item.path === path);
        const entry = { path, kind: "file", mime_type: mime, updated_at: new Date().toISOString() };
        if (old >= 0) state.websiteEntries[old] = entry; else state.websiteEntries.push(entry);
        state.websiteCurrentPath = "";
        state.websiteCurrentFile = null;
        state.websiteSelectedEntryPath = path;
        state.websiteSelectedEntryKind = "file";
        await openWebsiteFile(path);
        await renderWebsitePreview();
        showNotice(`${file.name} uploaded.`, "success");
      } catch (error) { showNotice(error.message || "Could not upload the file.", "error"); }
      event.target.value = "";
    });
    app.querySelector("#website-delete-entry")?.addEventListener("click", async () => {
      const path = state.websiteSelectedEntryPath || state.websiteCurrentPath;
      if (!path) return;
      const entry = state.websiteEntries.find((item) => item.path === path);
      if (!entry) return;
      const folder = entry.kind === "folder";
      if (!window.confirm(folder ? `Delete folder "${path}" and everything inside it?` : `Delete file "${path}"?`)) return;
      if (path === state.websiteCurrentPath && !(await saveWebsiteFile(false))) return;
      try {
        await invokeWebsiteFunction({ action: folder ? "delete-folder" : "delete-file", requestId: state.websiteRequestId, path });
        state.websiteEntries = state.websiteEntries.filter((item) => folder ? item.path !== path && !item.path.startsWith(`${path}/`) : item.path !== path);
        state.websiteOpenTabs = state.websiteOpenTabs.filter((item) => folder ? item !== path && !item.startsWith(`${path}/`) : item !== path);
        if (folder) state.websiteSelectedFolder = "";
        state.websiteSelectedEntryPath = "";
        state.websiteSelectedEntryKind = "";
        if (state.websiteCurrentPath === path || folder && state.websiteCurrentPath.startsWith(`${path}/`)) {
          state.websiteCurrentPath = "";
          state.websiteCurrentFile = null;
          if (state.websiteEditor) state.websiteEditor.setValue("");
          const wrap = app.querySelector("#website-editor-wrap");
          if (wrap) wrap.innerHTML = `<div class="website-editor-placeholder">Select a file to start editing.</div>`;
        }
        renderWebsiteTabs();
        renderWebsiteTree();
        showNotice(folder ? "Folder and contents deleted." : "File deleted.", "success");
      } catch (error) { showNotice(error.message || "Could not delete the selected item.", "error"); }
    });
    app.querySelector("#website-publish")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const publishing = !selected.website_published;
      const message = publishing
        ? `Publish ${fullDomain}? Existing apex A, AAAA, CNAME, NS, DS, and DNAME records will be saved and removed so the website router can answer for this subdomain. Other record types such as TXT and MX are kept. You can unpublish to restore saved records.`
        : `Unpublish ${fullDomain}? The previously saved conflicting DNS records will be restored where no newer record exists.`;
      if (!window.confirm(message)) return;
      if (!(await saveWebsiteFile(false))) return;
      button.disabled = true;
      try {
        await invokeWebsiteFunction({ action: publishing ? "publish" : "unpublish", requestId: state.websiteRequestId });
        showNotice(publishing ? "Website published." : "Website unpublished.", "success");
        renderCurrentView();
      } catch (error) {
        showNotice(error.message || "Could not change website publishing status.", "error");
        button.disabled = false;
      }
    });
    app.querySelector("#website-delete-entry").disabled = true;

    try {
      const data = await invokeWebsiteFunction({ action: "list", requestId: state.websiteRequestId });
      state.websiteEntries = Array.isArray(data.entries) ? data.entries : [];
      renderWebsiteTree();
      const deleteButton = app.querySelector("#website-delete-entry");
      app.querySelectorAll("[data-website-path]").forEach((button) => {
        button.addEventListener("click", () => { if (deleteButton) deleteButton.disabled = false; });
      });
      const firstFile = state.websiteEntries.find((item) => item.path === "index.html" && item.kind === "file") || state.websiteEntries.find((item) => item.kind === "file");
      if (firstFile) await openWebsiteFile(firstFile.path);
      await renderWebsitePreview();
      if (selected.website_published) websiteStatus("Published");
      else websiteStatus("Saved · not published");
    } catch (error) {
      const tree = app.querySelector("#website-file-tree");
      if (tree) tree.innerHTML = `<p class="inline-note">Could not load website files: ${escapeHTML(error.message || "Unknown error")}</p>`;
    }
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
      <div class="page-heading"><h1>Account</h1><p class="lede">Request new subdomains, manage your assignments, and control your account.</p></div>
      <section class="section panel-section" id="passkey-security-section"><div class="section-header-row"><div><h2>Passkeys</h2><p class="small">Sign in securely with your device, a PIN, or a password manager instead of typing your password.</p></div><button class="button button-primary button-small" id="add-passkey" type="button">Add passkey</button></div><div id="passkey-list" class="request-list"><p class="small">Loading saved passkeys…</p></div></section>
      <hr class="rule">
      <section class="section panel-section"><h2>Request another subdomain</h2><p class="lede">Requests are reviewed by an administrator. A preview link is optional and may help reviewers understand your project.</p>
        <form id="request-domain-form" class="form">
          <div class="field"><label for="more-domain">Desired subdomain</label><div class="form-domain-row"><input id="more-domain" name="domain" required maxlength="63" placeholder="yourname"><span class="domain-suffix">.${escapeHTML(rootDomain)}</span></div></div>
          <div class="field"><label for="more-purpose">Purpose</label><textarea id="more-purpose" name="purpose" required minlength="10" maxlength="1000" placeholder="What will you use this subdomain for?"></textarea></div>
          <div class="field"><label for="more-preview">Preview link <span class="optional-label">Optional</span></label><input id="more-preview" name="preview_url" type="url" maxlength="2048" placeholder="https://your-project.example"><span class="field-hint">Demo, project page, repository, or mock-up.</span></div>
          <div class="actions"><button class="button button-primary" type="submit">Submit domain request</button><span class="small" id="request-domain-result" aria-live="polite"></span></div>
        </form>
        <div id="request-notification-offer" class="inline-note" hidden></div>
      </section>
      <hr class="rule">
      <section class="section panel-section"><h2>Your requests</h2>${pending.length ? `<div class="request-list">${pending.map((request) => `<article class="request-mini"><div class="domain-card-heading"><strong>${escapeHTML(request.requested_label)}.${escapeHTML(rootDomain)}</strong><span class="status status-pending">Pending review</span></div><p class="small">Submitted ${dateText(request.created_at)}.</p>${request.preview_url ? `<a href="${escapeHTML(request.preview_url)}" target="_blank" rel="noopener noreferrer">Open preview link</a>` : ""}</article>`).join("")}</div>` : `<p class="small">You have no requests waiting for review.</p>`}</section>
      <hr class="rule">
      <section class="section panel-section"><h2>Your approved subdomains</h2>${approved.length ? `<div class="request-list">${approved.map((request) => `<article class="request-mini"><strong>${escapeHTML(request.requested_label)}.${escapeHTML(rootDomain)}</strong><p class="small">Delete only if you are sure. You can request the name again if it is available, but approval is not automatic.</p><button class="button button-danger" data-delete-domain="${escapeHTML(request.id)}">Delete this subdomain</button><span class="small" data-delete-result="${escapeHTML(request.id)}" aria-live="polite"></span></article>`).join("")}</div>` : `<p class="empty compact-empty">You have no approved subdomains assigned to this account.</p>`}</section>
      <hr class="rule">
      <section class="section panel-section"><h2>Delete account</h2><p class="lede">This permanently deletes your app account, requests, and DNS records for your assigned subdomains. The parent domain and Supabase project remain.</p><button class="button button-danger" id="delete-account">Delete my account</button></section>
      <hr class="rule">
      <section class="section panel-section"><h2>Sign out</h2><p class="small">Sign out without deleting your account or domains.</p><button class="button button-secondary" id="account-sign-out">Sign out</button></section>`;

    const passkeyList = app.querySelector("#passkey-list");
    const passkeyApi = state.client.auth.passkey;
    async function refreshPasskeys() {
      if (!passkeyApi?.list) {
        if (passkeyList) passkeyList.innerHTML = `<p class="small">Passkeys require Supabase JavaScript v2.105.0 or later and the Passkeys feature enabled in your Supabase project.</p>`;
        return;
      }
      const { data, error } = await passkeyApi.list();
      if (error) throw error;
      const passkeys = Array.isArray(data) ? data : [];
      if (!passkeyList) return;
      passkeyList.innerHTML = passkeys.length ? passkeys.map((item) => `
        <article class="request-mini passkey-item">
          <div class="domain-card-heading"><strong>${escapeHTML(item.friendly_name || "Passkey")}</strong><span class="status status-approved">Saved</span></div>
          <p class="small">Added ${dateText(item.created_at)}${item.last_used_at ? ` · Last used ${dateText(item.last_used_at)}` : ""}</p>
          <div class="actions"><button class="button button-secondary button-small" type="button" data-rename-passkey="${escapeHTML(item.id)}">Rename</button><button class="button button-danger button-small" type="button" data-delete-passkey="${escapeHTML(item.id)}">Remove</button></div>
        </article>`).join("") : `<p class="small">No passkeys have been added to this account yet.</p>`;
      passkeyList.querySelectorAll("[data-rename-passkey]").forEach((button) => button.addEventListener("click", async () => {
        const passkeyId = button.dataset.renamePasskey;
        const current = passkeys.find((item) => item.id === passkeyId);
        const friendlyName = window.prompt("Name this passkey (for example, Personal laptop):", current?.friendly_name || "");
        if (friendlyName === null) return;
        const name = friendlyName.trim();
        if (!name || name.length > 120) return showNotice("Enter a name between 1 and 120 characters.", "error");
        button.disabled = true;
        try {
          const { error } = await passkeyApi.update({ passkeyId, friendlyName: name });
          if (error) throw error;
          await refreshPasskeys();
          showNotice("Passkey renamed.", "success");
        } catch (error) { showNotice(error.message || "Could not rename this passkey.", "error"); button.disabled = false; }
      }));
      passkeyList.querySelectorAll("[data-delete-passkey]").forEach((button) => button.addEventListener("click", async () => {
        const passkeyId = button.dataset.deletePasskey;
        if (!window.confirm("Remove this passkey from your account? You will no longer be able to use it to sign in.")) return;
        button.disabled = true;
        try {
          const { error } = await passkeyApi.delete({ passkeyId });
          if (error) throw error;
          await refreshPasskeys();
          showNotice("Passkey removed.", "success");
        } catch (error) { showNotice(error.message || "Could not remove this passkey.", "error"); button.disabled = false; }
      }));
    }

    refreshPasskeys().catch((error) => {
      if (passkeyList) passkeyList.innerHTML = `<p class="small">Could not load passkeys: ${escapeHTML(error.message || "Unknown error")}</p>`;
    });
    app.querySelector("#add-passkey")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      if (!state.client.auth.registerPasskey) {
        showNotice("Passkeys require Supabase JavaScript v2.105.0 or later and must be enabled in Supabase Authentication → Passkeys.", "error");
        return;
      }
      button.disabled = true;
      button.textContent = "Follow your device prompt…";
      try {
        const { error } = await state.client.auth.registerPasskey();
        if (error) throw error;
        await refreshPasskeys();
        showNotice("Passkey added to your account.", "success");
      } catch (error) {
        showNotice(error?.message || "Could not add a passkey.", "error");
      } finally {
        const current = app.querySelector("#add-passkey");
        if (current) { current.disabled = false; current.textContent = "Add passkey"; }
      }
    });

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
        let applicantToken = null;
        try { applicantToken = await createApplicantNotificationToken(); } catch (tokenError) {
          console.warn("Could not prepare optional applicant push notifications:", tokenError);
        }
        await invokeAccountFunction({
          action: "request-domain",
          requestedLabel: label,
          reason: purpose,
          previewUrl: preview.value,
          notificationTokenHash: applicantToken?.hash || null
        });
        showNotice(`Request for ${label}.${rootDomain} submitted for review.`, "success");
        await renderCurrentView();
        const offer = app.querySelector("#request-notification-offer");
        if (offer) {
          const pushReady = Boolean(applicantToken && browserSupportsPush());
          offer.hidden = false;
          offer.innerHTML = `<p><strong>Optional:</strong> get notified when this request is accepted or declined.</p><button class="button button-secondary button-small" id="enable-account-applicant-push" type="button" ${pushReady ? "" : "disabled"}>${pushReady ? "Enable status notifications" : "Push notifications unavailable"}</button><span class="small" id="account-applicant-push-status" aria-live="polite">${pushReady ? "" : escapeHTML(pushUnavailableMessage())}</span>`;
          offer.querySelector("#enable-account-applicant-push")?.addEventListener("click", async (pushEvent) => {
            const pushButton = pushEvent.currentTarget;
            const status = offer.querySelector("#account-applicant-push-status");
            pushButton.disabled = true;
            pushButton.textContent = "Enabling…";
            try {
              await savePushSubscription("applicant", { notificationToken: applicantToken.token });
              pushButton.textContent = "Status notifications enabled";
              if (status) status.textContent = "This device will be notified about this request.";
              showNotice("Status notifications enabled.", "success");
            } catch (pushError) {
              pushButton.disabled = false;
              pushButton.textContent = "Enable status notifications";
              if (status) status.textContent = pushError.message || "Could not enable notifications.";
              showNotice(pushError.message || "Could not enable notifications.", "error");
            }
          });
        }
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

    const pushReady = browserSupportsPush();
    const pushLabel = !config.pushPublicKey
      ? "Configure push key first"
      : !pushReady
        ? "Push notifications unavailable here"
        : window.Notification.permission === "denied"
          ? "Notifications blocked in browser settings"
          : "Enable new-request notifications";

    app.innerHTML = `
      <div class="page-heading"><h1>Applications</h1><p class="lede">Review requests, follow preview links, and approve subdomains.</p></div>
      <div class="stats"><div class="stat"><div class="stat-value">${pending}</div><div class="stat-label">Pending requests</div></div><div class="stat"><div class="stat-value">${approved}</div><div class="stat-label">Approved subdomains</div></div></div>
      <section class="section panel-section"><div class="section-header-row"><div><h2>Request notifications</h2><p class="small">Get a push notification when a new application arrives, even when this website is closed.</p></div><div class="actions"><button id="enable-admin-push" class="button button-secondary button-small" ${pushReady ? "" : "disabled"}>${pushLabel}</button><button id="test-admin-push" class="button button-quiet button-small" ${pushReady ? "" : "disabled"}>Send test notification</button></div></div><p class="small" id="admin-push-status" aria-live="polite">${pushReady ? "Enable notifications on each device where you want to receive new-request alerts, then send a test." : escapeHTML(pushUnavailableMessage()) + " The site owner must also configure the public VAPID key and deploy the push functions."}</p></section>
      <section class="section panel-section"><div class="table-wrap"><table><thead><tr><th>Requested domain</th><th>Email</th><th>Purpose</th><th>Preview</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div></section>
      <hr class="rule"><section class="section panel-section"><div class="section-header-row"><div><h2>DNS API connection</h2><p class="small">Check the server-side deSEC token and zone.</p></div><button id="test-dns" class="button button-secondary">Test deSEC connection</button></div><span id="dns-test-result" class="small" aria-live="polite">Not tested yet.</span></section>`;

    app.querySelector("#enable-admin-push")?.addEventListener("click", async (pushEvent) => {
      const button = pushEvent.currentTarget;
      const status = app.querySelector("#admin-push-status");
      button.disabled = true;
      button.textContent = "Enabling…";
      try {
        await savePushSubscription("admin");
        button.textContent = "Notifications enabled";
        if (status) status.textContent = "This device is registered. Use Send test notification to check delivery.";
        showNotice("New-request push notifications enabled.", "success");
      } catch (error) {
        button.disabled = false;
        button.textContent = "Enable new-request notifications";
        if (status) status.textContent = error.message || "Could not enable push notifications.";
        showNotice(error.message || "Could not enable push notifications.", "error");
      }
    });

    app.querySelector("#test-admin-push")?.addEventListener("click", async (pushEvent) => {
      const button = pushEvent.currentTarget;
      const status = app.querySelector("#admin-push-status");
      button.disabled = true;
      button.textContent = "Sending…";
      try {
        const { data, error } = await state.client.functions.invoke("manage-push-subscription", {
          body: { scope: "admin-test" }
        });
        if (error) {
          let detail = error.message || "Test notification failed.";
          try { const payload = await error.context?.json(); if (payload?.error) detail = payload.error; } catch {}
          throw new Error(detail);
        }
        if (!data?.success) throw new Error(data?.error || "Test notification failed.");
        if (status) status.textContent = "Test push sent. Check this device; it should arrive even after you close the website.";
        showNotice("Test notification sent.", "success");
      } catch (error) {
        if (status) status.textContent = error.message || "Test notification failed.";
        showNotice(error.message || "Test notification failed.", "error");
      } finally {
        button.disabled = false;
        button.textContent = "Send test notification";
      }
    });

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
      if (!request || !window.confirm(`Reject ${request.requested_label}.${rootDomain} and permanently delete the request? The applicant will be notified if they enabled status notifications.`)) return;
      button.disabled = true;
      button.textContent = "Notifying…";
      try {
        const result = await invokeAccountFunction({ action: "reject-request", requestId: request.id });
        showNotice(result.message || "Request rejected and permanently deleted.", "success");
        await renderCurrentView();
      } catch (error) {
        showNotice(error.message || "Could not reject and delete the request.", "error");
        button.disabled = false;
        button.textContent = "Reject";
      }
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
        detectSessionInUrl: true,
        experimental: { passkey: true }
      }
    });
    state.client.auth.onAuthStateChange((event, session) => {
      state.session = session;
      state.user = session?.user || null;
      if (event === "PASSWORD_RECOVERY") {
        state.passwordRecovery = true;
        state.authMode = "password-update";
        setTimeout(() => renderPublic(), 0);
        return;
      }
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
    if (state.passwordRecovery || state.authMode === "password-update") renderPublic();
    else if (state.user) await renderCurrentView(); else renderPublic();
  }

  start();
})();
