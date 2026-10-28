/**
 * Canopy Legal: Legislation & Caselaw Platform Reader Logic.
 * Supports Multi-Database Navigation (Acts vs Regulations, Commercial vs Transport),
 * Interactive Statute Directory Popover, and Dedicated Canopy Legal Homepage.
 */

window.scrollToParagraph = function(start, end) {
  const targetId = `para-${start}`;
  const startEl = document.getElementById(targetId);
  if (startEl) {
    startEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const maxEnd = end || start;
  for (let i = start; i <= maxEnd; i++) {
    const el = document.getElementById(`para-${i}`);
    if (el) {
      el.classList.remove('para-highlight-pulse');
      void el.offsetWidth; // trigger reflow
      el.classList.add('para-highlight-pulse');
    }
  }
};

class LegislationApp {
  constructor() {
    this.currentAct = "australian-consumer-law";
    this.currentTree = [];
    this.currentScope = null; // { type: 'node' | 'provision', data: ... }
    this.flatProvisionsList = [];
    this.allStatutes = [];
    this.platformStats = null;
    this.statuteFilter = "all";
    this.statuteSearchQuery = "";
    this.browseFilter = { category: "all", letter: "ALL", search: "" };
    this.theme = localStorage.getItem("canopy-theme") || localStorage.getItem("lexnsw-theme") || "light";
    
    // Default to clean NSW-style sans-serif typography
    let typo = { font: "sans", size: "medium", width: "normal" };
    try {
      const saved = localStorage.getItem("canopy-typo");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.size) typo.size = parsed.size;
        if (parsed.width) typo.width = parsed.width;
        if (parsed.font) typo.font = parsed.font === "serif" ? "sans" : parsed.font;
      }
    } catch (e) {}
    this.typography = typo;
    this.commentaryTierFilter = "all";
    this.activeCommentaryTarget = null;
    this.editingCommentaryId = null;
    this._commentaryById = {};
    this.currentUser = { authenticated: true, display_name: "Practitioner", user_id: "local:dev" };
    this._currentCaseData = null;
    this._currentProvData = null;
    this._previewTimer = null;

    this.initElements();
    this.initEventListeners();
    this.applyTheme(this.theme);
    this.applyTypography(this.typography);
    this.loadAuthUser();
    this.loadStatutesDirectory();
    this.handleRoute();
  }

  async loadAuthUser() {
    try {
      const res = await fetch("/api/me");
      if (res.ok) {
        this.currentUser = await res.json();
        this.renderAuthBadge();
      }
    } catch (e) {
      // Default state preserved
    }
  }

  renderAuthBadge() {
    const container = document.getElementById("auth-status-container");
    if (!container) return;
    if (this.currentUser && this.currentUser.authenticated) {
      const name = this.currentUser.display_name || "Practitioner";
      const uid = this.currentUser.user_id || "";
      const isCloud = this.currentUser.auth_provider === "cloudflare_access";
      container.innerHTML = `
        <span class="util-btn" style="cursor: default; font-size: 0.72rem; opacity: 0.9;" title="Authenticated (${uid})">
          <i data-lucide="user-check" style="width: 13px; height: 13px; color: #059669;"></i>
          <span>${name}</span>
        </span>
        ${isCloud ? `<a href="/cdn-cgi/access/logout" class="icon-btn" title="Sign Out of Cloudflare Access" style="margin-left: 2px;"><i data-lucide="log-out" style="width: 14px; height: 14px;"></i></a>` : ''}
      `;
      const authorInput = document.getElementById("comm-author-input");
      if (authorInput && (!authorInput.value || authorInput.value === "Practitioner")) {
        authorInput.value = name;
      }
    } else {
      const loginUrl = `/api/auth/login?redirect=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
      container.innerHTML = `
        <a href="${loginUrl}" class="util-btn" title="Sign in via Cloudflare Access to add or edit annotations" style="font-size: 0.72rem;">
          <i data-lucide="lock" style="width: 12px; height: 12px;"></i>
          <span>Sign In</span>
        </a>
      `;
    }
    if (window.lucide) lucide.createIcons();
  }

  initElements() {
    this.elApp = document.getElementById("app");
    this.elTreeContainer = document.getElementById("tree-container");
    this.elBreadcrumbs = document.getElementById("breadcrumbs");
    this.elContextSubbar = document.getElementById("context-subbar");
    this.elReaderContainer = document.getElementById("reader-container");
    this.elReaderFooter = document.getElementById("reader-footer");
    this.elSidebar = document.getElementById("sidebar");
    this.elTocFilter = document.getElementById("toc-filter-input");
    this.elSearchModal = document.getElementById("search-modal");
    this.elGlobalSearchInput = document.getElementById("global-search-input");
    this.elSearchResultsList = document.getElementById("search-results-list");
    this.elSearchStatusText = document.getElementById("search-status-text");
    this.elTypoPopover = document.getElementById("typography-popover");
    this.elPrevProvBtn = document.getElementById("prev-prov-btn");
    this.elNextProvBtn = document.getElementById("next-prov-btn");
    this.elPrevProvLabel = document.getElementById("prev-prov-label");
    this.elNextProvLabel = document.getElementById("next-prov-label");

    // Unified 3-Part Search Cluster Elements
    this.elOmniboxInput = document.getElementById("omnibox-input");
    this.elPinpointInput = document.getElementById("pinpoint-input");
    this.elSearchScopeSelect = document.getElementById("search-scope-select");
    this.elSearchExecBtn = document.getElementById("search-exec-btn");
    this.elOmniboxFlyout = document.getElementById("omnibox-flyout");
    this.elOmniboxClearBtn = document.getElementById("omnibox-clear-btn");

    // Unified Search Page State
    this.activeSearchTab = "all";
    this.searchAdvancedExpanded = false;
    this.currentSearchData = null;
    this.currentSearchQuery = "";
    this.currentSearchScope = "all";
    this.currentSearchFilters = {
      court: "",
      yearFrom: "",
      yearTo: "",
      matchMode: "all"
    };

    // Contextual Subbar Actions
    this.elToggleSidebarBtn = document.getElementById("toggle-sidebar-btn");
    this.elCopyCitationBtn = document.getElementById("copy-citation-btn");
    this.elShortcutsBtn = document.getElementById("shortcuts-btn");
    this.elShortcutsModal = document.getElementById("shortcuts-modal");
    this.elCloseShortcutsBtn = document.getElementById("close-shortcuts-btn");

    // Statute Directory Popover Elements
    this.elStatuteMenuBtn = document.getElementById("statute-menu-btn");
    this.elStatuteMenuLabel = document.getElementById("statute-menu-label");
    this.elStatutePopover = document.getElementById("statute-popover");
    this.elStatuteList = document.getElementById("statute-list");
    this.elStatuteFilterInput = document.getElementById("statute-filter-input");
    this.elCloseStatutePopoverBtn = document.getElementById("close-statute-popover-btn");

    // Right-Hand Information Pane Elements
    this.elInfoPane = document.getElementById("info-pane");
    this.elToggleInfoBtn = document.getElementById("toggle-info-btn");
    this.elCloseInfoBtn = document.getElementById("close-info-pane-btn");

    // In-Reader Find Bar Elements (Phase 3)
    this.elReaderFindBar = document.getElementById("reader-find-bar");
    this.elReaderFindInput = document.getElementById("reader-find-input");
    this.elReaderFindCounter = document.getElementById("reader-find-counter");
    this.elReaderFindPinpoint = document.getElementById("reader-find-pinpoint");
    this.elReaderFindPrevBtn = document.getElementById("reader-find-prev-btn");
    this.elReaderFindNextBtn = document.getElementById("reader-find-next-btn");
    this.elReaderFindCaseBtn = document.getElementById("reader-find-case-btn");
    this.elReaderFindWordBtn = document.getElementById("reader-find-word-btn");
    this.elReaderFindClearBtn = document.getElementById("reader-find-clear-btn");
    this.elReaderFindCloseBtn = document.getElementById("reader-find-close-btn");
    this.elFindInReaderBtn = document.getElementById("find-in-reader-btn");

    this.findBarOpen = false;
    this.findMatches = [];
    this.activeMatchIndex = -1;
    this.findCaseSensitive = false;
    this.findWholeWord = false;
  }

  initEventListeners() {
    // Omnibox 3-Part Search Cluster Input Listeners
    let omniboxTimer = null;
    const triggerFlyout = () => {
      clearTimeout(omniboxTimer);
      omniboxTimer = setTimeout(() => this.fetchOmniboxFlyout(), 150);
    };

    const updateOmniboxClearBtn = () => {
      if (this.elOmniboxClearBtn) {
        const hasText = Boolean(this.elOmniboxInput && this.elOmniboxInput.value.trim());
        this.elOmniboxClearBtn.style.display = hasText ? "inline-flex" : "none";
      }
    };

    if (this.elOmniboxInput) {
      this.elOmniboxInput.addEventListener("input", () => {
        updateOmniboxClearBtn();
        triggerFlyout();
      });
      this.elOmniboxInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.executeOmniboxSubmit();
        } else if (e.key === "Escape") {
          this.closeOmniboxFlyout();
        }
      });
    }

    if (this.elPinpointInput) {
      this.elPinpointInput.addEventListener("input", triggerFlyout);
      this.elPinpointInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.executeOmniboxSubmit();
        } else if (e.key === "Escape") {
          this.closeOmniboxFlyout();
        }
      });
    }

    if (this.elSearchScopeSelect) {
      this.elSearchScopeSelect.addEventListener("change", () => this.fetchOmniboxFlyout());
    }

    if (this.elSearchExecBtn) {
      this.elSearchExecBtn.addEventListener("click", () => this.executeOmniboxSubmit());
    }

    // Close flyout on click outside
    window.addEventListener("click", (e) => {
      const searchCluster = document.getElementById("search-cluster");
      if (this.elOmniboxFlyout && searchCluster && !searchCluster.contains(e.target)) {
        this.elOmniboxFlyout.style.display = "none";
      }
      if (this.elStatutePopover && !this.elStatutePopover.contains(e.target) && this.elStatuteMenuBtn && !this.elStatuteMenuBtn.contains(e.target)) {
        this.closeStatutePopover();
      }
      if (this.elTypoPopover && !this.elTypoPopover.contains(e.target) && !document.getElementById("typography-btn")?.contains(e.target)) {
        this.elTypoPopover.style.display = "none";
      }
    });

    // Shortcuts Modal Handlers
    if (this.elShortcutsBtn) {
      this.elShortcutsBtn.addEventListener("click", () => {
        if (this.elShortcutsModal) this.elShortcutsModal.style.display = "flex";
      });
    }

    if (this.elCloseShortcutsBtn) {
      this.elCloseShortcutsBtn.addEventListener("click", () => {
        if (this.elShortcutsModal) this.elShortcutsModal.style.display = "none";
      });
    }

    // Contextual Subbar: Toggle Left Sidebar
    if (this.elToggleSidebarBtn) {
      this.elToggleSidebarBtn.addEventListener("click", () => {
        if (!this.elSidebar) return;
        const isHidden = (this.elSidebar.style.display === "none");
        this.elSidebar.style.display = isHidden ? "flex" : "none";
        const handle = document.getElementById("resize-handle");
        if (handle) handle.style.display = isHidden ? "block" : "none";
      });
    }

    // Contextual Subbar: Copy Citation
    if (this.elCopyCitationBtn) {
      this.elCopyCitationBtn.addEventListener("click", () => this.copyCitation());
    }

    // Hash change routing
    window.addEventListener("hashchange", () => this.handleRoute());

    // Sidebar Filter
    if (this.elTocFilter) {
      this.elTocFilter.addEventListener("input", (e) => this.filterTree(e.target.value));
    }

    // Expand / Collapse all
    document.getElementById("expand-all-btn")?.addEventListener("click", () => this.expandAllNodes(true));
    document.getElementById("collapse-all-btn")?.addEventListener("click", () => this.expandAllNodes(false));

    // Keyboard Shortcuts
    window.addEventListener("keydown", (e) => {
      const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
      const isFindInput = document.activeElement === this.elReaderFindInput;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        // Intercept find command for in-reader document search if in workspace or reading mode
        if (this.currentMode === "workspace" || this.currentScope || this._currentCaseData) {
          e.preventDefault();
          this.openReaderFindBar();
          return;
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        this.elOmniboxInput?.focus();
        this.elOmniboxInput?.select();
      } else if (e.key === "Escape") {
        if (this.findBarOpen) {
          this.closeReaderFindBar();
          return;
        }
        if (this.elOmniboxFlyout) this.elOmniboxFlyout.style.display = "none";
        if (this.elShortcutsModal) this.elShortcutsModal.style.display = "none";
        this.closeSearchModal();
        this.closeStatutePopover();
        if (this.elTypoPopover) this.elTypoPopover.style.display = "none";
        this.closeCommentaryModal();
      } else if (!isInput && e.key === "?") {
        e.preventDefault();
        if (this.elShortcutsModal) this.elShortcutsModal.style.display = "flex";
      } else if (e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        this.theme = this.theme === "light" ? "dark" : "light";
        this.applyTheme(this.theme);
      } else if (e.altKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        window.location.hash = "#/";
      } else if (e.altKey && e.key === "[") {
        e.preventDefault();
        this.elToggleSidebarBtn?.click();
      } else if (e.altKey && e.key === "]") {
        e.preventDefault();
        this.toggleInfoPane();
      }
    });

    // In-Reader Find Bar Listeners
    if (this.elReaderFindInput) {
      let findDebounceTimer = null;
      this.elReaderFindInput.addEventListener("input", () => {
        if (this.elReaderFindClearBtn) {
          this.elReaderFindClearBtn.style.display = this.elReaderFindInput.value ? "inline-flex" : "none";
        }
        clearTimeout(findDebounceTimer);
        findDebounceTimer = setTimeout(() => this.executeReaderFind(), 120);
      });

      this.elReaderFindInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey) {
            this.navigateReaderFind(-1);
          } else {
            this.navigateReaderFind(1);
          }
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          this.navigateReaderFind(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          this.navigateReaderFind(-1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.closeReaderFindBar();
        } else if (e.altKey && e.key.toLowerCase() === "c") {
          e.preventDefault();
          this.toggleFindOption("case");
        } else if (e.altKey && e.key.toLowerCase() === "w") {
          e.preventDefault();
          this.toggleFindOption("word");
        }
      });
    }

    if (this.elReaderFindClearBtn) {
      this.elReaderFindClearBtn.addEventListener("click", () => {
        if (this.elReaderFindInput) {
          this.elReaderFindInput.value = "";
          this.elReaderFindInput.focus();
        }
        this.elReaderFindClearBtn.style.display = "none";
        this.clearReaderFindHighlights();
        this.updateFindStatus();
      });
    }

    // Theme Toggle
    document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
      this.theme = this.theme === "light" ? "dark" : "light";
      this.applyTheme(this.theme);
    });

    // Typography Toggle & Options
    document.getElementById("typography-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.elTypoPopover) return;
      const isVisible = this.elTypoPopover.style.display === "block";
      this.elTypoPopover.style.display = isVisible ? "none" : "block";
    });

    document.querySelectorAll(".size-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".size-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.typography.size = btn.dataset.size;
        this.applyTypography(this.typography);
      });
    });

    document.querySelectorAll(".width-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".width-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.typography.width = btn.dataset.width;
        this.applyTypography(this.typography);
      });
    });

    // Action Bar Actions: Source link is a standard anchor target="_blank"
    const copyLinkBtn = document.getElementById("copy-link-btn");
    if (copyLinkBtn) copyLinkBtn.addEventListener("click", () => this.copyCurrentLink());
    
    // Print triggers
    const printHandler = () => window.print();
    const printBtn = document.getElementById("print-current-btn");
    if (printBtn) printBtn.addEventListener("click", printHandler);
    const topPrintBtn = document.getElementById("top-print-btn");
    if (topPrintBtn) topPrintBtn.addEventListener("click", printHandler);

    // Information Pane Toggles & Tabs
    if (this.elToggleInfoBtn) {
      this.elToggleInfoBtn.addEventListener("click", () => this.toggleInfoPane());
    }
    if (this.elCloseInfoBtn) {
      this.elCloseInfoBtn.addEventListener("click", () => this.closeInfoPane());
    }
    const tabsContainer = document.getElementById("info-pane-tabs");
    if (tabsContainer) {
      tabsContainer.addEventListener("click", (e) => {
        const tabBtn = e.target.closest(".info-tab");
        if (tabBtn && tabBtn.dataset.tab) {
          this.switchInfoTab(tabBtn.dataset.tab);
        }
      });
    }

    // Navigation (Prev / Next)
    this.elPrevProvBtn?.addEventListener("click", () => this.navigateSibling(-1));
    this.elNextProvBtn?.addEventListener("click", () => this.navigateSibling(1));

    // Resizer logic
    this.initResizer();
  }

  toggleStatutePopover() {
    const isVisible = this.elStatutePopover.style.display === "flex";
    if (isVisible) {
      this.closeStatutePopover();
    } else {
      this.elStatutePopover.style.display = "flex";
      this.elStatuteMenuBtn.classList.add("open");
      if (this.elStatuteFilterInput) {
        this.elStatuteFilterInput.focus();
      }
    }
  }

  closeStatutePopover() {
    if (this.elStatutePopover) {
      this.elStatutePopover.style.display = "none";
    }
    if (this.elStatuteMenuBtn) {
      this.elStatuteMenuBtn.classList.remove("open");
    }
  }

  async loadStatutesDirectory() {
    try {
      const [actsRes, statsRes] = await Promise.all([
        fetch("/api/acts"),
        fetch("/api/stats")
      ]);
      this.allStatutes = await actsRes.json();
      this.platformStats = await statsRes.json();

      if (this.elStatuteMenuLabel) {
        this.elStatuteMenuLabel.textContent = `All Statutes (${this.allStatutes.length})`;
      }

      this.renderStatuteList();
    } catch (e) {
      console.error("Error loading statutes directory:", e);
    }
  }

  renderStatuteList() {
    if (!this.elStatuteList) return;

    let filtered = this.allStatutes;
    if (this.statuteFilter !== "all") {
      filtered = filtered.filter(a => (a.category || "act") === this.statuteFilter);
    }
    if (this.statuteSearchQuery) {
      filtered = filtered.filter(a => 
        a.short_title.toLowerCase().includes(this.statuteSearchQuery) ||
        (a.portfolio || "").toLowerCase().includes(this.statuteSearchQuery) ||
        a.slug.toLowerCase().includes(this.statuteSearchQuery)
      );
    }

    // Group by portfolio
    const financialStatutes = filtered.filter(a => a.portfolio === "financial");
    const transportStatutes = filtered.filter(a => a.portfolio === "transport");
    const commercialStatutes = filtered.filter(a => a.portfolio === "commercial" || (!a.portfolio && a.portfolio !== "transport" && a.portfolio !== "financial"));

    let html = "";

    if (financialStatutes.length > 0) {
      html += `<div class="statute-portfolio-group">
        <div class="portfolio-group-title">Financial Services, Superannuation & Banking (CTH)</div>`;
      for (const s of financialStatutes) {
        const isActive = (s.slug === this.currentAct);
        const isAct = (s.category || "act") === "act";
        const badgeClass = isAct ? "badge-act" : "badge-reg";
        const badgeText = isAct ? "Act" : "Reg";
        const iconName = isAct ? "landmark" : "file-text";
        html += `
          <div class="statute-item-row ${isActive ? 'active' : ''}" onclick="app.selectStatute('${s.slug}')">
            <div class="statute-item-left">
              <i data-lucide="${iconName}"></i>
              <span class="statute-item-name">${s.short_title}</span>
            </div>
            <span class="badge-statute ${badgeClass}">${badgeText}</span>
          </div>
        `;
      }
      html += `</div>`;
    }

    if (transportStatutes.length > 0) {
      html += `<div class="statute-portfolio-group">
        <div class="portfolio-group-title">Transport & Heavy Vehicle (NSW & National Scheme)</div>`;
      for (const s of transportStatutes) {
        const isActive = (s.slug === this.currentAct);
        const isAct = (s.category || "act") === "act";
        const badgeClass = isAct ? "badge-act" : "badge-reg";
        const badgeText = isAct ? "Act" : "Reg";
        const iconName = isAct ? "truck" : "file-text";
        html += `
          <div class="statute-item-row ${isActive ? 'active' : ''}" onclick="app.selectStatute('${s.slug}')">
            <div class="statute-item-left">
              <i data-lucide="${iconName}"></i>
              <span class="statute-item-name">${s.short_title}</span>
            </div>
            <span class="badge-statute ${badgeClass}">${badgeText}</span>
          </div>
        `;
      }
      html += `</div>`;
    }

    if (commercialStatutes.length > 0) {
      html += `<div class="statute-portfolio-group">
        <div class="portfolio-group-title">Commercial & Consumer (Commonwealth)</div>`;
      for (const s of commercialStatutes) {
        const isActive = (s.slug === this.currentAct);
        const isAct = (s.category || "act") === "act";
        const badgeClass = isAct ? "badge-act" : "badge-reg";
        const badgeText = isAct ? "Act" : "Reg";
        const iconName = isAct ? "scale" : "file-text";
        html += `
          <div class="statute-item-row ${isActive ? 'active' : ''}" onclick="app.selectStatute('${s.slug}')">
            <div class="statute-item-left">
              <i data-lucide="${iconName}"></i>
              <span class="statute-item-name">${s.short_title}</span>
            </div>
            <span class="badge-statute ${badgeClass}">${badgeText}</span>
          </div>
        `;
      }
      html += `</div>`;
    }

    if (filtered.length === 0) {
      html = `<div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.8125rem;">No statutes match filter.</div>`;
    }

    this.elStatuteList.innerHTML = html;
    lucide.createIcons();
  }

  selectStatute(actSlug) {
    this.closeStatutePopover();
    this.navigateTo(actSlug, "");
  }

  applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("canopy-theme", theme);
    const icon = document.getElementById("theme-icon");
    if (icon) {
      icon.setAttribute("data-lucide", theme === "dark" ? "sun" : "moon");
      lucide.createIcons();
    }
  }

  applyTypography(typo) {
    localStorage.setItem("canopy-typo", JSON.stringify(typo));

    if (typo.font === "serif") {
      document.documentElement.style.setProperty("--font-legal", "'Source Serif 4', 'Charter', Georgia, serif");
    } else {
      document.documentElement.style.setProperty("--font-legal", "var(--font-ui)");
    }

    if (typo.size === "small") {
      document.documentElement.style.setProperty("--legal-font-size", "0.875rem");
      document.documentElement.style.setProperty("--legal-line-height", "1.5");
    } else if (typo.size === "large") {
      document.documentElement.style.setProperty("--legal-font-size", "1.0625rem");
      document.documentElement.style.setProperty("--legal-line-height", "1.7");
    } else {
      document.documentElement.style.setProperty("--legal-font-size", "0.9375rem");
      document.documentElement.style.setProperty("--legal-line-height", "1.6");
    }

    if (typo.width === "compact") {
      document.documentElement.style.setProperty("--content-max-width", "42rem");
    } else if (typo.width === "wide") {
      document.documentElement.style.setProperty("--content-max-width", "56rem");
    } else {
      document.documentElement.style.setProperty("--content-max-width", "48rem");
    }
  }

  setShellMode(mode) {
    this.shellMode = mode;
    if (this.elApp) {
      this.elApp.className = `app-container layout-${mode}`;
    }
    if (mode === "portal") {
      this.closeInfoPane();
      this.closeReaderFindBar();
    }
    document.querySelectorAll(".header-nav-link").forEach(l => l.classList.remove("active"));
  }

  clearOmniboxInput() {
    if (this.elOmniboxInput) {
      this.elOmniboxInput.value = "";
      if (this.elOmniboxClearBtn) this.elOmniboxClearBtn.style.display = "none";
      if (this.elOmniboxFlyout) this.elOmniboxFlyout.style.display = "none";
      this.elOmniboxInput.focus();
    }
  }

  closeOmniboxFlyout() {
    if (this.elOmniboxFlyout) {
      this.elOmniboxFlyout.style.display = "none";
    }
  }

  escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async fetchOmniboxFlyout() {
    if (!this.elOmniboxFlyout) return;
    const q = this.elOmniboxInput ? this.elOmniboxInput.value.trim() : "";
    const lpc = this.elPinpointInput ? this.elPinpointInput.value.trim() : "";
    const scope = this.elSearchScopeSelect ? this.elSearchScopeSelect.value : "all";

    if (!q && !lpc) {
      this.elOmniboxFlyout.style.display = "none";
      return;
    }

    try {
      const res = await fetch(`/api/search/omnibox?q=${encodeURIComponent(q)}&lpc=${encodeURIComponent(lpc)}&scope=${encodeURIComponent(scope)}`);
      const data = await res.json();
      this.renderOmniboxFlyout(data, q, lpc);
    } catch (e) {
      console.error("Omnibox fetch error:", e);
    }
  }

  renderOmniboxFlyout(data, q, lpc) {
    if (!this.elOmniboxFlyout) return;
    const hasStatutes = data.statutes && data.statutes.length > 0;
    const hasProvisions = data.provisions && data.provisions.length > 0;
    const hasLawparts = data.lawparts && data.lawparts.length > 0;
    const hasCases = data.cases && data.cases.length > 0;
    const queryTerm = (q || lpc || "").trim();

    if (!hasStatutes && !hasProvisions && !hasLawparts && !hasCases) {
      this.elOmniboxFlyout.innerHTML = `
        <div class="flyout-header-bar">
          <span><i data-lucide="sparkles" style="width: 12px; height: 12px; vertical-align: middle;"></i> Suggestions</span>
          <button class="flyout-dismiss-btn" title="Dismiss flyout" onclick="event.stopPropagation(); app.closeOmniboxFlyout();"><i data-lucide="x" style="width: 12px; height: 12px;"></i></button>
        </div>
        <div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.8125rem;">
          No exact matches. Press <kbd style="background: var(--bg-hover); padding: 1px 5px; border-radius: 3px;">Enter ↵</kbd> to run full search.
        </div>
        <div style="padding: 8px 12px; background: var(--bg-surface); border-top: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="app.executeOmniboxSubmit()">
          <span style="font-size: 0.75rem; color: var(--border-active); font-weight: 600;">
            <i data-lucide="arrow-right-circle" style="width: 13px; height: 13px; vertical-align: middle;"></i> Open unified search page
          </span>
          <kbd style="font-size: 0.65rem; background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; color: var(--text-muted);">Enter ↵</kbd>
        </div>
      `;
      this.elOmniboxFlyout.style.display = "block";
      lucide.createIcons();
      return;
    }

    let html = `
      <div class="flyout-header-bar">
        <span><i data-lucide="sparkles" style="width: 12px; height: 12px; vertical-align: middle;"></i> Quick Matches for "<strong>${this.escapeHtml(queryTerm)}</strong>"</span>
        <button class="flyout-dismiss-btn" title="Dismiss flyout" onclick="event.stopPropagation(); app.closeOmniboxFlyout();"><i data-lucide="x" style="width: 12px; height: 12px;"></i></button>
      </div>
    `;

    // 1. OFFENCES & LAWPARTS
    if (hasLawparts) {
      html += `<div class="flyout-section">
        <div class="flyout-section-title"><i data-lucide="scale" style="width: 12px; height: 12px; vertical-align: middle;"></i> Offences & Lawparts</div>`;
      for (const lp of data.lawparts) {
        html += `
          <div class="flyout-item" onclick="app.selectLawpartFlyout('${lp.lawpart_code}', '${lp.statute_name || ''}', '${lp.section_number || ''}')">
            <div class="flyout-item-left">
              <span class="lawpart-code-chip">${lp.lawpart_code}</span>
              <div style="min-width: 0; flex: 1;">
                <div class="flyout-item-title">${this.escapeHtml(lp.offence_description || 'Offence')}</div>
                <div style="font-size: 0.7rem; color: var(--text-muted);">${this.escapeHtml(lp.statute_name || '')} s ${this.escapeHtml(lp.section_number || '')}</div>
              </div>
            </div>
            ${lp.max_penalty_fine ? `<span class="badge-statute" style="font-size: 0.65rem; background: var(--bg-hover);">${this.escapeHtml(lp.max_penalty_fine)}</span>` : ''}
          </div>
        `;
      }
      html += `</div>`;
    }

    // 2. STATUTES & REGULATIONS
    if (hasStatutes || hasProvisions) {
      html += `<div class="flyout-section">
        <div class="flyout-section-title"><i data-lucide="landmark" style="width: 12px; height: 12px; vertical-align: middle;"></i> Legislation & Provisions</div>`;
      if (hasStatutes) {
        for (const s of data.statutes) {
          const isAct = (s.category === "act");
          const badgeClass = isAct ? "badge-act" : "badge-reg";
          const sTitle = s.short_title || s.title || s.slug;
          html += `
            <div class="flyout-item" onclick="app.selectStatuteFlyout('${s.slug}')">
              <div class="flyout-item-left">
                <i data-lucide="${isAct ? 'landmark' : 'file-text'}" style="width: 14px; height: 14px; color: var(--border-active);"></i>
                <span class="flyout-item-title">${this.escapeHtml(sTitle)}</span>
              </div>
              <span class="badge-statute ${badgeClass}">${isAct ? 'Act' : 'Reg'}</span>
            </div>
          `;
        }
      }
      if (hasProvisions) {
        for (const p of data.provisions) {
          html += `
            <div class="flyout-item" onclick="app.selectProvisionFlyout('${p.act_slug}', '${p.full_slug}')">
              <div class="flyout-item-left">
                <span class="prov-num-badge">s ${this.escapeHtml(p.identifier)}</span>
                <span class="flyout-item-title">${this.escapeHtml(p.title)}</span>
              </div>
              <span class="badge-statute" style="font-size: 0.65rem; background: var(--bg-hover);">${p.act_slug.split('-')[0].toUpperCase()}</span>
            </div>
          `;
        }
      }
      html += `</div>`;
    }

    // 3. CASELAW & PRECEDENTS
    if (hasCases) {
      html += `<div class="flyout-section">
        <div class="flyout-section-title"><i data-lucide="gavel" style="width: 12px; height: 12px; vertical-align: middle;"></i> Leading Decisions</div>`;
      for (const c of data.cases) {
        html += `
          <div class="flyout-item" onclick="app.selectCaseFlyout('${c.id}')">
            <div class="flyout-item-left">
              <i data-lucide="scale" style="width: 14px; height: 14px; color: #2563EB;"></i>
              <div style="min-width: 0; flex: 1;">
                <div class="flyout-item-title">${this.escapeHtml(c.title)}</div>
                <div style="font-size: 0.7rem; color: var(--text-muted);">${this.escapeHtml(c.mnc || '')} • ${this.escapeHtml(c.court || '')} (${this.escapeHtml(c.year || '')})</div>
              </div>
            </div>
          </div>
        `;
      }
      html += `</div>`;
    }

    // Full search footer bar
    html += `
      <div style="padding: 8px 12px; background: var(--bg-surface); border-top: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="app.executeOmniboxSubmit()">
        <span style="font-size: 0.75rem; color: var(--border-active); font-weight: 600;">
          <i data-lucide="arrow-right-circle" style="width: 13px; height: 13px; vertical-align: middle;"></i> View all search results & advanced filters for "${this.escapeHtml(queryTerm)}"
        </span>
        <kbd style="font-size: 0.65rem; background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; color: var(--text-muted);">Enter ↵</kbd>
      </div>
    `;

    this.elOmniboxFlyout.innerHTML = html;
    this.elOmniboxFlyout.style.display = "block";
    lucide.createIcons();
  }

  selectLawpartFlyout(lpc, statuteName, secNum) {
    if (this.elOmniboxFlyout) this.elOmniboxFlyout.style.display = "none";
    let targetAct = "road-transport-act-2013";
    const sLower = (statuteName || "").toLowerCase();
    if (sLower.includes("rule")) {
      targetAct = "road-rules-2014";
    } else if (sLower.includes("sentencing") || sLower.includes("crimes (sentencing")) {
      targetAct = "crimes-sentencing-procedure-act-1999";
    } else if (sLower.includes("administrative decisions") || sLower.includes("adr")) {
      targetAct = "administrative-decisions-review-act-1997";
    } else if (sLower.includes("heavy vehicle") || sLower.includes("hvnl")) {
      targetAct = "heavy-vehicle-national-law";
    } else if (sLower.includes("superannuation") || sLower.includes("sis")) {
      targetAct = "superannuation-industry-supervision-act-1993";
    } else if (sLower.includes("banking")) {
      targetAct = "banking-act-1959";
    } else if (sLower.includes("insurance contracts")) {
      targetAct = "insurance-contracts-act-1984";
    } else if (sLower.includes("consumer law") || sLower.includes("acl")) {
      targetAct = "australian-consumer-law";
    } else if (sLower.includes("competition") || sLower.includes("cca")) {
      targetAct = "competition-and-consumer-act-2010";
    }
    const cleanSec = (secNum || "").replace(/^s/i, "").trim();
    if (cleanSec) {
      this.navigateTo(targetAct, `main/s${cleanSec}`);
    } else {
      window.location.hash = `#/browse/legislation`;
    }
  }

  selectStatuteFlyout(actSlug) {
    if (this.elOmniboxFlyout) this.elOmniboxFlyout.style.display = "none";
    this.navigateTo(actSlug, "");
  }

  selectProvisionFlyout(actSlug, fullSlug) {
    if (this.elOmniboxFlyout) this.elOmniboxFlyout.style.display = "none";
    this.navigateTo(actSlug, fullSlug);
  }

  selectCaseFlyout(caseId) {
    if (this.elOmniboxFlyout) this.elOmniboxFlyout.style.display = "none";
    window.location.hash = `#/cases/${caseId}`;
  }

  executeOmniboxSubmit() {
    if (this.elOmniboxFlyout) this.elOmniboxFlyout.style.display = "none";
    const q = this.elOmniboxInput ? this.elOmniboxInput.value.trim() : "";
    const lpc = this.elPinpointInput ? this.elPinpointInput.value.trim() : "";
    const scope = this.elSearchScopeSelect ? this.elSearchScopeSelect.value : "all";

    // 1. Direct section pinpoint jump
    if (lpc) {
      const cleanLpc = lpc.replace(/^s/i, "").replace(/^r/i, "").trim();
      let targetAct = this.currentAct || "road-transport-act-2013";
      if (lpc.toLowerCase().startsWith("r") || lpc.toLowerCase().startsWith("rule")) {
        targetAct = "road-rules-2014";
      }
      this.navigateTo(targetAct, `main/s${cleanLpc}`);
      return;
    }

    // 2. Direct single section in omnibox (e.g. "s 110", "section 20", "s110")
    const secMatch = q.match(/^(?:s|sec|section|rule|r)\s*([0-9]+[a-z]?)$/i);
    if (secMatch) {
      const secNum = secMatch[1];
      let targetAct = this.currentAct || "road-transport-act-2013";
      if (q.toLowerCase().startsWith("r") || q.toLowerCase().startsWith("rule")) targetAct = "road-rules-2014";
      this.navigateTo(targetAct, `main/s${secNum}`);
      return;
    }

    // 3. Dedicated Search Landing Page (Option 1)
    const targetHash = `#/search?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}`;
    if (window.location.hash.startsWith("#/search")) {
      window.location.hash = targetHash;
      this.renderSearchLandingPage(q, scope);
    } else {
      window.location.hash = targetHash;
    }
  }

  resolveSourceProvider(url, defaultLabel = null) {
    if (!url) return null;
    const u = url.toLowerCase();
    if (u.includes("caselaw.nsw.gov.au")) {
      return {
        id: "nsw_caselaw",
        name: "NSW Caselaw",
        label: "NSW Caselaw",
        icon: "scale",
        badgeClass: "badge-source-nsw",
        color: "#065F46"
      };
    }
    if (u.includes("austlii.edu.au")) {
      return {
        id: "austlii",
        name: "AustLII",
        label: "AustLII",
        icon: "external-link",
        badgeClass: "badge-source-austlii",
        color: "#1e40af"
      };
    }
    if (u.includes("jade.io") || u.includes("barnet.com.au")) {
      return {
        id: "jade",
        name: "BarNet Jade",
        label: "BarNet Jade",
        icon: "external-link",
        badgeClass: "badge-source-jade",
        color: "#7c3aed"
      };
    }
    if (u.includes("fedcourt.gov.au")) {
      return {
        id: "fedcourt",
        name: "Federal Court",
        label: "Federal Court",
        icon: "scale",
        badgeClass: "badge-source-fed",
        color: "#0f766e"
      };
    }
    if (u.includes("hcourt.gov.au")) {
      return {
        id: "hca",
        name: "High Court",
        label: "High Court",
        icon: "scale",
        badgeClass: "badge-source-hca",
        color: "#b45309"
      };
    }
    return {
      id: "external",
      name: defaultLabel || "External Source",
      label: defaultLabel || "External Source",
      icon: "external-link",
      badgeClass: "badge-source-ext",
      color: "var(--text-secondary)"
    };
  }

  copyCitation() {
    let citation = "";
    if (this.currentScope && this.currentScope.data) {
      const d = this.currentScope.data;
      const actMeta = this.allStatutes.find(a => a.slug === this.currentAct);
      const actTitle = actMeta ? actMeta.short_title : this.currentAct;
      if (d.identifier) {
        citation = `${actTitle}, s ${d.identifier}`;
      } else {
        citation = actTitle;
      }
    } else {
      citation = window.location.href;
    }

    navigator.clipboard.writeText(citation).then(() => {
      const btn = this.elCopyCitationBtn;
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = `<i data-lucide="check"></i><span>Copied!</span>`;
        lucide.createIcons();
        setTimeout(() => {
          btn.innerHTML = orig;
          lucide.createIcons();
        }, 1800);
      }
    });
  }

  async handleRoute() {
    const hash = window.location.hash.slice(1);
    
    // Homepage Route (Portal Mode)
    if (!hash || hash === "/" || hash === "") {
      this.setShellMode("portal");
      this.renderHomepage();
      return;
    }

    const parts = hash.split("/").filter(Boolean);
    if (parts.length >= 1) {
      if (parts[0] === "search" || parts[0].startsWith("search")) {
        this.setShellMode("portal");
        const qIndex = hash.indexOf("?");
        let query = "";
        let scope = "all";
        if (qIndex !== -1) {
          const params = new URLSearchParams(hash.slice(qIndex));
          query = params.get("q") || "";
          scope = params.get("scope") || "all";
        }
        await this.renderSearchLandingPage(query, scope);
        return;
      }

      if (parts[0] === "browse") {
        if (parts[1] === "legislation") {
          this.setShellMode("portal");
          const legBtn = document.getElementById("nav-browse-leg-btn");
          if (legBtn) legBtn.classList.add("active");
          await this.renderLegislationBrowse();
          return;
        } else if (parts[1] === "caselaw") {
          this.setShellMode("workspace");
          const caseBtn = document.getElementById("nav-browse-case-btn");
          if (caseBtn) caseBtn.classList.add("active");
          const caseSlug = parts[2] || "";
          await this.renderCaselawBrowser(caseSlug);
          return;
        }
      }

      if (parts[0] === "cases") {
        this.setShellMode("workspace");
        const caseSlug = parts[1] || "";
        await this.renderCaselawBrowser(caseSlug);
        return;
      }

      let actSlug = parts[0];
      if (actSlug === "acl") actSlug = "australian-consumer-law";
      if (actSlug === "cca") actSlug = "competition-and-consumer-act-2010";
      if (actSlug === "hvnl") actSlug = "heavy-vehicle-national-law";

      // Enter Workspace Mode
      this.setShellMode("workspace");
      if (this.elSidebar) this.elSidebar.style.display = "flex";
      if (this.elContextSubbar) this.elContextSubbar.style.display = "flex";

      if (actSlug !== this.currentAct) {
        await this.switchAct(actSlug);
      } else if (this.currentTree.length === 0) {
        await this.loadTree();
      }

      if (parts.length >= 2) {
        const targetSlug = parts.slice(1).join("/");
        await this.loadTarget(targetSlug);
      } else {
        this.renderActOverview();
      }
    }
  }

  async renderCaselawBrowser(selectedCaseSlug = "") {
    this.setShellMode("workspace");
    const casesBtn = document.getElementById("nav-browse-case-btn");
    if (casesBtn) casesBtn.classList.add("active");

    if (this.elSidebar) this.elSidebar.style.display = "flex";
    if (this.elContextSubbar) this.elContextSubbar.style.display = "flex";
    if (this.elReaderFooter) this.elReaderFooter.style.display = "none";

    // Set Breadcrumbs to Caselaw
    if (this.elBreadcrumbs) {
      this.elBreadcrumbs.innerHTML = `
        <span class="crumb root"><i data-lucide="gavel"></i> Caselaw</span>
        <span class="crumb-separator">/</span>
        <span class="crumb active">${selectedCaseSlug ? 'Judgment View' : 'All Judgments'}</span>
      `;
    }

    // Load Cases List into Left Sidebar
    try {
      const res = await fetch("/api/cases");
      const cases = await res.json();
      
      let treeHtml = `
        <div class="tree-header-title" style="padding: 0.75rem; font-weight: 700; font-size: 0.8125rem; border-bottom: 1px solid var(--border-subtle); background: var(--bg-sidebar); display: flex; justify-content: space-between; align-items: center;">
          <span><i data-lucide="gavel" style="width: 14px; height: 14px; vertical-align: middle;"></i> Judgments (<span id="caselaw-total-count">${cases.length}</span>)</span>
        </div>
        <div style="padding: 0.5rem; border-bottom: 1px solid var(--border-subtle); background: var(--bg-sidebar);">
          <input type="text" id="caselaw-filter-input" placeholder="Filter by name, citation, court..." style="width: 100%; font-size: 0.75rem; padding: 5px 8px; border: 1px solid var(--border-subtle); border-radius: 4px; background: var(--bg-canvas); color: var(--text-primary); outline: none;" />
        </div>
        <div class="caselaw-sidebar-list" id="caselaw-sidebar-items" style="padding: 0.5rem; overflow-y: auto; max-height: calc(100vh - 180px);">
      `;

      if (cases.length === 0) {
        treeHtml += `<div style="padding: 1rem; color: var(--text-muted); font-size: 0.8125rem;">No cases ingested yet. Drop PDFs into <code>Caselaw/pdf_cases</code>.</div>`;
      } else {
        for (const c of cases) {
          const isActive = (c.id === selectedCaseSlug);
          const displayTitle = c.title || c.citation;
          treeHtml += `
            <div class="statute-item-row ${isActive ? 'active' : ''}" data-search="${(displayTitle + ' ' + (c.mnc || '') + ' ' + (c.court || '')).toLowerCase()}" style="margin-bottom: 4px; border-radius: 6px; padding: 0.5rem 0.6rem; cursor: pointer;" onclick="window.location.hash='#/cases/${c.id}'">
              <div class="statute-item-left" style="align-items: flex-start; gap: 0.5rem; width: 100%;">
                <i data-lucide="scale" style="flex-shrink: 0; margin-top: 3px; width: 14px; height: 14px;"></i>
                <div style="min-width: 0; flex: 1;">
                  <div style="font-weight: 600; font-size: 0.8125rem; line-height: 1.35; color: var(--text-primary); margin-bottom: 3px; word-break: break-word;">${displayTitle}</div>
                  <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
                    ${c.mnc ? `<span class="badge-statute" style="font-size: 0.65rem; padding: 1px 5px; font-weight: 600; background: var(--bg-hover);">${c.mnc}</span>` : ''}
                    <span style="font-size: 0.7rem; color: var(--text-muted);">${c.court} (${c.judgment_date || 'N/A'})</span>
                  </div>
                </div>
              </div>
            </div>
          `;
        }
      }
      treeHtml += `</div>`;
      this.elTreeContainer.innerHTML = treeHtml;
      lucide.createIcons();

      // Hook up real-time search filter in sidebar
      const filterInput = document.getElementById("caselaw-filter-input");
      if (filterInput) {
        filterInput.addEventListener("input", (e) => {
          const query = e.target.value.toLowerCase().trim();
          const items = document.querySelectorAll("#caselaw-sidebar-items .statute-item-row");
          let visibleCount = 0;
          items.forEach(el => {
            const match = !query || el.getAttribute("data-search").includes(query);
            el.style.display = match ? "block" : "none";
            if (match) visibleCount++;
          });
          const countBadge = document.getElementById("caselaw-total-count");
          if (countBadge) countBadge.textContent = visibleCount;
        });
      }

      // Default select first case if none specified
      if (!selectedCaseSlug && cases.length > 0) {
        selectedCaseSlug = cases[0].id;
        window.location.hash = `#/cases/${selectedCaseSlug}`;
        return;
      }

      if (selectedCaseSlug) {
        const caseRes = await fetch(`/api/cases/${selectedCaseSlug}`);
        if (caseRes.ok) {
          const caseData = await caseRes.json();
          this.renderJudgmentReader(caseData);
        }
      } else {
        this.elReaderContainer.innerHTML = `
          <div class="reader-welcome">
            <div class="welcome-card">
              <div class="welcome-icon"><i data-lucide="gavel"></i></div>
              <h2>Select any judgment from the left pane to read</h2>
              <p>Browse traffic law precedents, tribunal reviews, and high court decisions.</p>
            </div>
          </div>
        `;
      }
    } catch (e) {
      console.error("Error loading caselaw browser:", e);
    }
  }

  renderJudgmentReader(caseData) {
    this._currentCaseData = caseData;

    // Reset scroll positions to top when loading new case
    if (this.elReaderContainer) this.elReaderContainer.scrollTop = 0;
    const contentPane = document.getElementById("content-pane");
    if (contentPane) contentPane.scrollTop = 0;

    // Configure Action Buttons with Primary Link (NSW Caselaw, AustLII, Jade)
    const rawPrimaryUrl = caseData.source_url || caseData.nsw_caselaw_url || caseData.austlii_url;
    const primaryInfo = this.resolveSourceProvider(rawPrimaryUrl, "Primary Source");
    
    // Check if case is officially on NSW Caselaw
    const isNswCourt = caseData.court && (caseData.court.startsWith("NSW") || caseData.court === "NSWSC" || caseData.court === "NSWCA" || caseData.court === "NSWCCA" || caseData.court === "NSWDC" || caseData.court === "NSWLC" || caseData.court === "NSWLEC" || caseData.court.includes("CAT"));
    const nswCaselawUrl = caseData.nsw_caselaw_url || (isNswCourt && caseData.mnc && (!caseData.source_url || !caseData.source_url.includes("austlii")) ? `https://www.caselaw.nsw.gov.au/decision/${encodeURIComponent(caseData.mnc)}` : null);
    
    // Check AustLII URL
    const austliiUrl = caseData.austlii_url || (caseData.source_url && caseData.source_url.includes("austlii.edu.au") ? caseData.source_url : `https://www.austlii.edu.au/cgi-bin/sinosrch.cgi?query=${encodeURIComponent(caseData.citation || caseData.mnc || caseData.title)}`);
    
    // Check BarNet Jade URL
    const jadeUrl = caseData.jade_url || `https://jade.io/search/${encodeURIComponent(caseData.citation || caseData.mnc || caseData.title)}`;
    
    const fullTitle = caseData.title || caseData.citation;
    const primarySourceUrl = rawPrimaryUrl || nswCaselawUrl || austliiUrl;

    // Update Context Subbar Source Link button to prioritize verified primary source
    const sourceLinkBtn = document.getElementById("source-link-btn");
    if (sourceLinkBtn) {
      sourceLinkBtn.href = primarySourceUrl;
      const providerLabel = primaryInfo ? primaryInfo.label : (nswCaselawUrl ? 'NSW Caselaw' : 'AustLII');
      sourceLinkBtn.title = `View primary source judgment (${providerLabel})`;
    }

    // Update Context Subbar breadcrumbs for judgment
    if (this.elBreadcrumbs) {
      this.elBreadcrumbs.innerHTML = `
        <span class="crumb root" onclick="app.navigateTo('browse', 'caselaw')">Caselaw</span>
        <span class="crumb-separator">/</span>
        <span class="crumb">${caseData.court || 'Court'}</span>
        <span class="crumb-separator">/</span>
        <span class="crumb active">${caseData.mnc || caseData.id}</span>
      `;
    }

    // Calculate paragraph-level note counts from caseData.commentary
    const notesByPara = {};
    for (const c of (caseData.commentary || [])) {
      if (c.target_paragraph_start) {
        const start = c.target_paragraph_start;
        const end = c.target_paragraph_end || start;
        for (let p = start; p <= end; p++) {
          notesByPara[p] = (notesByPara[p] || 0) + 1;
        }
      }
    }

    // Map judicial opinions by starting paragraph
    const opinionByStartPara = {};
    for (const op of (caseData.judge_opinions || [])) {
      if (op.start_para) {
        opinionByStartPara[op.start_para] = op;
      }
    }

    let lastPageNum = null;
    const renderedParagraphs = (caseData.paragraphs || []).map(p => {
      let pHtml = p.content_html || "";
      const pNum = p.paragraph_number;
      const pPage = p.page_number || p.page || 1;
      const count = notesByPara[pNum] || 0;
      
      let badgeHtml = "";
      if (count > 0) {
        badgeHtml = `<span class="para-comment-badge" onclick="app.showParagraphCommentary(${pNum})" title="View ${count} practitioner note(s) for paragraph [${pNum}]">💬 ${count}</span>`;
      }
      const addTriggerHtml = `<button class="para-add-note-btn" onclick="app.openCommentaryModal('case', '${caseData.id}', ${pNum})" title="Add note to paragraph [${pNum}]" style="opacity: 0.35; font-size: 0.65rem; background: transparent; border: 1px dashed var(--border-medium); border-radius: 3px; padding: 0 4px; cursor: pointer; margin-left: 4px; color: var(--text-muted);">+</button>`;
      
      // Page break marker if page changed
      let pageMarkerHtml = "";
      if (lastPageNum === null || pPage !== lastPageNum) {
        lastPageNum = pPage;
        pageMarkerHtml = `
          <div class="pdf-page-marker" id="page-${pPage}">
            <div class="pdf-page-line"></div>
            <span class="pdf-page-badge" title="Original PDF Page ${pPage}">
              <i data-lucide="file-text"></i> Page ${pPage}
            </span>
            <div class="pdf-page-line"></div>
          </div>
        `;
      }

      const op = opinionByStartPara[pNum];
      let opDividerHtml = "";
      if (op) {
        const roleLower = (op.role || "").toLowerCase();
        const tagClass = roleLower.includes("lead") ? "tag-lead" : (roleLower.includes("dissent") ? "tag-dissent" : "tag-concur");
        opDividerHtml = `
          <div class="judgment-opinion-divider" id="opinion-judge-${pNum}">
            <div class="opinion-divider-content">
              <div class="opinion-judge-title"><i data-lucide="scale"></i> <span>${op.judge}</span></div>
              <div class="opinion-meta-tags">
                <span class="opinion-role-tag ${tagClass}">${op.role}</span>
                <span class="opinion-page-tag"><i data-lucide="file-text"></i> Page ${op.page || pPage}</span>
                <span class="opinion-para-tag">Starts at [${op.start_para}]</span>
              </div>
            </div>
          </div>
        `;
      }

      if (pHtml.includes('class="para-num">')) {
        const modified = pHtml.replace(/(<a [^>]*class="para-num"[^>]*>\[\d+\]<\/a>)/, `$1 ${badgeHtml}${addTriggerHtml}`);
        return `${pageMarkerHtml}${opDividerHtml}${modified}`;
      } else {
        return `${pageMarkerHtml}${opDividerHtml}<div class="para-wrap" id="para-${pNum}">${badgeHtml}${addTriggerHtml} ${pHtml}</div>`;
      }
    }).join('');

    // Configure Legacy Banner / Incomplete Banner
    let bannerHtml = "";
    if (caseData.is_legacy_pdf || caseData.synthetic_paragraphs) {
      let conf = caseData.confidence_score || {};
      if (typeof conf === "string") {
        try { conf = JSON.parse(conf); } catch (e) { conf = {}; }
      }
      let confBadge = "";
      if (conf.status === 'HIGH') {
        confBadge = `<span class="legacy-banner-badge badge-high" title="All Coram judges identified, authentic paragraphs reconstructed"><i data-lucide="check-circle-2" style="width: 11px; height: 11px; display: inline;"></i> High Confidence (${(caseData.paragraphs || []).length} paras, ${(caseData.judge_opinions || []).length}/${conf.coram_expected || (caseData.judge_opinions || []).length} judges)</span>`;
      } else if (conf.status === 'MEDIUM') {
        confBadge = `<span class="legacy-banner-badge badge-medium" title="Partial judge segmentation: ${conf.issues ? conf.issues.join('; ') : ''}"><i data-lucide="alert-circle" style="width: 11px; height: 11px; display: inline;"></i> Medium Confidence (${(caseData.judge_opinions || []).length}/${conf.coram_expected || 3} judges)</span>`;
      } else if (conf.status === 'NEEDS_REVIEW') {
        confBadge = `<span class="legacy-banner-badge badge-review" title="${conf.issues ? conf.issues.join('; ') : 'Manual check recommended'}"><i data-lucide="alert-triangle" style="width: 11px; height: 11px; display: inline;"></i> Needs Review</span>`;
      } else {
        confBadge = `<span class="legacy-banner-badge">Synthesized [1]...[${(caseData.paragraphs || []).length}]</span>`;
      }

      bannerHtml = `
        <div class="legacy-judgment-banner">
          <div class="legacy-banner-header">
            <div class="legacy-banner-icon-title">
              <i data-lucide="shield-alert" class="legacy-banner-icon"></i>
              <div class="legacy-banner-titles">
                <span class="legacy-banner-title">Historical Judgment (Digitized from Transcript / PDF)</span>
                <span class="legacy-banner-subtitle">Pre-MNC Ingestion Pipeline • Layout-Aware Paragraph Reconstruction</span>
              </div>
            </div>
            ${confBadge}
          </div>
          <p class="legacy-banner-body">
            This historical decision predates electronic medium-neutral paragraph numbering. Paragraph markers [1], [2], etc., have been algorithmically synthesized from the source document to enable cross-referencing and practitioner notes. <strong>Please verify exact citations against the original.</strong>
          </p>
          <div class="legacy-banner-actions">
            ${caseData.pdf_asset_url ? `
              <a href="${caseData.pdf_asset_url}" target="_blank" rel="noopener noreferrer" class="legacy-action-btn primary-pdf-btn">
                <i data-lucide="file-down"></i> <span>Open Original PDF</span>
              </a>
            ` : ''}
            ${caseData.nsw_caselaw_url || caseData.source_url ? `
              <a href="${caseData.nsw_caselaw_url || caseData.source_url}" target="_blank" rel="noopener noreferrer" class="legacy-action-btn">
                <i data-lucide="external-link"></i> <span>View on NSW Caselaw</span>
              </a>
            ` : ''}
          </div>
        </div>
      `;
    } else if (caseData.is_incomplete) {
      bannerHtml = `
        <div class="incomplete-judgment-banner">
          <div class="legacy-banner-header">
            <div class="legacy-banner-icon-title">
              <i data-lucide="alert-triangle" class="legacy-banner-icon"></i>
              <div class="legacy-banner-titles">
                <span class="legacy-banner-title">Limited / Excerpt Judgment Record</span>
                <span class="legacy-banner-subtitle">Only ${(caseData.paragraphs || []).length} paragraph(s) indexed</span>
              </div>
            </div>
          </div>
          <p class="legacy-banner-body">
            This judgment entry contains limited paragraphs or an abbreviated transcript. <strong>Please verify exact citations against the original.</strong>
          </p>
          <div class="legacy-banner-actions">
            ${primarySourceUrl ? `
              <a href="${primarySourceUrl}" target="_blank" rel="noopener noreferrer" class="legacy-action-btn">
                <i data-lucide="external-link"></i> <span>View Primary Source</span>
              </a>
            ` : ''}
          </div>
        </div>
      `;
    }

    // Configure Headnote / Catchwords Card
    let headnoteCardHtml = "";
    const headnoteBody = caseData.headnote || caseData.catchwords;
    if (headnoteBody && headnoteBody.trim().length > 10) {
      headnoteCardHtml = `
        <div class="judgment-headnote-card">
          <div class="headnote-header">
            <div style="display: flex; align-items: center; gap: 6px;">
              <i data-lucide="bookmark" style="width: 14px; height: 14px; color: var(--brand-primary);"></i>
              <strong>Headnote & Catchwords Summary</strong>
            </div>
            <span class="headnote-badge">NSW Caselaw Ingestion</span>
          </div>
          <div class="headnote-content">
            ${headnoteBody}
          </div>
        </div>
      `;
    }

    // Configure Coram & Opinions Bar (Horizontal header chips)
    let coramBarHtml = "";
    const ops = caseData.judge_opinions || [];
    if (ops.length > 0) {
      coramBarHtml = `
        <div class="coram-opinions-bar">
          <div class="coram-bar-label">
            <i data-lucide="users"></i>
            <span>Judicial Opinions (${ops.length}):</span>
          </div>
          <div class="coram-chips-list">
            ${ops.map(op => {
              const roleLower = (op.role || "").toLowerCase();
              const roleClass = roleLower.includes("lead") ? "role-lead" : (roleLower.includes("dissent") ? "role-dissent" : "role-concur");
              return `
                <button class="judge-opinion-chip ${roleClass}" onclick="app.jumpToParagraph(${op.start_para})" title="Jump to ${op.judge}'s opinion (Starts at Page ${op.page || 1}, Paragraph [${op.start_para}])">
                  <span class="judge-chip-name">👨‍⚖️ ${op.judge}</span>
                  <span class="judge-chip-role">${op.role}</span>
                  <span class="judge-chip-para">p. ${op.page || 1} [${op.start_para}]</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else if (caseData.coram_list && caseData.coram_list.length > 1) {
      coramBarHtml = `
        <div class="coram-opinions-bar">
          <div class="coram-bar-label">
            <i data-lucide="users"></i>
            <span>Coram Bench (${caseData.coram_list.length}):</span>
          </div>
          <div class="coram-chips-list">
            ${caseData.coram_list.map(judge => `
              <span class="judge-opinion-chip role-coram">
                <span class="judge-chip-name">👨‍⚖️ ${judge}</span>
              </span>
            `).join('')}
          </div>
        </div>
      `;
    }

    this.elReaderContainer.innerHTML = `
      <div class="reader-single-article">
        <article class="provision-article">
          <header class="provision-header" style="border-bottom: 2px solid var(--border-medium); padding-bottom: 1rem; margin-bottom: 1.5rem;">
            <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap;">
              <span class="badge-statute badge-act">${caseData.jurisdiction || 'NSW'} Judgment</span>
              <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600;">${caseData.court}</span>
              ${caseData.mnc ? `<span class="badge-statute" style="font-size: 0.75rem; background: var(--bg-hover);">${caseData.mnc}</span>` : ''}
            </div>
            <h1 style="font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--text-primary); line-height: 1.35;">${fullTitle}</h1>
            <div style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
              <strong>Bench:</strong> ${caseData.bench || 'Tribunal / Court'} | <strong>Decision Date:</strong> ${caseData.judgment_date || 'N/A'}
            </div>

            <!-- External Primary & Secondary Links Bar -->
            <div class="external-links-bar" style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem;">
              ${(() => {
                let btns = '';
                const isAustliiPrimary = rawPrimaryUrl && rawPrimaryUrl.includes('austlii.edu.au');

                if (isAustliiPrimary) {
                  btns += `
                    <a href="${austliiUrl}" target="_blank" rel="noopener noreferrer" class="action-btn" style="background: #1e40af; color: #fff; border-color: #1e40af;" title="Official Primary Source on AustLII">
                      <i data-lucide="external-link"></i> <span>Primary: AustLII</span>
                    </a>
                  `;
                  if (nswCaselawUrl) {
                    btns += `
                      <a href="${nswCaselawUrl}" target="_blank" rel="noopener noreferrer" class="action-btn" title="NSW Caselaw Database">
                        <i data-lucide="scale"></i> <span>NSW Caselaw</span>
                      </a>
                    `;
                  }
                } else if (nswCaselawUrl) {
                  btns += `
                    <a href="${nswCaselawUrl}" target="_blank" rel="noopener noreferrer" class="action-btn" style="background: #065F46; color: #fff; border-color: #065F46;" title="Official Primary Source on NSW Caselaw">
                      <i data-lucide="scale"></i> <span>Primary: NSW Caselaw</span>
                    </a>
                  `;
                  if (austliiUrl) {
                    btns += `
                      <a href="${austliiUrl}" target="_blank" rel="noopener noreferrer" class="action-btn" title="Secondary Reference Database (AustLII)">
                        <i data-lucide="external-link"></i> <span>AustLII</span>
                      </a>
                    `;
                  }
                } else {
                  btns += `
                    <a href="${primarySourceUrl}" target="_blank" rel="noopener noreferrer" class="action-btn" style="background: var(--brand-primary); color: #fff; border-color: var(--brand-primary);" title="Official Source">
                      <i data-lucide="${primaryInfo ? primaryInfo.icon : 'external-link'}"></i> <span>Primary: ${primaryInfo ? primaryInfo.label : 'Source'}</span>
                    </a>
                  `;
                  if (austliiUrl) {
                    btns += `
                      <a href="${austliiUrl}" target="_blank" rel="noopener noreferrer" class="action-btn" title="AustLII Database">
                        <i data-lucide="external-link"></i> <span>AustLII</span>
                      </a>
                    `;
                  }
                }

                // BarNet Jade
                btns += `
                  <a href="${jadeUrl}" target="_blank" rel="noopener noreferrer" class="action-btn" title="Search BarNet Jade Legal Intelligence">
                    <i data-lucide="external-link"></i> <span>BarNet Jade</span>
                  </a>
                `;

                // Check for archived local sources (e.g. PDF/DOCX)
                if (caseData.sources && Array.isArray(caseData.sources)) {
                  for (const src of caseData.sources) {
                    if (src.local_file_path && src.file_format === 'pdf') {
                      btns += `
                        <span class="action-btn" style="background: var(--bg-hover); color: var(--text-secondary); cursor: default;" title="Archived Authenticated PDF in Canopy Repository: ${src.local_file_path}">
                          <i data-lucide="file-check"></i> <span>Archived PDF ${src.file_size_bytes ? '(' + Math.round(src.file_size_bytes / 1024) + ' KB)' : ''}</span>
                        </span>
                      `;
                    }
                  }
                }

                return btns;
              })()}
            </div>
          </header>

          ${bannerHtml}
          ${coramBarHtml}
          ${headnoteCardHtml}

          <!-- Authoritative Coversheet Card & Table -->
          <div class="judgment-coversheet-card">
            <table class="judgment-coversheet-table">
              <tbody>
                <tr>
                  <th>Court / Tribunal</th>
                  <td><strong>${caseData.court}</strong> ${caseData.jurisdiction ? `(${caseData.jurisdiction})` : ''}</td>
                </tr>
                ${caseData.mnc ? `
                <tr>
                  <th>Medium Neutral Citation</th>
                  <td><code>${caseData.mnc}</code></td>
                </tr>
                ` : ''}
                ${caseData.parties ? `
                <tr>
                  <th>Parties</th>
                  <td>${caseData.parties}</td>
                </tr>
                ` : ''}
                ${caseData.bench ? `
                <tr>
                  <th>Before</th>
                  <td>${caseData.bench}</td>
                </tr>
                ` : ''}
                ${caseData.hearing_dates ? `
                <tr>
                  <th>Hearing Date(s)</th>
                  <td>${caseData.hearing_dates}</td>
                </tr>
                ` : ''}
                <tr>
                  <th>Date of Decision</th>
                  <td>${caseData.judgment_date || 'N/A'}</td>
                </tr>
                ${caseData.file_numbers ? `
                <tr>
                  <th>File Number(s)</th>
                  <td>${caseData.file_numbers}</td>
                </tr>
                ` : ''}
                ${caseData.catchwords ? `
                <tr>
                  <th>Catchwords</th>
                  <td>${caseData.catchwords}</td>
                </tr>
                ` : ''}
                ${caseData.legislation_cited ? `
                <tr>
                  <th>Legislation Cited</th>
                  <td>${caseData.legislation_cited}</td>
                </tr>
                ` : ''}
              </tbody>
            </table>
          </div>

          <!-- Judgment Paragraph Blocks -->
          <div class="judgment-paragraphs-body">
            ${renderedParagraphs}
          </div>
        </article>
      </div>
    `;

    // Open Right Info Pane and Load Case Intelligence
    this.renderCaseInfoPaneData(caseData);
    lucide.createIcons();

    if (this.findBarOpen && this.elReaderFindInput && this.elReaderFindInput.value.trim()) {
      setTimeout(() => this.executeReaderFind(), 40);
    }
  }

  navigateTo(actSlug, slug) {
    if (!actSlug || actSlug === "home") {
      window.location.hash = "#/";
    } else if (!slug) {
      window.location.hash = `#/${actSlug}`;
    } else {
      window.location.hash = `#/${actSlug}/${slug}`;
    }
  }

  navigateToHome() {
    window.location.hash = "#/";
  }

  async switchAct(actSlug) {
    this.currentAct = actSlug;

    if (!this.allStatutes || this.allStatutes.length === 0) {
      await this.loadStatutesDirectory();
    }

    // Update active tab states
    document.querySelectorAll(".act-tab").forEach(tab => {
      tab.classList.remove("active");
    });
    const activeTab = document.querySelector(`.act-tab[data-act="${actSlug}"]`);
    if (activeTab) {
      activeTab.classList.add("active");
    } else if (this.elStatuteMenuBtn) {
      this.elStatuteMenuBtn.classList.add("active");
    }

    // Update statute label
    const actMeta = this.allStatutes.find(a => a.slug === actSlug);
    if (actMeta && this.elStatuteMenuLabel) {
      this.elStatuteMenuLabel.textContent = actMeta.short_title;
    }

    // Update search scope label
    const scopeLabel = document.getElementById("search-scope-label");
    if (scopeLabel) {
      scopeLabel.textContent = actMeta ? actMeta.short_title : "Current Act";
    }

    this.renderStatuteList();
    await this.loadTree();
  }

  async renderHomepage() {
    // Close right-side info pane on home page
    this.closeInfoPane();

    // Highlight home tab
    document.querySelectorAll(".act-tab").forEach(tab => tab.classList.remove("active"));
    const homeBtn = document.getElementById("nav-home-btn");
    if (homeBtn) homeBtn.classList.add("active");

    // Hide reader footer
    if (this.elReaderFooter) this.elReaderFooter.style.display = "none";

    // Set Breadcrumbs to Home
    if (this.elBreadcrumbs) {
      this.elBreadcrumbs.innerHTML = `
        <span class="crumb root"><i data-lucide="tree-pine"></i> Canopy Legal</span>
        <span class="crumb-separator">/</span>
        <span class="crumb active">Home & Statutory Portfolios</span>
      `;
    }

    // If stats not yet loaded, fetch them
    if (!this.platformStats) {
      try {
        const res = await fetch("/api/stats");
        this.platformStats = await res.json();
      } catch (e) {}
    }

    const totalStatutes = this.platformStats ? this.platformStats.total_statutes : 7;
    const totalProvs = this.platformStats ? this.platformStats.total_provisions.toLocaleString() : "3,344";
    const actsCount = this.platformStats ? this.platformStats.acts_count : 3;
    const regsCount = this.platformStats ? this.platformStats.regs_count : 4;

    const html = `
      <div class="homepage-container">
        
        <!-- Hero Section -->
        <section class="hero-section">
          <div class="hero-brand-emblem-wrap" style="display: flex; justify-content: center; margin-bottom: 1.25rem;">
            <img src="/static/logo/canopy_logo_512_forest_green.png" alt="Canopy Legal Emblem" style="width: 80px; height: 80px; filter: drop-shadow(0 4px 14px rgba(6, 78, 59, 0.14));" />
          </div>
          <div class="hero-badge">
            <i data-lucide="shield-check"></i>
            <span>NSW Traffic Law & Cross-Jurisdictional Intelligence</span>
          </div>
          <h1 class="hero-title">NSW Traffic Law, Caselaw & Penalties Platform</h1>
          <p class="hero-subtitle">
            Specialised reader for NSW Road Transport legislation, Judicial Commission Lawpart codes, 
            disqualifications, demerit points, and paragraph-linked caselaw precedents.
          </p>
          <div class="hero-search-box" onclick="app.focusOmnibox()">
            <i data-lucide="search"></i>
            <input type="text" placeholder="Search NSW Road Rules, PCA offences, section 110, rule 20, or caselaw... (Ctrl+K)" readonly />
            <kbd>Ctrl K</kbd>
          </div>
        </section>

        <!-- Interactive Portfolios Grid -->
        <h2 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 1rem; color: var(--text-primary);">Core Statutory & Caselaw Suites</h2>
        <section class="portfolios-grid">
          
          <!-- Primary NSW Traffic & Road Transport Card -->
          <div class="portfolio-card" style="border-top: 4px solid #065F46;">
            <div class="portfolio-top">
              <span class="portfolio-tag" style="background: #ECFDF5; color: #065F46; font-weight: 700;">
                <i data-lucide="car"></i> Primary Focus: NSW Traffic Law
              </span>
              <span class="badge-statute badge-act">Core Suite</span>
            </div>
            <h3 class="portfolio-title">NSW Road Transport & Traffic Suite</h3>
            <p class="portfolio-desc">
              Foundational NSW traffic framework covering driver licensing, PCA breath testing, speed offences, penalty notices, demerit points, and court enforcement.
            </p>

            <a href="#/browse/legislation" class="portfolio-btn" style="margin-bottom: 0.85rem; background: #065F46; color: #FFFFFF; font-weight: 600;">
              <span>Browse All Legislation & Regs (A–Z)</span>
              <i data-lucide="arrow-right"></i>
            </a>
            
            <div class="portfolio-statutes-list">
              <a href="#/road-transport-act-2013" class="portfolio-statute-row">
                <span>Road Transport Act 2013 (NSW)</span>
                <span class="badge-statute badge-act">395 Provisions</span>
              </a>
              <a href="#/road-rules-2014" class="portfolio-statute-row">
                <span>Road Rules 2014 (NSW)</span>
                <span class="badge-statute badge-reg">466 Rules</span>
              </a>
            </div>

            <div class="portfolio-quick-jumps">
              <div class="quick-jumps-title">Featured Lawpart Penalty Sections:</div>
              <div class="jump-chips-wrap">
                <a href="#/road-transport-act-2013/main/s110" class="jump-chip">s 110 PCA Penalties (28 Lawparts)</a>
                <a href="#/road-rules-2014/main/s20" class="jump-chip">rule 20 Speeding Limits (322 Lawparts)</a>
                <a href="#/road-transport-act-2013/main/s268" class="jump-chip">s 268 Exceptional Circumstances</a>
              </div>
            </div>

            <a href="#/road-transport-act-2013" class="portfolio-btn">
              <span>Open Road Transport Act 2013 (NSW)</span>
              <i data-lucide="arrow-right"></i>
            </a>
          </div>

          <!-- Caselaw & Precedents Card -->
          <div class="portfolio-card" style="border-top: 4px solid #2563EB;">
            <div class="portfolio-top">
              <span class="portfolio-tag" style="background: #EFF6FF; color: #1D4ED8; font-weight: 700;">
                <i data-lucide="gavel"></i> Judicial Decisions
              </span>
              <span class="badge-statute badge-act">Paragraph Anchored</span>
            </div>
            <h3 class="portfolio-title">Caselaw & Judicial Precedents</h3>
            <p class="portfolio-desc">
              Indexed judicial decisions with atomic paragraph addressing, statutory cross-linking, and fast-linked editorial commentary.
            </p>

            <a href="#/browse/caselaw" class="portfolio-btn" style="margin-bottom: 0.85rem; background: #2563EB; color: #FFFFFF; font-weight: 600;">
              <span>Browse All Judicial Decisions</span>
              <i data-lucide="arrow-right"></i>
            </a>

            <div class="portfolio-statutes-list">
              <a href="#/cases/lakeman-v-commissioner-of-police-new-south-wales-police-service-2001-nswadt-128" class="portfolio-statute-row">
                <span>Lakeman v Commissioner of Police [2001] NSWADT 128</span>
                <span class="badge-statute badge-reg">s 268(5) License Suspension</span>
              </a>
            </div>

            <div class="portfolio-quick-jumps">
              <div class="quick-jumps-title">Paragraph Fast-Links:</div>
              <div class="jump-chips-wrap">
                <a href="#/cases/lakeman-v-commissioner-of-police-new-south-wales-police-service-2001-nswadt-128" class="jump-chip">[1] Suspension Review</a>
                <a href="#/cases/lakeman-v-commissioner-of-police-new-south-wales-police-service-2001-nswadt-128" class="jump-chip">[15]-[22] Exceptional Hardship</a>
              </div>
            </div>

            <a href="#/cases" class="portfolio-btn">
              <span>Open Caselaw Browser</span>
              <i data-lucide="arrow-right"></i>
            </a>
          </div>

          <!-- Financial Services, Superannuation & Banking Card -->
          <div class="portfolio-card" style="border-top: 4px solid #D97706;">
            <div class="portfolio-top">
              <span class="portfolio-tag" style="background: #FEF3C7; color: #92400E; font-weight: 700;">
                <i data-lucide="landmark"></i> Financial & Banking (CTH)
              </span>
              <span class="badge-statute badge-act">4 Statutes</span>
            </div>
            <h3 class="portfolio-title">Financial Services, Superannuation & Banking</h3>
            <p class="portfolio-desc">
              Commonwealth prudential statutory regimes governing superannuation entity covenants, banking executive accountability, insurance contract disclosures, and financial data collection.
            </p>

            <div class="portfolio-statutes-list">
              <a href="#/superannuation-industry-supervision-act-1993" class="portfolio-statute-row">
                <span>Superannuation Industry (Supervision) Act 1993 (CTH)</span>
                <span class="badge-statute badge-act">645 Provisions</span>
              </a>
              <a href="#/banking-act-1959" class="portfolio-statute-row">
                <span>Banking Act 1959 (CTH)</span>
                <span class="badge-statute badge-act">249 Provisions</span>
              </a>
              <a href="#/insurance-contracts-act-1984" class="portfolio-statute-row">
                <span>Insurance Contracts Act 1984 (CTH)</span>
                <span class="badge-statute badge-act">138 Provisions</span>
              </a>
              <a href="#/financial-sector-collection-of-data-act-2001" class="portfolio-statute-row">
                <span>Financial Sector (Collection of Data) Act 2001 (CTH)</span>
                <span class="badge-statute badge-act">48 Provisions</span>
              </a>
            </div>

            <div class="portfolio-quick-jumps">
              <div class="quick-jumps-title">Key Provisions & Statutory Covenants:</div>
              <div class="jump-chips-wrap">
                <a href="#/superannuation-industry-supervision-act-1993/main/s52" class="jump-chip">s 52 Trustee Covenants</a>
                <a href="#/superannuation-industry-supervision-act-1993/main/s62" class="jump-chip">s 62 Sole Purpose Test</a>
                <a href="#/banking-act-1959/main/s11af" class="jump-chip">s 11AF APRA Standards</a>
                <a href="#/insurance-contracts-act-1984/main/s13" class="jump-chip">s 13 Utmost Good Faith</a>
              </div>
            </div>

            <a href="#/superannuation-industry-supervision-act-1993" class="portfolio-btn">
              <span>Open SIS Act 1993</span>
              <i data-lucide="arrow-right"></i>
            </a>
          </div>

          <!-- Criminal Sentencing & Administrative Review Card -->
          <div class="portfolio-card" style="border-top: 4px solid #991B1B;">
            <div class="portfolio-top">
              <span class="portfolio-tag" style="background: #FEF2F2; color: #991B1B; font-weight: 700;">
                <i data-lucide="scale"></i> Sentencing & Court Review (NSW)
              </span>
              <span class="badge-statute badge-act">2 Statutes</span>
            </div>
            <h3 class="portfolio-title">Criminal Sentencing & Administrative Review</h3>
            <p class="portfolio-desc">
              NSW sentencing principles, non-conviction dismissals (s 10), intensive correction orders, and administrative tribunal review jurisdiction for licensing decisions.
            </p>

            <div class="portfolio-statutes-list">
              <a href="#/crimes-sentencing-procedure-act-1999" class="portfolio-statute-row">
                <span>Crimes (Sentencing Procedure) Act 1999 (NSW)</span>
                <span class="badge-statute badge-act">180 Provisions</span>
              </a>
              <a href="#/administrative-decisions-review-act-1997" class="portfolio-statute-row">
                <span>Administrative Decisions Review Act 1997 (NSW)</span>
                <span class="badge-statute badge-act">32 Provisions</span>
              </a>
            </div>

            <div class="portfolio-quick-jumps">
              <div class="quick-jumps-title">Key Sentencing & Review Sections:</div>
              <div class="jump-chips-wrap">
                <a href="#/crimes-sentencing-procedure-act-1999/part-2/division-3/s10" class="jump-chip">s 10 Dismissal / Discharge</a>
                <a href="#/crimes-sentencing-procedure-act-1999/part-2/division-2/s7" class="jump-chip">s 7 Intensive Correction Order</a>
                <a href="#/administrative-decisions-review-act-1997/chapter-3/part-3/division-3/s63" class="jump-chip">ADR Act s 63 Tribunal Review</a>
              </div>
            </div>

            <a href="#/crimes-sentencing-procedure-act-1999" class="portfolio-btn">
              <span>Open Crimes (Sentencing Procedure) Act 1999</span>
              <i data-lucide="arrow-right"></i>
            </a>
          </div>

        </section>

        <!-- External Legal Portals Directory -->
        <h2 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 1rem; color: var(--text-primary);">External Official Legal Portals Directory</h2>
        <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 2.5rem;">
          
          <a href="https://www.caselaw.nsw.gov.au" target="_blank" rel="noopener noreferrer" class="stat-card" style="text-decoration: none; text-align: left; border-top: 3px solid #065F46;">
            <div style="font-size: 0.7rem; font-weight: 700; color: #065F46; text-transform: uppercase; margin-bottom: 4px;">Primary Official Authority</div>
            <div style="font-size: 1rem; font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">NSW Caselaw <i data-lucide="external-link" style="width: 14px; height: 14px; vertical-align: middle;"></i></div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">caselaw.nsw.gov.au</div>
          </a>

          <a href="https://www.austlii.edu.au/au/cases/nsw/" target="_blank" rel="noopener noreferrer" class="stat-card" style="text-decoration: none; text-align: left;">
            <div style="font-size: 0.7rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">Secondary Reference</div>
            <div style="font-size: 1rem; font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">AustLII <i data-lucide="external-link" style="width: 14px; height: 14px; vertical-align: middle;"></i></div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">austlii.edu.au</div>
          </a>

          <a href="https://jade.io" target="_blank" rel="noopener noreferrer" class="stat-card" style="text-decoration: none; text-align: left;">
            <div style="font-size: 0.7rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">BarNet Citations</div>
            <div style="font-size: 1rem; font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">Jade <i data-lucide="external-link" style="width: 14px; height: 14px; vertical-align: middle;"></i></div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">jade.io</div>
          </a>

          <a href="https://lpcgoweb.lpcgo.workers.dev/" target="_blank" rel="noopener noreferrer" class="stat-card" style="text-decoration: none; text-align: left; border-top: 3px solid #10B981;">
            <div style="font-size: 0.7rem; font-weight: 700; color: #047857; text-transform: uppercase; margin-bottom: 4px;">Lawpart Code Search</div>
            <div style="font-size: 1rem; font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">LPCGo Tool <i data-lucide="external-link" style="width: 14px; height: 14px; vertical-align: middle;"></i></div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">lpcgoweb.lpcgo.workers.dev</div>
          </a>

        </div>

      </div>
    `;

    this.elReaderContainer.innerHTML = html;
    lucide.createIcons();

    setTimeout(() => {
      if (this.elOmniboxInput) {
        this.elOmniboxInput.focus();
      }
    }, 60);
  }

  focusOmnibox() {
    if (this.elOmniboxInput) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      this.elOmniboxInput.focus();
      this.elOmniboxInput.select();
      if (this.elOmniboxInput.value.trim()) {
        this.fetchOmniboxFlyout();
      }
    }
  }

  async renderLegislationBrowse() {
    this.setShellMode("portal");
    const legBtn = document.getElementById("nav-browse-leg-btn");
    if (legBtn) legBtn.classList.add("active");

    if (this.elReaderFooter) this.elReaderFooter.style.display = "none";

    if (this.elBreadcrumbs) {
      this.elBreadcrumbs.innerHTML = `
        <span class="crumb root"><i data-lucide="tree-pine"></i> Canopy Legal</span>
        <span class="crumb-separator">/</span>
        <span class="crumb active">Legislation & Regulations Directory</span>
      `;
    }

    if (!this.allStatutes || this.allStatutes.length === 0) {
      await this.loadStatutesDirectory();
    }

    if (!this.browseFilter) {
      this.browseFilter = { category: "all", letter: "ALL", search: "" };
    }

    this.renderBrowseView(true);
  }

  setBrowseLetterFilter(categoryKey, letter) {
    if (this.browseFilter.category === categoryKey && this.browseFilter.letter === letter) {
      // Toggle off
      this.browseFilter.category = "all";
      this.browseFilter.letter = "ALL";
    } else {
      this.browseFilter.category = categoryKey;
      this.browseFilter.letter = letter;
    }
    this.renderBrowseView(true);
  }

  clearBrowseFilter() {
    this.browseFilter = { category: "all", letter: "ALL", search: "" };
    this.renderBrowseView(true);
  }

  clearBrowseSearch() {
    this.browseFilter.search = "";
    this.renderBrowseView(true);
  }

  handleBrowseSearchInput(val) {
    this.browseFilter.search = (val || "").trim();
    this.renderBrowseContentOnly();
  }

  buildAzRow(categoryKey, labelText) {
    const catStatutes = (this.allStatutes || []).filter(s => {
      const j_id = (s.jurisdiction_id || "").toLowerCase();
      const cat = (s.category || "act").toLowerCase();
      if (categoryKey === "nsw-acts") return j_id === "nsw" && cat === "act";
      if (categoryKey === "nsw-regs") return j_id === "nsw" && cat === "regulation";
      if (categoryKey === "cth-acts") return j_id === "cth" && cat === "act";
      if (categoryKey === "cth-regs") return (j_id === "cth" && cat === "regulation") || (j_id === "national" && cat === "regulation");
      return true;
    });

    const letterCounts = {};
    for (const s of catStatutes) {
      const title = (s.short_title || "").trim();
      const firstChar = title.charAt(0).toUpperCase();
      if (firstChar >= "A" && firstChar <= "Z") {
        letterCounts[firstChar] = (letterCounts[firstChar] || 0) + 1;
      }
    }

    const isCatActive = (this.browseFilter.category === categoryKey);
    const isAllActive = isCatActive && (this.browseFilter.letter === "ALL");

    let lettersHtml = `
      <button class="az-letter-btn ${isAllActive ? 'active' : ''}" onclick="app.setBrowseLetterFilter('${categoryKey}', 'ALL')">All</button>
    `;

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    for (const letter of alphabet) {
      const count = letterCounts[letter] || 0;
      const isActive = isCatActive && (this.browseFilter.letter === letter);
      if (count > 0) {
        lettersHtml += `<button class="az-letter-btn ${isActive ? 'active' : ''}" title="${count} ${count === 1 ? 'statute' : 'statutes'}" onclick="app.setBrowseLetterFilter('${categoryKey}', '${letter}')">${letter}</button>`;
      } else {
        lettersHtml += `<button class="az-letter-btn disabled" disabled>${letter}</button>`;
      }
    }

    return `
      <div class="browse-az-row">
        <span class="browse-az-label">${labelText}</span>
        <div class="browse-az-letters">${lettersHtml}</div>
      </div>
    `;
  }

  buildInstrumentCard(s) {
    const isAct = (s.category || "act") === "act";
    const badgeClass = isAct ? "badge-act" : "badge-reg";
    const badgeText = isAct ? "Act" : "Reg";
    const j_id = (s.jurisdiction_id || "cth").toUpperCase();
    const provCount = s.provision_count ? `${s.provision_count.toLocaleString()} Provisions` : "";

    const PINPOINTS_MAP = {
      "road-transport-act-2013": [
        { label: "s 110 (PCA Offence Penalties)", slug: "main/s110" },
        { label: "s 268 (License Appeals)", slug: "main/s268" }
      ],
      "road-rules-2014": [
        { label: "Rule 20 (Speeding Limits)", slug: "main/s20" },
        { label: "Rule 306 (Emergency Exemption)", slug: "main/s306" }
      ],
      "superannuation-industry-supervision-act-1993": [
        { label: "s 52 (Trustee Covenants)", slug: "main/s52" },
        { label: "s 62 (Sole Purpose Test)", slug: "main/s62" }
      ],
      "banking-act-1959": [
        { label: "s 11AF (APRA Standards)", slug: "main/s11af" }
      ],
      "insurance-contracts-act-1984": [
        { label: "s 13 (Utmost Good Faith)", slug: "main/s13" }
      ],
      "competition-and-consumer-act-2010": [
        { label: "s 45 (Cartels & Restraints)", slug: "main/s45" },
        { label: "s 50 (Mergers & Acquisitions)", slug: "main/s50" }
      ],
      "australian-consumer-law": [
        { label: "s 18 (Misleading Conduct)", slug: "main/s18" },
        { label: "s 21 (Unconscionable Conduct)", slug: "main/s21" }
      ],
      "heavy-vehicle-national-law": [
        { label: "s 89 (Mass Requirements)", slug: "main/s89" },
        { label: "s 250 (Fatigue Management)", slug: "main/s250" }
      ]
    };

    const pins = PINPOINTS_MAP[s.slug] || [];
    let pinsHtml = "";
    if (pins.length > 0) {
      pinsHtml = `
        <div class="browse-card-chips">
          ${pins.map(p => `
            <span class="browse-chip" onclick="event.stopPropagation(); window.location.hash='#/${s.slug}/${p.slug}'" title="Jump to ${p.label}">
              ${p.label}
            </span>
          `).join('')}
        </div>
      `;
    }

    return `
      <div class="browse-instrument-card" onclick="window.location.hash='#/${s.slug}'">
        <div class="browse-instrument-top">
          <div style="flex: 1; min-width: 0;">
            <div class="browse-instrument-title">${s.short_title}</div>
            <div class="browse-instrument-meta">
              <span class="badge-statute ${badgeClass}">${badgeText}</span>
              <span>•</span>
              <span style="font-weight: 600; color: var(--text-secondary);">${j_id}</span>
              ${provCount ? `<span>•</span><span>${provCount}</span>` : ''}
              <span>•</span>
              <span style="text-transform: capitalize;">${s.portfolio || 'General'}</span>
            </div>
          </div>
          <div style="display: flex; align-items: center; padding-left: 0.5rem;">
            <i data-lucide="chevron-right" style="width: 18px; height: 18px; color: var(--text-muted);"></i>
          </div>
        </div>
        ${pinsHtml}
      </div>
    `;
  }

  getFilteredStatutes() {
    let list = this.allStatutes || [];

    // Filter by search query
    if (this.browseFilter.search) {
      const q = this.browseFilter.search.toLowerCase();
      list = list.filter(s => {
        const title = (s.short_title || "").toLowerCase();
        const slug = (s.slug || "").toLowerCase();
        const portfolio = (s.portfolio || "").toLowerCase();
        const j_id = (s.jurisdiction_id || "").toLowerCase();
        return title.includes(q) || slug.includes(q) || portfolio.includes(q) || j_id.includes(q);
      });
    }

    // Filter by category row
    if (this.browseFilter.category !== "all") {
      const catKey = this.browseFilter.category;
      list = list.filter(s => {
        const j_id = (s.jurisdiction_id || "").toLowerCase();
        const cat = (s.category || "act").toLowerCase();
        if (catKey === "nsw-acts") return j_id === "nsw" && cat === "act";
        if (catKey === "nsw-regs") return j_id === "nsw" && cat === "regulation";
        if (catKey === "cth-acts") return j_id === "cth" && cat === "act";
        if (catKey === "cth-regs") return (j_id === "cth" && cat === "regulation") || (j_id === "national" && cat === "regulation");
        return true;
      });
    }

    // Filter by starting letter
    if (this.browseFilter.letter !== "ALL") {
      const targetLetter = this.browseFilter.letter.toUpperCase();
      list = list.filter(s => {
        const title = (s.short_title || "").trim().toUpperCase();
        return title.startsWith(targetLetter);
      });
    }

    return list;
  }

  renderBrowseContentOnly() {
    const contentArea = document.getElementById("browse-content-area");
    if (!contentArea) {
      this.renderBrowseView(true);
      return;
    }
    const filtered = this.getFilteredStatutes();
    contentArea.innerHTML = this.buildBrowseContentHtml(filtered);
    lucide.createIcons();
  }

  buildBrowseContentHtml(filteredStatutes) {
    const isFiltered = (this.browseFilter.category !== "all" || this.browseFilter.letter !== "ALL" || !!this.browseFilter.search);

    const catLabels = {
      "nsw-acts": "NSW Acts",
      "nsw-regs": "NSW Regulations",
      "cth-acts": "Commonwealth Acts",
      "cth-regs": "Commonwealth Regulations"
    };

    let html = "";

    // Active Filter Indicator Strip
    if (isFiltered) {
      let filterSummary = "Active Filter: ";
      if (this.browseFilter.category !== "all") {
        filterSummary += `<strong>${catLabels[this.browseFilter.category] || this.browseFilter.category}</strong>`;
      }
      if (this.browseFilter.letter !== "ALL") {
        filterSummary += ` starting with <strong>"${this.browseFilter.letter}"</strong>`;
      }
      if (this.browseFilter.search) {
        filterSummary += ` matching <strong>"${this.browseFilter.search}"</strong>`;
      }
      filterSummary += ` • <strong>${filteredStatutes.length}</strong> ${filteredStatutes.length === 1 ? 'instrument' : 'instruments'} found`;

      html += `
        <div class="active-filter-strip">
          <span><i data-lucide="filter" style="width: 14px; height: 14px; vertical-align: middle; margin-right: 4px;"></i> ${filterSummary}</span>
          <button class="clear-filter-btn" onclick="app.clearBrowseFilter()"><i data-lucide="x"></i> Clear All</button>
        </div>
      `;
    }

    if (filteredStatutes.length === 0) {
      html += `
        <div style="padding: 3rem 1.5rem; text-align: center; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px;">
          <i data-lucide="filter-x" style="width: 36px; height: 36px; color: var(--text-muted); margin-bottom: 0.75rem;"></i>
          <h3 style="font-size: 1.1rem; font-weight: 700; margin-bottom: 0.5rem;">No statutes match your filter criteria</h3>
          <p style="color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1.25rem;">Try clearing your search query or selecting another starting letter above.</p>
          <button onclick="app.clearBrowseFilter()" class="portfolio-btn" style="display: inline-flex; width: auto; padding: 6px 16px; margin: 0 auto;">
            <i data-lucide="rotate-ccw"></i> Reset Filters
          </button>
        </div>
      `;
      return html;
    }

    // Group matching statutes by jurisdiction
    const nswStatutes = filteredStatutes.filter(s => (s.jurisdiction_id || '').toLowerCase() === 'nsw');
    const cthStatutes = filteredStatutes.filter(s => (s.jurisdiction_id || '').toLowerCase() === 'cth');
    const natStatutes = filteredStatutes.filter(s => {
      const j = (s.jurisdiction_id || '').toLowerCase();
      return j === 'national' || j === 'qld';
    });

    if (nswStatutes.length > 0) {
      html += `
        <div class="jurisdiction-group-section">
          <div class="jurisdiction-group-title">
            <span><i data-lucide="landmark" style="width: 18px; height: 18px; vertical-align: middle; margin-right: 6px; color: #065F46;"></i> New South Wales (NSW)</span>
            <span class="badge-statute" style="background: var(--bg-hover); font-size: 0.75rem;">${nswStatutes.length} ${nswStatutes.length === 1 ? 'Instrument' : 'Instruments'}</span>
          </div>
          <div class="browse-instruments-grid">
            ${nswStatutes.map(s => this.buildInstrumentCard(s)).join('')}
          </div>
        </div>
      `;
    }

    if (cthStatutes.length > 0) {
      html += `
        <div class="jurisdiction-group-section">
          <div class="jurisdiction-group-title">
            <span><i data-lucide="scale" style="width: 18px; height: 18px; vertical-align: middle; margin-right: 6px; color: #2563EB;"></i> Commonwealth of Australia (CTH)</span>
            <span class="badge-statute" style="background: var(--bg-hover); font-size: 0.75rem;">${cthStatutes.length} ${cthStatutes.length === 1 ? 'Instrument' : 'Instruments'}</span>
          </div>
          <div class="browse-instruments-grid">
            ${cthStatutes.map(s => this.buildInstrumentCard(s)).join('')}
          </div>
        </div>
      `;
    }

    if (natStatutes.length > 0) {
      html += `
        <div class="jurisdiction-group-section">
          <div class="jurisdiction-group-title">
            <span><i data-lucide="truck" style="width: 18px; height: 18px; vertical-align: middle; margin-right: 6px; color: #D97706;"></i> National Applied Schemes (Heavy Vehicle)</span>
            <span class="badge-statute" style="background: var(--bg-hover); font-size: 0.75rem;">${natStatutes.length} ${natStatutes.length === 1 ? 'Instrument' : 'Instruments'}</span>
          </div>
          <div class="browse-instruments-grid">
            ${natStatutes.map(s => this.buildInstrumentCard(s)).join('')}
          </div>
        </div>
      `;
    }

    return html;
  }

  renderBrowseView(full = true) {
    const filtered = this.getFilteredStatutes();

    if (!full) {
      this.renderBrowseContentOnly();
      return;
    }

    const html = `
      <div class="browse-container">
        <!-- Breadcrumb & Header -->
        <div class="browse-header">
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem;">
            <a href="#/" style="display: inline-flex; align-items: center; gap: 4px; text-decoration: none; color: var(--border-active); font-size: 0.8125rem; font-weight: 600;">
              <i data-lucide="arrow-left" style="width: 14px; height: 14px;"></i> Home
            </a>
            <span style="color: var(--text-muted); font-size: 0.75rem;">/</span>
            <span style="color: var(--text-muted); font-size: 0.8125rem;">Browse Legislation</span>
          </div>
          <h1>Legislation & Regulations Directory</h1>
          <p>Comprehensive index of in-force Acts, statutory rules, regulations, and applied national scheme frameworks across New South Wales and the Commonwealth.</p>
        </div>

        <!-- Live Instant Search Bar -->
        <div class="browse-search-bar">
          <i data-lucide="search" style="width: 16px; height: 16px; color: var(--text-muted);"></i>
          <input type="text" id="browse-filter-search" placeholder="Filter statutes by title, number, portfolio, or jurisdiction (e.g. transport, banking, 2013)..." value="${this.browseFilter.search || ''}" oninput="app.handleBrowseSearchInput(this.value)" />
          ${this.browseFilter.search ? `<button onclick="app.clearBrowseSearch()" style="background: transparent; border: none; cursor: pointer; color: var(--text-muted); padding: 2px;"><i data-lucide="x" style="width: 14px; height: 14px;"></i></button>` : ''}
        </div>

        <!-- Horizontal Alphabetical (A-Z) Quick-Filter Rows -->
        <div class="browse-az-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.85rem;">
            <div class="browse-az-title">Alphabetical Browse (A–Z Quick-Filter)</div>
            ${(this.browseFilter.category !== 'all' || this.browseFilter.letter !== 'ALL' || this.browseFilter.search) ? `
              <button onclick="app.clearBrowseFilter()" style="background: none; border: none; color: var(--border-active); font-size: 0.75rem; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                <i data-lucide="rotate-ccw" style="width: 12px; height: 12px;"></i> Reset All Filters
              </button>
            ` : ''}
          </div>
          ${this.buildAzRow('nsw-acts', 'NSW Acts')}
          ${this.buildAzRow('nsw-regs', 'NSW Regulations')}
          ${this.buildAzRow('cth-acts', 'Commonwealth Acts')}
          ${this.buildAzRow('cth-regs', 'Commonwealth Regulations')}
        </div>

        <!-- Content Area: Grouped by Jurisdiction -->
        <div id="browse-content-area">
          ${this.buildBrowseContentHtml(filtered)}
        </div>
      </div>
    `;

    this.elReaderContainer.innerHTML = html;
    lucide.createIcons();
  }

  renderActOverview() {
    // Close right-side info pane on act overview / launch page
    this.closeInfoPane();
    if (this.elToggleInfoBtn) this.elToggleInfoBtn.style.display = "none";
    const printIntelWrap = document.getElementById("print-intel-wrap");
    if (printIntelWrap) printIntelWrap.style.display = "none";
    if (this.elReaderFooter) this.elReaderFooter.style.display = "none";

    const actMeta = this.allStatutes.find(a => a.slug === this.currentAct);
    const title = actMeta ? actMeta.short_title : this.currentAct;
    const isAct = (actMeta && actMeta.category === "regulation") ? false : true;

    if (this.elBreadcrumbs) {
      this.elBreadcrumbs.innerHTML = `
        <span class="crumb root"><i data-lucide="${isAct ? 'landmark' : 'file-text'}"></i> ${title}</span>
        <span class="crumb-separator">/</span>
        <span class="crumb active">Overview</span>
      `;
    }

    const firstNode = this.currentTree[0];
    const firstSlug = firstNode ? firstNode.slug : "";

    this.elReaderContainer.innerHTML = `
      <div class="reader-welcome">
        <div class="welcome-card">
          <div class="welcome-icon"><i data-lucide="book-open"></i></div>
          <h2>${title}</h2>
          <p>
            Browse the table of contents in the left pane to view continuous text for any Chapter or Part, 
            or click individual sections for focused statutory reading.
          </p>
          <div class="quick-links" style="margin-top: 1rem;">
            ${firstNode ? `<button class="quick-chip" onclick="app.navigateTo('${this.currentAct}', '${firstSlug}')">Start Reading: ${firstNode.identifier} (${firstNode.title})</button>` : ''}
            <button class="quick-chip" onclick="app.openSearchModal()"><i data-lucide="search" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle;"></i> Search in this ${isAct ? 'Act' : 'Regulation'}</button>
          </div>
        </div>
      </div>
    `;
    lucide.createIcons();
  }

  async loadTree() {
    this.elTreeContainer.innerHTML = `
      <div class="loading-spinner">
        <i data-lucide="loader-2" class="spin"></i>
        <span>Loading legislative hierarchy...</span>
      </div>
    `;
    lucide.createIcons();

    try {
      const res = await fetch(`/api/acts/${this.currentAct}/tree`);
      const data = await res.json();
      this.currentTree = data.tree || [];
      
      this.flatProvisionsList = [];
      this.extractProvisions(this.currentTree);

      this.renderTree(this.currentTree);
    } catch (e) {
      this.elTreeContainer.innerHTML = `<div class="error-msg">Error loading table of contents: ${e.message}</div>`;
    }
  }

  extractProvisions(nodes) {
    for (const node of nodes) {
      if (node.provisions && node.provisions.length > 0) {
        for (const p of node.provisions) {
          this.flatProvisionsList.push(p);
        }
      }
      if (node.children && node.children.length > 0) {
        this.extractProvisions(node.children);
      }
    }
  }

  renderTree(nodes) {
    const badge = document.getElementById("tree-stats-badge");
    if (badge) {
      badge.textContent = `${this.flatProvisionsList.length} provisions`;
    }

    if (!nodes || nodes.length === 0) {
      this.elTreeContainer.innerHTML = `<div class="empty-state">No structural provisions found for this instrument.</div>`;
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "tree-root";
    for (const node of nodes) {
      ul.appendChild(this.buildNodeElement(node));
    }
    this.elTreeContainer.innerHTML = "";
    this.elTreeContainer.appendChild(ul);
    lucide.createIcons();
  }

  buildNodeElement(node) {
    const li = document.createElement("li");
    li.className = "tree-node";
    li.dataset.id = node.id;
    li.dataset.slug = node.slug;
    li.dataset.type = node.node_type;

    const hasChildren = (node.children && node.children.length > 0);
    const hasProvisions = (node.provisions && node.provisions.length > 0);
    const isBranch = hasChildren || hasProvisions;

    const row = document.createElement("div");
    row.className = "node-row";

    const toggleSpan = document.createElement("span");
    toggleSpan.className = isBranch ? "node-toggle open" : "node-toggle";
    if (isBranch) {
      toggleSpan.innerHTML = `<i data-lucide="chevron-right"></i>`;
      toggleSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleNode(li);
      });
    }
    row.appendChild(toggleSpan);

    const titleSpan = document.createElement("span");
    titleSpan.className = "node-title";
    if (node.identifier && node.title) {
      titleSpan.innerHTML = `<strong>${node.identifier}</strong> — ${node.title}`;
    } else {
      titleSpan.textContent = node.identifier || node.title || "";
    }
    titleSpan.title = node.identifier ? `${node.identifier} — ${node.title}` : (node.title || "");
    row.appendChild(titleSpan);

    row.addEventListener("click", () => {
      this.navigateTo(this.currentAct, node.slug);
      // Auto expand on click if branch is collapsed
      if (isBranch) {
        this.toggleNode(li, true);
      }
    });

    li.appendChild(row);

    if (isBranch) {
      li.classList.add("expanded");
      const childUl = document.createElement("ul");
      childUl.className = "node-children";
      childUl.style.display = "block";

      if (hasChildren) {
        for (const child of node.children) {
          childUl.appendChild(this.buildNodeElement(child));
        }
      }

      if (hasProvisions) {
        for (const prov of node.provisions) {
          const provLi = document.createElement("li");
          provLi.className = "tree-provision-item";
          provLi.dataset.slug = prov.full_slug;
          provLi.dataset.id = prov.id;

          provLi.innerHTML = `
            <span class="prov-num-badge">${prov.identifier}</span>
            <span class="prov-title" title="${prov.identifier} ${prov.title}">${prov.title}</span>
          `;
          provLi.addEventListener("click", (e) => {
            e.stopPropagation();
            this.navigateTo(this.currentAct, prov.full_slug);
          });
          childUl.appendChild(provLi);
        }
      }

      li.appendChild(childUl);
    }

    return li;
  }

  toggleNode(li, forceState) {
    const childUl = li.querySelector(":scope > .node-children");
    if (!childUl) return;

    const toggle = li.querySelector(":scope > .node-row > .node-toggle");
    const isExpanded = childUl.style.display === "block";
    const newState = (forceState !== undefined) ? forceState : !isExpanded;

    childUl.style.display = newState ? "block" : "none";
    li.classList.toggle("expanded", newState);
    if (toggle) {
      toggle.classList.toggle("open", newState);
    }
  }

  expandAllNodes(expand) {
    this.elTreeContainer.querySelectorAll(".tree-node").forEach(node => {
      this.toggleNode(node, expand);
    });
  }

  filterTree(query) {
    const q = query.toLowerCase().trim();
    if (!q) {
      this.elTreeContainer.querySelectorAll(".tree-node, .tree-provision-item").forEach(el => {
        el.style.display = "";
      });
      return;
    }

    this.elTreeContainer.querySelectorAll(".tree-node").forEach(node => {
      let hasMatch = false;
      const title = node.querySelector(":scope > .node-row .node-title")?.textContent.toLowerCase() || "";
      if (title.includes(q)) hasMatch = true;

      node.querySelectorAll(".tree-provision-item").forEach(prov => {
        const provText = prov.textContent.toLowerCase();
        if (provText.includes(q)) {
          prov.style.display = "";
          hasMatch = true;
        } else {
          prov.style.display = "none";
        }
      });

      if (hasMatch) {
        node.style.display = "";
        this.toggleNode(node, true);
      } else {
        node.style.display = "none";
      }
    });
  }

  async loadTarget(targetSlug) {
    this.elReaderContainer.innerHTML = `
      <div class="loading-spinner">
        <i data-lucide="loader-2" class="spin"></i>
        <span>Loading statutory text...</span>
      </div>
    `;
    lucide.createIcons();

    // 1. Try loading as provision
    try {
      const provRes = await fetch(`/api/acts/${this.currentAct}/provisions/${targetSlug}`);
      if (provRes.ok) {
        const prov = await provRes.json();
        this.renderSingleProvision(prov);
        this.highlightTreeNode(prov.full_slug);
        return;
      }
    } catch (e) {}

    // 2. Try loading as structural container (Chapter/Part/Schedule)
    try {
      const nodeRes = await fetch(`/api/acts/${this.currentAct}/nodes/${targetSlug}`);
      if (nodeRes.ok) {
        const nodeData = await nodeRes.json();
        this.renderContinuousContainer(nodeData);
        this.highlightTreeNode(nodeData.node.slug);
        return;
      }
    } catch (e) {}

    this.elReaderContainer.innerHTML = `
      <div class="error-msg">
        <h3>Provision or Heading Not Found</h3>
        <p>Could not locate "<strong>${targetSlug}</strong>" in ${this.currentAct}.</p>
      </div>
    `;
  }

  renderSingleProvision(prov) {
    this.currentScope = { type: "provision", data: prov };
    this.renderBreadcrumbs(prov.breadcrumbs, prov.identifier, prov.title);

    const actTitle = prov.act_title || this.currentAct;
    const asAtDate = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    
    // Build structural hierarchy map text (Chapter > Part > Division > Section)
    const mapItems = (prov.breadcrumbs || []).map(b => `${b.node_type ? `${b.node_type} ` : ''}${b.identifier ? `${b.identifier} — ` : ''}${b.title}`);
    mapItems.push(`Section ${prov.identifier}`);
    const mapHierarchyText = mapItems.join(' › ');

    // Print intelligence block if enabled
    let intelPrintHtml = "";
    if (this.printWithIntel && prov.info) {
      const lawparts = prov.info.lawparts || [];
      const cases = prov.info.cases || [];
      const comms = prov.info.commentary || [];

      intelPrintHtml = `
        <section class="print-intelligence-section" style="margin-top: 2rem; padding-top: 1.5rem; border-top: 2px dashed var(--border-medium);">
          <h3 style="font-size: 1.05rem; font-weight: 700; color: #064E3B; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em;">
            Section Intelligence & Commentary — Section ${prov.identifier}
          </h3>
          
          <div style="margin-bottom: 1.25rem;">
            <h4 style="font-size: 0.875rem; font-weight: 700; margin-bottom: 0.4rem; color: var(--text-primary);">
              1. Penalties & Offence Variants (${lawparts.length})
            </h4>
            ${lawparts.length === 0 ? '<p style="font-size: 0.8rem; color: var(--text-muted);">No Judicial Commission lawpart penalties recorded for this section.</p>' : `
              <div style="display: flex; flex-direction: column; gap: 0.45rem;">
                ${lawparts.map(l => `
                  <div style="padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: 4px; font-size: 0.78rem;">
                    <strong>LPC ${l.lawpart_code}:</strong> ${l.variant_description || l.description || ''}
                    <div style="color: var(--text-secondary); margin-top: 2px;">
                      ${l.max_fine_amount ? `Max Fine: $${Number(l.calculated_fine_dollars || l.max_fine_amount).toLocaleString()} ` : ''}
                      ${l.max_gaol_months ? `| Gaol: ${l.max_gaol_months} mos ` : ''}
                      ${l.disqual_min_months ? `| Min Disqual: ${l.disqual_min_months} mos ` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            `}
          </div>

          <div style="margin-bottom: 1.25rem;">
            <h4 style="font-size: 0.875rem; font-weight: 700; margin-bottom: 0.4rem; color: var(--text-primary);">
              2. Citing Judicial Authorities (${cases.length})
            </h4>
            ${cases.length === 0 ? '<p style="font-size: 0.8rem; color: var(--text-muted);">No citing decisions indexed for this section.</p>' : `
              <ul style="font-size: 0.78rem; color: var(--text-primary); padding-left: 1.2rem; margin: 0;">
                ${cases.map(c => `
                  <li style="margin-bottom: 0.35rem;">
                    <strong>${c.citation || c.title}</strong> (${c.court}, ${c.judgment_date || 'N/A'}) — Para [${c.paragraph_number}]: <em>"${c.raw_citation_text}"</em>
                  </li>
                `).join('')}
              </ul>
            `}
          </div>

          <div>
            <h4 style="font-size: 0.875rem; font-weight: 700; margin-bottom: 0.4rem; color: var(--text-primary);">
              3. Practitioner & Commentary Notes (${comms.length})
            </h4>
            ${comms.length === 0 ? '<p style="font-size: 0.8rem; color: var(--text-muted);">No practitioner notes recorded for this section.</p>' : `
              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                ${comms.map(cm => `
                  <div style="padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: 4px; font-size: 0.78rem;">
                    <div style="font-weight: 700; color: var(--text-primary);">${cm.title || 'Note'} <span style="font-weight: normal; color: var(--text-muted);">(${cm.author_name || 'Practitioner'})</span></div>
                    <div style="margin-top: 0.25rem; color: var(--text-secondary);">${cm.body_html || cm.body_markdown}</div>
                  </div>
                `).join('')}
              </div>
            `}
          </div>
        </section>
      `;
    }

    this.elReaderContainer.innerHTML = `
      <div class="reader-single-article">
        <!-- Authoritative Statutory Document Header -->
        <header class="provision-doc-header">
          <div class="doc-header-top">
            <span class="doc-jurisdiction-badge">${actTitle.includes('NSW') ? 'NSW Legislation In Force' : 'Commonwealth Statutory Database'}</span>
            <span class="doc-map-hierarchy">${mapHierarchyText}</span>
          </div>
          <h2 class="doc-act-title">${actTitle}</h2>
          <div class="doc-disclaimer">
            Current version as at ${asAtDate} • Official In-Force Database Status
          </div>
        </header>

        <article class="provision-article single-view" id="prov-view-${prov.id}">
          ${prov.content_html}
          ${intelPrintHtml}
        </article>
      </div>
    `;
    lucide.createIcons();

    this.updateFooterNav(prov.id);
    if (this.elToggleInfoBtn) this.elToggleInfoBtn.style.display = "inline-flex";
    const printIntelWrap = document.getElementById("print-intel-wrap");
    if (printIntelWrap) printIntelWrap.style.display = "inline-flex";
    this.renderInfoPaneData(prov);

    if (this.findBarOpen && this.elReaderFindInput && this.elReaderFindInput.value.trim()) {
      setTimeout(() => this.executeReaderFind(), 40);
    }
  }

  togglePrintIntelligence(enabled) {
    this.printWithIntel = !!enabled;
    const appEl = document.getElementById("app");
    if (appEl) {
      appEl.classList.toggle("print-with-intel", this.printWithIntel);
    }
    if (this.currentScope && this.currentScope.type === "provision" && this.currentScope.data) {
      this.renderSingleProvision(this.currentScope.data);
    }
  }

  switchInfoTab(targetTab) {
    document.querySelectorAll(".info-tab").forEach(t => {
      if (t.dataset.tab === targetTab) {
        t.classList.add("active");
      } else {
        t.classList.remove("active");
      }
    });
    document.querySelectorAll(".info-tab-panel").forEach(p => {
      p.style.display = "none";
      p.classList.remove("active");
    });
    const activePanel = document.getElementById(`panel-${targetTab}`);
    if (activePanel) {
      activePanel.style.display = "block";
      activePanel.classList.add("active");
    }
  }

  jumpToParagraph(start, end) {
    if (window.scrollToParagraph) {
      window.scrollToParagraph(start, end);
    }
  }

  toggleInfoPane() {
    if (!this.elInfoPane) return;
    const isVisible = this.elInfoPane.style.display === "flex";
    if (isVisible) {
      this.closeInfoPane();
    } else {
      this.elInfoPane.style.display = "flex";
      if (this.elToggleInfoBtn) this.elToggleInfoBtn.classList.add("active");
    }
  }

  closeInfoPane() {
    if (this.elInfoPane) {
      this.elInfoPane.style.display = "none";
      if (this.elToggleInfoBtn) this.elToggleInfoBtn.classList.remove("active");
    }
  }

  renderInfoPaneData(prov) {
    if (!this.elInfoPane) return;
    this.ensureLegislationInfoPane();

    const info = prov.info || { lawparts: [], count: 0, db_name: "JudCom Lawparts" };
    const lawparts = info.lawparts || [];
    const dbName = info.db_name || "JudCom Lawparts";

    const sectionTag = document.getElementById("info-section-tag");
    if (sectionTag) sectionTag.textContent = `s ${prov.identifier}`;

    const dbTag = document.getElementById("info-db-tag");
    if (dbTag) dbTag.textContent = dbName;

    // Render Lawparts Container
    const container = document.getElementById("info-lawparts-container");
    this.currentLawparts = lawparts;

    if (container) {
      if (lawparts.length === 0) {
        container.innerHTML = `
          <div class="info-empty-state">
            <i data-lucide="info"></i>
            <p>No Lawpart penalty codes indexed for <strong>s ${prov.identifier}</strong> in ${dbName}. Lawpart codes cover criminal, traffic, and statutory offences.</p>
          </div>
        `;
      } else {
        const cardsHtml = lawparts.map(l => this.buildLawpartCard(l)).join("");
        container.innerHTML = `
          <div class="lawpart-filter-bar">
            <div class="lawpart-search-box">
              <i data-lucide="search" style="width: 13px; height: 13px; color: var(--text-muted); flex-shrink: 0;"></i>
              <input type="text" id="lawparts-filter-input" placeholder="Filter by code (e.g. 79007), section, or text..." oninput="app.filterLawparts(this.value)" />
            </div>
            <div class="lawparts-count-info" id="lawparts-count-info">${lawparts.length} variants</div>
          </div>
          <div id="lawparts-cards-list">
            ${cardsHtml}
          </div>
        `;
      }
    }

    // Update tab labels with counts
    const tabLawparts = document.querySelector('.info-tab[data-tab="lawparts"]');
    if (tabLawparts) {
      tabLawparts.innerHTML = `<i data-lucide="scale"></i> Penalties & Lawparts${lawparts.length > 0 ? ` (${lawparts.length})` : ''}`;
    }
    const tabCaselaw = document.querySelector('.info-tab[data-tab="caselaw"]');
    const cases = info.cases || [];
    if (tabCaselaw) {
      tabCaselaw.innerHTML = `<i data-lucide="gavel"></i> Caselaw${cases.length > 0 ? ` (${cases.length})` : ''}`;
    }
    const tabComm = document.querySelector('.info-tab[data-tab="commentary"]');
    const commList = info.commentary || [];
    if (tabComm) {
      tabComm.innerHTML = `<i data-lucide="file-text"></i> Commentary${commList.length > 0 ? ` (${commList.length})` : ''}`;
    }

    // Render Citing Caselaw Container
    const caselawContainer = document.getElementById("info-caselaw-container");
    if (caselawContainer) {
      if (cases.length === 0) {
        caselawContainer.innerHTML = `
          <div class="info-empty-state">
            <i data-lucide="gavel"></i>
            <p>No citing judicial decisions currently indexed for <strong>s ${prov.identifier}</strong> in our caselaw database.</p>
          </div>
        `;
      } else {
        let cHtml = `
          <div style="font-size: 0.72rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.6rem;">
            ${cases.length} Citing Judicial Decision${cases.length > 1 ? 's' : ''}:
          </div>
        `;
        for (const c of cases) {
          cHtml += `
            <div class="lawpart-card" style="margin-bottom: 0.75rem;">
              <div class="lawpart-card-header">
                <span class="lawpart-code-chip">${c.court}</span>
                <span class="lawpart-sec-tag">${c.judgment_date || 'N/A'}</span>
              </div>
              <div style="font-weight: 700; font-size: 0.8125rem; color: var(--text-primary); margin-bottom: 0.35rem;">
                <a href="#/cases/${c.id}" style="color: inherit; text-decoration: none;">${c.citation || c.title}</a>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-secondary); line-height: 1.4; margin-bottom: 0.5rem;">
                Referenced at Para [${c.paragraph_number}]: <em>"${c.raw_citation_text}"</em>
              </div>
              <div style="display: flex; gap: 0.5rem;">
                <a href="#/cases/${c.id}" class="action-btn" style="font-size: 0.7rem; padding: 3px 8px; text-decoration: none;">
                  <i data-lucide="book-open" style="width: 12px; height: 12px;"></i> View Case
                </a>
                ${(() => {
                  const sUrl = c.nsw_caselaw_url || c.source_url;
                  if (!sUrl) return '';
                  const sInfo = this.resolveSourceProvider(sUrl);
                  return `
                    <a href="${sUrl}" target="_blank" rel="noopener noreferrer" class="action-btn" style="font-size: 0.7rem; padding: 3px 8px; text-decoration: none;" title="Open original judgment on ${sInfo ? sInfo.label : 'source'}">
                      <i data-lucide="${sInfo ? sInfo.icon : 'external-link'}" style="width: 12px; height: 12px;"></i> ${sInfo ? sInfo.label : 'Source'}
                    </a>
                  `;
                })()}
              </div>
            </div>
          `;
        }
        caselawContainer.innerHTML = cHtml;
      }
    }

    this._currentProvData = prov;
    this.renderProvisionCommentary(prov, this.commentaryTierFilter || "all");

    lucide.createIcons();

    // Auto-open info pane if Lawparts exist and pane is not explicitly closed
    if (lawparts.length > 0 && this.elInfoPane.style.display !== "flex") {
      this.toggleInfoPane();
    }
  }

  buildLawpartPills(l) {
    const pills = [];

    // 1. Max Fine
    const fineAmt = (l.max_fine_amount !== null && l.max_fine_amount !== undefined) ? l.max_fine_amount : ((l.fine_amount !== null && l.fine_amount !== undefined) ? l.fine_amount : null);
    const fineUnit = l.max_fine_unit || l.fine_unit || "PU";
    if (fineAmt !== null && fineAmt !== undefined && Number(fineAmt) > 0) {
      if (fineUnit === "PU") {
        const dollars = l.calculated_fine_dollars || Math.round(Number(fineAmt) * 110);
        pills.push(`
          <span class="penalty-pill pill-fine" title="Maximum Court Fine: $${dollars.toLocaleString()} (${fineAmt} Penalty Units)">
            <i data-lucide="circle-dollar-sign"></i>
            <strong>$${dollars.toLocaleString()}</strong>
            <small>(${fineAmt} PU)</small>
          </span>
        `);
      } else {
        pills.push(`
          <span class="penalty-pill pill-fine" title="Maximum Court Fine: $${Number(fineAmt).toLocaleString()}">
            <i data-lucide="circle-dollar-sign"></i>
            <strong>$${Number(fineAmt).toLocaleString()}</strong>
          </span>
        `);
      }
    } else if (l.max_penalty_fine) {
      pills.push(`
        <span class="penalty-pill pill-fine" title="Maximum Fine: ${this.escapeHtml(l.max_penalty_fine)}">
          <i data-lucide="circle-dollar-sign"></i>
          <strong>${this.escapeHtml(l.max_penalty_fine)}</strong>
        </span>
      `);
    }

    // 2. Imprisonment / Gaol
    if (l.max_gaol_months && Number(l.max_gaol_months) > 0) {
      const gMonths = Number(l.max_gaol_months);
      pills.push(`
        <span class="penalty-pill pill-gaol" title="Maximum Gaol Term: ${gMonths} months imprisonment">
          <i data-lucide="shield-alert"></i>
          <strong>${gMonths} Mos</strong>
          <small>Gaol</small>
        </span>
      `);
    }

    // 3. Licence Disqualification
    if (l.disqual_min_months || l.disqual_auto_months) {
      let dqText = "";
      if (l.disqual_min_months && l.disqual_auto_months) {
        dqText = `Min ${l.disqual_min_months}m / Auto ${l.disqual_auto_months}m`;
      } else if (l.disqual_min_months) {
        dqText = `Min ${l.disqual_min_months}m DQ`;
      } else {
        dqText = `Auto ${l.disqual_auto_months}m DQ`;
      }
      pills.push(`
        <span class="penalty-pill pill-disqual" title="Licence Disqualification: ${dqText}">
          <i data-lucide="ban"></i>
          <strong>${dqText}</strong>
        </span>
      `);
    }

    // 4. Mandatory Interlock Order
    if (l.disqual_interlock_min_months || l.interlock_min_months) {
      let ilLabel = "";
      if (l.disqual_interlock_min_months && l.interlock_min_months) {
        ilLabel = `Interlock ${l.interlock_min_months}m (DQ ${l.disqual_interlock_min_months}m)`;
      } else if (l.interlock_min_months) {
        ilLabel = `Interlock ${l.interlock_min_months}m`;
      } else {
        ilLabel = `Interlock DQ ${l.disqual_interlock_min_months}m`;
      }
      pills.push(`
        <span class="penalty-pill pill-interlock" title="Mandatory Alcohol Interlock Order: ${ilLabel}">
          <i data-lucide="lock"></i>
          <strong>${ilLabel}</strong>
        </span>
      `);
    }

    // 5. Demerit Points
    if (l.demerit_points && Number(l.demerit_points) > 0) {
      const d = Number(l.demerit_points);
      const dbl = Number(l.demerit_points_double || 0);
      const hasDouble = dbl > d;
      pills.push(`
        <span class="penalty-pill pill-demerit" title="Demerit Points: ${d} pts${hasDouble ? ` (${dbl} double demerits)` : ''}">
          <i data-lucide="gauge"></i>
          <strong>${d} Pts</strong>
          ${hasDouble ? `<span class="pill-double-badge">${dbl} Dbl</span>` : ''}
        </span>
      `);
    }

    return pills;
  }

  buildLawpartCard(l) {
    const desc = l.variant_description || l.description || "Offence description not specified";
    const code = String(l.lawpart_code || "");
    const sec = l.section || "";
    const citationText = sec ? `s ${sec}` : "";

    // Categories tags
    let catChips = "";
    if (l.categories && Array.isArray(l.categories) && l.categories.length > 0) {
      catChips = `
        <div class="lawpart-cats-wrap">
          ${l.categories.map(c => `<span class="lawpart-cat-chip">${this.escapeHtml(c)}</span>`).join('')}
        </div>
      `;
    }

    // Semantic Penalty Pills
    const pills = this.buildLawpartPills(l);

    // JudCom Link
    let linkBtn = "";
    if (l.lawcodes_url) {
      linkBtn = `
        <a href="${l.lawcodes_url}" target="_blank" rel="noopener noreferrer" class="lawpart-judcom-link" title="Open official Judicial Commission Lawcodes record #${code}">
          <span>JudCom</span>
          <i data-lucide="external-link"></i>
        </a>
      `;
    }

    return `
      <div class="lawpart-card" data-code="${code}" data-section="${sec}">
        <div class="lawpart-card-header">
          <div class="lawpart-header-left">
            <button class="lawpart-code-badge" onclick="navigator.clipboard.writeText('${code}'); this.classList.add('copied'); setTimeout(() => this.classList.remove('copied'), 1500);" title="Click to copy Lawcode #${code}">
              <i data-lucide="hash"></i>
              <span>${code}</span>
            </button>
            ${citationText ? `<span class="lawpart-sec-pill">${citationText}</span>` : ''}
          </div>
          <div class="lawpart-header-right">
            ${linkBtn}
          </div>
        </div>

        ${catChips}

        <div class="lawpart-desc">${this.escapeHtml(desc)}</div>

        ${pills.length > 0 ? `
          <div class="lawpart-pills-grid">
            ${pills.join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  filterLawparts(query) {
    if (!this.currentLawparts) return;
    const q = (query || "").trim().toLowerCase();
    const filtered = !q ? this.currentLawparts : this.currentLawparts.filter(l => {
      const code = String(l.lawpart_code || "").toLowerCase();
      const sec = String(l.section || "").toLowerCase();
      const desc = String(l.variant_description || l.description || "").toLowerCase();
      return code.includes(q) || sec.includes(q) || desc.includes(q);
    });

    const cardsContainer = document.getElementById("lawparts-cards-list");
    const countInfo = document.getElementById("lawparts-count-info");
    if (countInfo) {
      countInfo.textContent = `${filtered.length} of ${this.currentLawparts.length} variants`;
    }
    if (cardsContainer) {
      if (filtered.length === 0) {
        cardsContainer.innerHTML = `<div class="info-empty-state"><p>No Lawpart codes matching "${query}"</p></div>`;
      } else {
        cardsContainer.innerHTML = filtered.map(l => this.buildLawpartCard(l)).join("");
        lucide.createIcons();
      }
    }
  }

  ensureLegislationInfoPane() {
    if (this._infoPaneMode === "legislation") return;
    this._infoPaneMode = "legislation";

    const icon = document.getElementById("info-pane-icon");
    if (icon) icon.setAttribute("data-lucide", "shield-alert");

    const title = document.getElementById("info-pane-title");
    if (title) title.textContent = "Section Intelligence";

    const tabsContainer = document.getElementById("info-pane-tabs");
    if (tabsContainer) {
      tabsContainer.innerHTML = `
        <button class="info-tab active" data-tab="lawparts" onclick="app.switchInfoTab('lawparts')">
          <i data-lucide="scale"></i> Penalties & Lawparts
        </button>
        <button class="info-tab" data-tab="commentary" onclick="app.switchInfoTab('commentary')">
          <i data-lucide="file-text"></i> Commentary
        </button>
        <button class="info-tab" data-tab="caselaw" onclick="app.switchInfoTab('caselaw')">
          <i data-lucide="gavel"></i> Caselaw
        </button>
      `;
    }

    const bodyContainer = document.getElementById("info-pane-body");
    if (bodyContainer) {
      bodyContainer.innerHTML = `
        <div class="info-tab-panel active" id="panel-lawparts">
          <div id="info-lawparts-container">
            <div class="info-empty-state">
              <i data-lucide="info"></i>
              <p>Select any section to view Judicial Commission penalty codes, gaol terms, disqualifications, and demerits.</p>
            </div>
          </div>
        </div>

        <div class="info-tab-panel" id="panel-commentary" style="display: none;">
          <div id="info-commentary-container" class="commentary-content">
            <div class="commentary-box">
              <h4><i data-lucide="book-open"></i> Statutory Purpose & Context</h4>
              <p id="commentary-text">Select a statutory section to load practitioner notes and interpretation guidance.</p>
            </div>
          </div>
        </div>

        <div class="info-tab-panel" id="panel-caselaw" style="display: none;">
          <div id="info-caselaw-container">
            <div class="caselaw-list">
              <div class="info-empty-state">
                <i data-lucide="gavel"></i>
                <p>Cited caselaw authorities and sentencing guidelines for this section will appear here.</p>
              </div>
            </div>
          </div>
        </div>
      `;
    }
    lucide.createIcons();
  }

  renderCaseInfoPaneData(caseData) {
    if (!this.elInfoPane) return;
    this._infoPaneMode = "case";

    // Set Header
    const icon = document.getElementById("info-pane-icon");
    if (icon) icon.setAttribute("data-lucide", "scale");

    const title = document.getElementById("info-pane-title");
    if (title) title.textContent = "Case Intelligence";

    const sectionTag = document.getElementById("info-section-tag");
    if (sectionTag) sectionTag.textContent = caseData.mnc || caseData.id;

    const dbTag = document.getElementById("info-db-tag");
    if (dbTag) dbTag.textContent = `${caseData.court} (${caseData.jurisdiction || 'NSW'})`;

    const citingCases = caseData.citing_cases || [];
    const precedents = caseData.precedents_cited || [];
    const statuteProvs = caseData.statute_provisions || [];
    const matchedInsts = caseData.matched_instruments || [];
    const commentaries = caseData.commentary || [];
    const judgeOpinions = caseData.judge_opinions || [];
    const coramList = caseData.coram_list || [];

    const statutesCount = statuteProvs.length + matchedInsts.length;
    const opinionsCount = judgeOpinions.length || coramList.length;
    const hasOpinions = opinionsCount > 0;

    // Render Tabs
    const tabsContainer = document.getElementById("info-pane-tabs");
    if (tabsContainer) {
      tabsContainer.innerHTML = `
        ${hasOpinions ? `
          <button class="info-tab active" data-tab="case-opinions" onclick="app.switchInfoTab('case-opinions')">
            <i data-lucide="users"></i> Bench (${opinionsCount})
          </button>
        ` : ''}
        <button class="info-tab ${!hasOpinions ? 'active' : ''}" data-tab="case-citing" onclick="app.switchInfoTab('case-citing')">
          <i data-lucide="arrow-up-right"></i> Citing (${citingCases.length})
        </button>
        <button class="info-tab" data-tab="case-precedents" onclick="app.switchInfoTab('case-precedents')">
          <i data-lucide="git-pull-request"></i> Precedents (${precedents.length})
        </button>
        <button class="info-tab" data-tab="case-statutes" onclick="app.switchInfoTab('case-statutes')">
          <i data-lucide="book"></i> Legislation (${statutesCount})
        </button>
        <button class="info-tab" data-tab="case-commentary" onclick="app.switchInfoTab('case-commentary')">
          <i data-lucide="file-text"></i> Notes (${commentaries.length})
        </button>
      `;
    }

    // Build Panel 0: Coram & Judicial Opinions
    let opinionsHtml = `
      <div class="case-intel-header">
        <div class="case-intel-title">
          <i data-lucide="users"></i>
          <span>Coram & Judicial Opinions</span>
        </div>
        <p class="case-intel-desc">Judicial panel composition, segmented opinions, and starting paragraph anchors.</p>
      </div>
    `;

    if (judgeOpinions.length > 0) {
      opinionsHtml += `
        <div class="subheading-label">
          Segmented Judicial Opinions (${judgeOpinions.length})
        </div>
      `;
      for (const op of judgeOpinions) {
        const roleLower = (op.role || "").toLowerCase();
        const tagClass = roleLower.includes("lead") ? "tag-lead" : (roleLower.includes("dissent") ? "tag-dissent" : "tag-concur");
        opinionsHtml += `
          <div class="lawpart-card opinion-card">
            <div class="lawpart-card-header">
              <span class="opinion-role-tag ${tagClass}">${op.role}</span>
              ${op.page ? `<span class="lawpart-sec-tag">Page ${op.page}</span>` : ''}
            </div>
            <div style="font-weight: 700; font-size: 0.875rem; color: var(--text-primary); margin-bottom: 0.35rem; line-height: 1.35;">
              👨‍⚖️ ${op.judge}
            </div>
            <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
              Starts at synthesized paragraph <strong>[${op.start_para}]</strong>
            </div>
            <div style="display: flex; gap: 0.5rem;">
              <button class="action-btn" onclick="app.jumpToParagraph(${op.start_para})" style="font-size: 0.72rem; padding: 4px 9px; cursor: pointer;">
                <i data-lucide="arrow-down-right" style="width: 12px; height: 12px;"></i> Jump to [${op.start_para}]
              </button>
            </div>
          </div>
        `;
      }
    } else if (coramList.length > 0) {
      opinionsHtml += `
        <div class="subheading-label">
          Coram Bench Members (${coramList.length})
        </div>
      `;
      for (const judge of coramList) {
        opinionsHtml += `
          <div class="lawpart-card opinion-card">
            <div style="font-weight: 700; font-size: 0.875rem; color: var(--text-primary); margin-bottom: 0.2rem;">
              👨‍⚖️ ${judge}
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted);">
              Bench Member (${caseData.court || 'Court'})
            </div>
          </div>
        `;
      }
    } else {
      opinionsHtml += `
        <div class="info-empty-state">
          <i data-lucide="users"></i>
          <p>No separate judicial opinions or coram breakdown extracted for this judgment.</p>
        </div>
      `;
    }

    // Build Panel 1: Citing Cases
    let citingHtml = `
      <div class="case-intel-header">
        <div class="case-intel-title">
          <i data-lucide="arrow-up-right"></i>
          <span>Decisions Citing This Authority</span>
        </div>
        <p class="case-intel-desc">Later judicial decisions and appellate considerations that rely on or discuss this ruling.</p>
      </div>
    `;

    if (citingCases.length === 0) {
      citingHtml += `
        <div class="info-empty-state">
          <i data-lucide="info"></i>
          <p>No citing judgments currently indexed for <strong>${caseData.mnc || caseData.title}</strong>.</p>
        </div>
      `;
    } else {
      for (const cc of citingCases) {
        citingHtml += `
          <div class="lawpart-card citing-case-card">
            <div class="lawpart-card-header">
              <span class="lawpart-code-chip">${cc.court}</span>
              <span class="lawpart-sec-tag">${cc.judgment_date || 'N/A'}</span>
            </div>
            <div style="font-weight: 700; font-size: 0.8125rem; color: var(--text-primary); margin-bottom: 0.35rem; line-height: 1.35;">
              <a href="#/cases/${cc.case_id}" class="case-link-hover">${cc.title}</a>
            </div>
            ${cc.bench ? `
              <div style="font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 0.45rem; line-height: 1.3;">
                <strong>Bench:</strong> ${cc.bench}
              </div>
            ` : ''}
            <div style="display: flex; gap: 0.5rem; margin-top: 0.4rem;">
              <a href="#/cases/${cc.case_id}" class="action-btn" style="font-size: 0.7rem; padding: 3px 8px; text-decoration: none;">
                <i data-lucide="book-open" style="width: 12px; height: 12px;"></i> View Decision
              </a>
              ${cc.mnc ? `
                <a href="https://www.caselaw.nsw.gov.au/decision/${encodeURIComponent(cc.mnc)}" target="_blank" rel="noopener noreferrer" class="action-btn" style="font-size: 0.7rem; padding: 3px 8px; text-decoration: none;">
                  <i data-lucide="external-link" style="width: 12px; height: 12px;"></i> Primary Source
                </a>
              ` : ''}
            </div>
          </div>
        `;
      }
    }

    // Build Panel 2: Precedents Cited (Internal vs External with jump chips)
    let precHtml = `
      <div class="case-intel-header">
        <div class="case-intel-title">
          <i data-lucide="git-pull-request"></i>
          <span>Authorities Considered & Cited</span>
        </div>
        <p class="case-intel-desc">Authorities considered by the Court in this judgment with paragraph jump anchors.</p>
      </div>
    `;

    if (precedents.length === 0) {
      precHtml += `
        <div class="info-empty-state">
          <i data-lucide="git-pull-request"></i>
          <p>No precedent authorities extracted for this judgment.</p>
        </div>
      `;
    } else {
      const internalPrecs = precedents.filter(p => p.is_internal);
      const externalPrecs = precedents.filter(p => !p.is_internal);

      if (internalPrecs.length > 0) {
        precHtml += `
          <div class="subheading-label">
            Canopy Library Precedents (${internalPrecs.length})
          </div>
        `;
        for (const p of internalPrecs) {
          const displayTitle = p.target_title || p.cited_case_title;
          const displayCite = p.cited_case_citation || p.target_mnc || '';
          const paras = p.paragraphs || [];

          let jumpChipsHtml = "";
          if (paras.length > 0) {
            jumpChipsHtml = `
              <div style="margin-top: 0.35rem; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                <span style="font-size: 0.6875rem; color: var(--text-muted); font-weight: 600;">Cited at:</span>
                ${paras.map(pn => `<button class="para-jump-chip" onclick="app.jumpToParagraph(${pn})" title="Jump to paragraph [${pn}] in judgment">[${pn}]</button>`).join('')}
              </div>
            `;
          }

          precHtml += `
            <div class="lawpart-card precedent-card internal-precedent">
              <div class="lawpart-card-header">
                <span class="badge-statute" style="background: rgba(16, 185, 129, 0.15); color: #047857; font-weight: 700; font-size: 0.65rem;">
                  <i data-lucide="check" style="width: 10px; height: 10px; display: inline;"></i> In Canopy
                </span>
                <span class="lawpart-sec-tag">${p.target_court || p.target_date || ''}</span>
              </div>
              <div style="font-weight: 700; font-size: 0.8125rem; color: var(--text-primary); margin-bottom: 0.25rem; line-height: 1.35;">
                <a href="#/cases/${p.target_case_id}" class="case-link-hover">${displayTitle}</a>
              </div>
              ${displayCite ? `<div style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono);">${displayCite}</div>` : ''}
              ${jumpChipsHtml}
              <div style="display: flex; gap: 0.5rem; margin-top: 0.45rem;">
                <a href="#/cases/${p.target_case_id}" class="action-btn" style="font-size: 0.7rem; padding: 3px 8px; text-decoration: none;">
                  <i data-lucide="book-open" style="width: 12px; height: 12px;"></i> Open Precedent
                </a>
              </div>
            </div>
          `;
        }
      }

      if (externalPrecs.length > 0) {
        precHtml += `
          <div class="subheading-label" style="margin-top: 1rem;">
            External Authorities (${externalPrecs.length})
          </div>
        `;
        for (const p of externalPrecs) {
          const displayTitle = p.cited_case_title || p.cited_case_citation;
          const displayCite = p.cited_case_citation || '';
          const paras = p.paragraphs || [];

          let jumpChipsHtml = "";
          if (paras.length > 0) {
            jumpChipsHtml = `
              <div style="margin-top: 0.35rem; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                <span style="font-size: 0.6875rem; color: var(--text-muted); font-weight: 600;">Cited at:</span>
                ${paras.map(pn => `<button class="para-jump-chip" onclick="app.jumpToParagraph(${pn})" title="Jump to paragraph [${pn}] in judgment">[${pn}]</button>`).join('')}
              </div>
            `;
          }

          const searchQ = encodeURIComponent(displayCite || displayTitle);

          precHtml += `
            <div class="lawpart-card precedent-card">
              <div class="lawpart-card-header">
                <span class="badge-statute" style="background: var(--bg-hover); color: var(--text-muted); font-size: 0.65rem;">External Citation</span>
                ${p.paragraph_number ? `<span class="lawpart-sec-tag">Para [${p.paragraph_number}]</span>` : ''}
              </div>
              <div style="font-weight: 600; font-size: 0.78rem; color: var(--text-primary); margin-bottom: 0.25rem; line-height: 1.35;">
                ${displayTitle}
              </div>
              ${displayCite && displayCite !== displayTitle ? `<div style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono);">${displayCite}</div>` : ''}
              ${jumpChipsHtml}
              <div style="display: flex; gap: 0.4rem; margin-top: 0.45rem;">
                <a href="https://jade.io/search/${searchQ}" target="_blank" rel="noopener noreferrer" class="action-btn" style="font-size: 0.68rem; padding: 2px 7px; text-decoration: none;">
                  <i data-lucide="external-link" style="width: 11px; height: 11px;"></i> Jade
                </a>
                <a href="https://www.austlii.edu.au/cgi-bin/sinosrch.cgi?query=${searchQ}" target="_blank" rel="noopener noreferrer" class="action-btn" style="font-size: 0.68rem; padding: 2px 7px; text-decoration: none;">
                  <i data-lucide="external-link" style="width: 11px; height: 11px;"></i> AustLII
                </a>
              </div>
            </div>
          `;
        }
      }
    }

    // Build Panel 3: Legislation & Regulations Cited
    let statHtml = `
      <div class="case-intel-header">
        <div class="case-intel-title">
          <i data-lucide="book"></i>
          <span>Statutory Provisions Considered</span>
        </div>
        <p class="case-intel-desc">Specific statutory sections, rules, and regulations cited with direct links into acts.db and regs.db.</p>
      </div>
    `;

    if (matchedInsts.length > 0) {
      statHtml += `
        <div class="subheading-label">
          Governing Instruments (${matchedInsts.length})
        </div>
      `;
      for (const m of matchedInsts) {
        statHtml += `
          <div class="instrument-launch-card" onclick="app.navigateTo('${m.slug}', '')">
            <div style="display: flex; align-items: center; gap: 8px;">
              <i data-lucide="${m.category === 'regulation' ? 'file-text' : 'book'}" style="width: 14px; height: 14px; color: var(--border-active);"></i>
              <div>
                <div style="font-weight: 600; font-size: 0.78rem; color: var(--text-primary); line-height: 1.25;">${m.title}</div>
                <div style="font-size: 0.6875rem; color: var(--text-muted); text-transform: capitalize;">${m.category} • ${m.jurisdiction_id.toUpperCase()}</div>
              </div>
            </div>
            <i data-lucide="chevron-right" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
          </div>
        `;
      }
    }

    if (statuteProvs.length > 0) {
      statHtml += `
        <div class="subheading-label" style="margin-top: 0.85rem;">
          Specific Sections & Rules (${statuteProvs.length})
        </div>
      `;
      for (const sp of statuteProvs) {
        const paras = sp.paragraphs || [];
        let jumpChipsHtml = "";
        if (paras.length > 0) {
          jumpChipsHtml = `
            <div style="margin-top: 0.35rem; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
              <span style="font-size: 0.6875rem; color: var(--text-muted); font-weight: 600;">Cited at:</span>
              ${paras.map(pn => `<button class="para-jump-chip" onclick="app.jumpToParagraph(${pn})" title="Jump to paragraph [${pn}] in judgment">[${pn}]</button>`).join('')}
            </div>
          `;
        }

        statHtml += `
          <div class="lawpart-card statute-cite-card">
            <div class="lawpart-card-header">
              <span class="lawpart-code-chip" style="background: rgba(5, 150, 105, 0.12); color: #059669;">s ${sp.section}</span>
              <span class="lawpart-sec-tag">${sp.count} cite${sp.count > 1 ? 's' : ''}</span>
            </div>
            <div style="font-weight: 600; font-size: 0.78rem; color: var(--text-primary); line-height: 1.35; margin-bottom: 2px;">
              ${sp.act_title}
            </div>
            ${sp.heading ? `<div style="font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 0.25rem;"><em>${sp.heading}</em></div>` : ''}
            ${jumpChipsHtml}
            <div style="display: flex; gap: 0.5rem; margin-top: 0.45rem;">
              ${sp.is_ingested ? `
                <button class="action-btn" onclick="app.navigateTo('${sp.act_slug}', 's${sp.section}')" style="font-size: 0.7rem; padding: 3px 8px; cursor: pointer;">
                  <i data-lucide="book-open" style="width: 12px; height: 12px;"></i> View Section
                </button>
              ` : `
                <span class="badge-statute" style="background: var(--bg-hover); color: var(--text-muted); font-size: 0.6875rem;">External Statute</span>
              `}
            </div>
          </div>
        `;
      }
    } else if (matchedInsts.length === 0) {
      statHtml += `
        <div class="info-empty-state">
          <i data-lucide="book"></i>
          <p>No statutory provisions directly extracted for this decision.</p>
        </div>
      `;
    }

    // Build Panel 4: Notes & Practitioner Commentary (Rule 5.1 ordering & Tri-Tier Filters)
    const commHtml = this.renderCaseCommentaryPanel(caseData, commentaries, this.commentaryTierFilter || "all");

    // Assemble Body
    const bodyContainer = document.getElementById("info-pane-body");
    if (bodyContainer) {
      bodyContainer.innerHTML = `
        ${hasOpinions ? `
          <div class="info-tab-panel active" id="panel-case-opinions">
            ${opinionsHtml}
          </div>
        ` : ''}
        <div class="info-tab-panel ${!hasOpinions ? 'active' : ''}" id="panel-case-citing" ${hasOpinions ? 'style="display: none;"' : ''}>
          ${citingHtml}
        </div>
        <div class="info-tab-panel" id="panel-case-precedents" style="display: none;">
          ${precHtml}
        </div>
        <div class="info-tab-panel" id="panel-case-statutes" style="display: none;">
          ${statHtml}
        </div>
        <div class="info-tab-panel" id="panel-case-commentary" style="display: none;">
          ${commHtml}
        </div>
      `;
    }

    lucide.createIcons();

    // Auto-open info pane in Caselaw mode if not open
    if (this.elInfoPane && this.elInfoPane.style.display !== "flex") {
      this.toggleInfoPane();
    }
  }

  renderContinuousContainer(nodeData) {
    this.currentScope = { type: "node", data: nodeData };
    this.renderBreadcrumbs(nodeData.breadcrumbs, null, null);

    const node = nodeData.node;
    const provisions = nodeData.provisions || [];

    let provsHtml = "";
    if (provisions.length === 0) {
      provsHtml = `<div class="empty-state">No provisions directly contained in this structural heading. Use the left menu to explore subsections.</div>`;
    } else {
      for (const p of provisions) {
        const pSlug = p.full_slug || `s${p.identifier}`;
        const actSlug = this.currentAct;
        provsHtml += `
          <article class="provision-article continuous-item" id="prov-view-${p.id}">
            <div class="continuous-sec-bar">
              <span class="continuous-sec-tag">Section ${p.identifier}</span>
              <div class="continuous-sec-actions">
                <button class="action-btn" onclick="app.inspectProvision('${actSlug}', '${pSlug}')" title="Inspect penalties, caselaw & commentary for Section ${p.identifier}">
                  <i data-lucide="shield-alert" style="width: 12px; height: 12px;"></i>
                  <span>Section Intelligence</span>
                </button>
                <button class="action-btn" onclick="app.openCommentaryModal('provision', '${actSlug}:s${p.identifier}')" title="Add practitioner note to Section ${p.identifier}">
                  <i data-lucide="plus" style="width: 12px; height: 12px;"></i>
                  <span>Add Note</span>
                </button>
                <button class="action-btn" onclick="app.navigateTo('${actSlug}', '${pSlug}')" title="Open single section focused view">
                  <i data-lucide="maximize-2" style="width: 12px; height: 12px;"></i>
                  <span>Focus View</span>
                </button>
              </div>
            </div>
            ${p.content_html}
          </article>
        `;
      }
    }

    this.elReaderContainer.innerHTML = `
      <div class="reader-container-view">
        <div class="container-header">
          <div class="container-type">${(node.node_type || "Part").toUpperCase()}</div>
          <h1 class="container-title">${node.identifier ? `${node.identifier} — ` : ''}${node.title}</h1>
          <div class="container-meta">${provisions.length} continuous sections in this container</div>
        </div>
        <div class="provisions-stream">
          ${provsHtml}
        </div>
      </div>
    `;
    lucide.createIcons();

    if (this.elReaderFooter) {
      this.elReaderFooter.style.display = "none";
    }

    if (this.findBarOpen && this.elReaderFindInput && this.elReaderFindInput.value.trim()) {
      setTimeout(() => this.executeReaderFind(), 40);
    }
  }

  async inspectProvision(actSlug, fullSlug) {
    try {
      const res = await fetch(`/api/acts/${actSlug}/provisions/${fullSlug}`);
      if (res.ok) {
        const prov = await res.json();
        this._currentProvData = prov;
        this.renderInfoPaneData(prov);
        if (this.elInfoPane && this.elInfoPane.style.display !== "flex") {
          this.toggleInfoPane();
        }
        this.switchInfoTab("lawparts");
      }
    } catch (e) {
      console.error("Error inspecting provision:", e);
    }
  }

  renderBreadcrumbs(breadcrumbs, provIdentifier, provTitle) {
    if (!this.elBreadcrumbs) return;

    const actMeta = this.allStatutes.find(a => a.slug === this.currentAct);
    const actTitle = actMeta ? actMeta.short_title : this.currentAct;

    // Update Source Link button URL dynamically to point to the specific provision or heading
    const sourceLinkBtn = document.getElementById("source-link-btn");
    if (sourceLinkBtn) {
      let baseUrl = (actMeta && actMeta.source_url) ? actMeta.source_url : "https://www.legislation.gov.au";
      let targetUrl = baseUrl;

      if (provIdentifier) {
        const cleanId = provIdentifier.replace(/^s/i, "").trim();
        if (baseUrl.includes("legislation.qld.gov.au") || baseUrl.includes("legislation.nsw.gov.au")) {
          targetUrl = `${baseUrl}#sec.${cleanId}`;
        } else if (baseUrl.includes("legislation.gov.au")) {
          const textUrl = baseUrl.endsWith("/text") ? baseUrl : `${baseUrl}/text`;
          targetUrl = `${textUrl}#s${cleanId}`;
        }
      } else if (breadcrumbs && breadcrumbs.length > 0) {
        const lastBreadcrumb = breadcrumbs[breadcrumbs.length - 1];
        if (lastBreadcrumb && lastBreadcrumb.slug) {
          const nodeSlug = lastBreadcrumb.slug;
          if (baseUrl.includes("legislation.qld.gov.au") || baseUrl.includes("legislation.nsw.gov.au")) {
            const anchor = nodeSlug.replace(/^chapter-/, "ch.").replace(/^part-/, "pt.").replace(/^schedule-/, "sch.");
            targetUrl = `${baseUrl}#${anchor}`;
          }
        }
      }

      sourceLinkBtn.href = targetUrl;
    }

    let html = `<span class="crumb root" onclick="app.navigateTo('${this.currentAct}', '')">${actTitle}</span>`;

    if (breadcrumbs && breadcrumbs.length > 0) {
      for (let i = 0; i < breadcrumbs.length; i++) {
        const b = breadcrumbs[i];
        const isLast = (i === breadcrumbs.length - 1 && !provIdentifier);
        html += `<span class="crumb-separator">/</span>`;
        if (isLast) {
          html += `<span class="crumb active">${b.identifier || b.title}</span>`;
        } else {
          html += `<span class="crumb" onclick="app.navigateTo('${this.currentAct}', '${b.slug}')">${b.identifier || b.title}</span>`;
        }
      }
    }

    if (provIdentifier) {
      html += `<span class="crumb-separator">/</span>`;
      html += `<span class="crumb active">s ${provIdentifier}</span>`;
    }

    this.elBreadcrumbs.innerHTML = html;
  }

  highlightTreeNode(slug) {
    this.elTreeContainer.querySelectorAll(".node-row.active, .tree-provision-item.active").forEach(el => {
      el.classList.remove("active");
    });

    const clean = slug.replace(/^s(?=\d)/, "");
    const matchingProv = this.elTreeContainer.querySelector(
      `.tree-provision-item[data-slug="${slug}"], .tree-provision-item[data-slug$="/${slug}"], .tree-provision-item[data-slug$="/s${clean}"]`
    );
    if (matchingProv) {
      matchingProv.classList.add("active");
      let parent = matchingProv.parentElement;
      while (parent && parent !== this.elTreeContainer) {
        if (parent.classList.contains("tree-node")) {
          this.toggleNode(parent, true);
        }
        parent = parent.parentElement;
      }
      matchingProv.scrollIntoView({ block: "nearest" });
      return;
    }

    const matchingNode = this.elTreeContainer.querySelector(
      `.tree-node[data-slug="${slug}"], .tree-node[data-slug$="/${slug}"]`
    );
    if (matchingNode) {
      const row = matchingNode.querySelector(":scope > .node-row");
      if (row) row.classList.add("active");
      let parent = matchingNode.parentElement;
      while (parent && parent !== this.elTreeContainer) {
        if (parent.classList.contains("tree-node")) {
          this.toggleNode(parent, true);
        }
        parent = parent.parentElement;
      }
      this.toggleNode(matchingNode, true);
      matchingNode.scrollIntoView({ block: "nearest" });
    }
  }

  updateFooterNav(currentProvId) {
    if (!this.elReaderFooter) return;

    const currIdx = this.flatProvisionsList.findIndex(p => p.id === currentProvId);
    if (currIdx === -1) {
      this.elReaderFooter.style.display = "none";
      return;
    }

    this.elReaderFooter.style.display = "flex";

    // Prev
    if (currIdx > 0) {
      const prevProv = this.flatProvisionsList[currIdx - 1];
      this.elPrevProvBtn.style.visibility = "visible";
      this.elPrevProvLabel.textContent = prevProv.identifier;
      this.elPrevProvBtn.dataset.slug = prevProv.full_slug;
    } else {
      this.elPrevProvBtn.style.visibility = "hidden";
    }

    // Next
    if (currIdx < this.flatProvisionsList.length - 1) {
      const nextProv = this.flatProvisionsList[currIdx + 1];
      this.elNextProvBtn.style.visibility = "visible";
      this.elNextProvLabel.textContent = nextProv.identifier;
      this.elNextProvBtn.dataset.slug = nextProv.full_slug;
    } else {
      this.elNextProvBtn.style.visibility = "hidden";
    }
  }

  navigateSibling(direction) {
    const btn = (direction === -1) ? this.elPrevProvBtn : this.elNextProvBtn;
    const slug = btn.dataset.slug;
    if (slug) {
      this.navigateTo(this.currentAct, slug);
    }
  }

  // Dedicated Unified Search Page & Engine
  openSearchModal() {
    // Legacy bridge: redirect to dedicated search page
    window.location.hash = "#/search";
  }

  closeSearchModal() {
    if (this.elSearchModal) this.elSearchModal.style.display = "none";
  }

  async renderSearchLandingPage(query = "", scope = "all", options = {}) {
    this.closeInfoPane();
    if (this.elReaderFooter) this.elReaderFooter.style.display = "none";

    // Set Breadcrumbs
    if (this.elBreadcrumbs) {
      this.elBreadcrumbs.innerHTML = `
        <a href="#/" class="crumb root" style="text-decoration: none;"><i data-lucide="tree-pine"></i> Canopy Legal</a>
        <span class="crumb-separator">/</span>
        <span class="crumb active"><i data-lucide="search" style="width: 13px; height: 13px; vertical-align: middle;"></i> Search</span>
        ${query ? `<span class="crumb-separator">/</span><span class="crumb active" style="font-weight: 700;">"${this.escapeHtml(query)}"</span>` : ''}
      `;
    }

    // Sync Header Search Cluster
    if (this.elOmniboxInput) {
      this.elOmniboxInput.value = query;
      if (this.elOmniboxClearBtn) {
        this.elOmniboxClearBtn.style.display = query ? "inline-flex" : "none";
      }
    }
    if (this.elSearchScopeSelect) {
      this.elSearchScopeSelect.value = scope || "all";
    }

    // Save state
    this.currentSearchQuery = query;
    this.currentSearchScope = scope || "all";
    if (options.court !== undefined) this.currentSearchFilters.court = options.court;
    if (options.yearFrom !== undefined) this.currentSearchFilters.yearFrom = options.yearFrom;
    if (options.yearTo !== undefined) this.currentSearchFilters.yearTo = options.yearTo;
    if (options.matchMode !== undefined) this.currentSearchFilters.matchMode = options.matchMode;

    const trimmed = query.trim();

    // If query is empty, show clean search landing page with prompt chips
    if (!trimmed) {
      this.currentSearchData = null;
      this.renderSearchPageContent();
      return;
    }

    // Show loading state
    this.elReaderContainer.innerHTML = `
      <div class="search-page-canvas">
        <div class="search-page-header">
          <div class="search-page-title-row">
            <h1 class="search-page-title"><i data-lucide="search"></i> Canopy Unified Search</h1>
            <span class="search-status-chip">Searching database...</span>
          </div>
          <p style="font-size: 0.875rem; color: var(--text-muted); margin: 0;">Comprehensive full-text statutory and judicial decision discovery</p>
        </div>
        <div class="loading-spinner" style="padding: 4rem 1rem; text-align: center;">
          <i data-lucide="loader-2" class="spin" style="width: 28px; height: 28px; color: var(--border-active);"></i>
          <span style="display: block; margin-top: 10px; font-weight: 500;">Searching Caselaw decisions, statutory sections, and penalty lawparts...</span>
        </div>
      </div>
    `;
    lucide.createIcons();

    try {
      const params = new URLSearchParams({
        q: trimmed,
        scope: this.currentSearchScope,
        match_mode: this.currentSearchFilters.matchMode || "all",
        limit: "60"
      });
      if (this.currentSearchFilters.court) params.set("court", this.currentSearchFilters.court);
      if (this.currentSearchFilters.yearFrom) params.set("year_from", this.currentSearchFilters.yearFrom);
      if (this.currentSearchFilters.yearTo) params.set("year_to", this.currentSearchFilters.yearTo);

      const res = await fetch(`/api/search/unified?${params.toString()}`);
      if (!res.ok) throw new Error("Search network error");
      const data = await res.json();
      this.currentSearchData = data;
      this.renderSearchPageContent();
    } catch (e) {
      console.error("Unified search failed:", e);
      this.elReaderContainer.innerHTML = `
        <div class="search-page-canvas">
          <div class="search-page-header">
            <h1 class="search-page-title"><i data-lucide="alert-circle" style="color: #DC2626;"></i> Search Error</h1>
            <p style="color: var(--text-muted);">Failed to retrieve search results. Please check your query and try again.</p>
          </div>
        </div>
      `;
      lucide.createIcons();
    }
  }

  renderSearchPageContent() {
    const data = this.currentSearchData;
    const query = this.currentSearchQuery || "";
    const counts = data ? data.counts : { all: 0, cases: 0, provisions: 0, lawparts: 0, statutes: 0 };
    const totalCount = data ? data.total_count : 0;
    const timeMs = data ? data.time_ms : 0;

    let html = `
      <div class="search-page-canvas">
        <!-- Header -->
        <div class="search-page-header">
          <div class="search-page-title-row">
            <h1 class="search-page-title">
              <i data-lucide="search" style="color: var(--border-active);"></i> Canopy Unified Search
            </h1>
            ${data ? `<span class="search-status-chip">Found ${totalCount} results in ${timeMs}ms</span>` : ''}
          </div>
          <p style="font-size: 0.875rem; color: var(--text-muted); margin: 0;">
            Search NSW & Commonwealth Acts, Regulations, Judicial Decisions, and Penalty Codes.
          </p>
        </div>

        <!-- Hero Search Box on Page Canvas -->
        <div class="search-hero-box">
          <div class="search-hero-input-row">
            <div class="search-hero-input-wrap">
              <i data-lucide="search"></i>
              <input 
                type="search" 
                id="search-page-input" 
                class="search-hero-input" 
                placeholder="Search case names, legal principles, sections, offences... e.g. Lakeman" 
                value="${this.escapeHtml(query)}"
                autocomplete="off"
                spellcheck="false"
              />
            </div>

            <select id="search-page-scope" class="search-hero-scope" title="Filter by jurisdiction and source">
              <option value="all" ${this.currentSearchScope === 'all' ? 'selected' : ''}>All Sources</option>
              <option value="caselaw" ${this.currentSearchScope === 'caselaw' ? 'selected' : ''}>All Caselaw</option>
              <option value="legislation" ${this.currentSearchScope === 'legislation' ? 'selected' : ''}>All Legislation</option>
              <option value="nsw-acts" ${this.currentSearchScope === 'nsw-acts' ? 'selected' : ''}>NSW Acts</option>
              <option value="nsw-regs" ${this.currentSearchScope === 'nsw-regs' ? 'selected' : ''}>NSW Regulations</option>
              <option value="nsw-caselaw" ${this.currentSearchScope === 'nsw-caselaw' ? 'selected' : ''}>NSW Decisions</option>
              <option value="cth-acts" ${this.currentSearchScope === 'cth-acts' ? 'selected' : ''}>Cth Acts</option>
              <option value="cth-regs" ${this.currentSearchScope === 'cth-regs' ? 'selected' : ''}>Cth Regulations</option>
            </select>

            <button class="btn btn-primary" onclick="app.submitPageSearch()" title="Execute search">
              <i data-lucide="search" style="width: 14px; height: 14px;"></i> Search
            </button>

            <button class="btn btn-secondary" onclick="app.toggleAdvancedSearch()" title="Expand or collapse advanced filters" id="adv-filter-toggle-btn">
              <i data-lucide="sliders" style="width: 14px; height: 14px;"></i> Advanced ${this.searchAdvancedExpanded ? '▲' : '▼'}
            </button>
          </div>

          <!-- Advanced Filters Drawer -->
          <div id="search-advanced-panel" class="search-advanced-panel" style="display: ${this.searchAdvancedExpanded ? 'grid' : 'none'};">
            <div>
              <label style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 4px;">Court / Tribunal</label>
              <select id="adv-court-select" class="search-hero-scope" style="width: 100%;">
                <option value="" ${!this.currentSearchFilters.court ? 'selected' : ''}>All Courts & Tribunals</option>
                <option value="NSWCA" ${this.currentSearchFilters.court === 'NSWCA' ? 'selected' : ''}>NSW Court of Appeal (NSWCA)</option>
                <option value="NSWSC" ${this.currentSearchFilters.court === 'NSWSC' ? 'selected' : ''}>NSW Supreme Court (NSWSC)</option>
                <option value="NSWDC" ${this.currentSearchFilters.court === 'NSWDC' ? 'selected' : ''}>NSW District Court (NSWDC)</option>
                <option value="NSWCAT" ${this.currentSearchFilters.court === 'NSWCAT' ? 'selected' : ''}>NSWCAT / NSWADT</option>
                <option value="HCA" ${this.currentSearchFilters.court === 'HCA' ? 'selected' : ''}>High Court of Australia (HCA)</option>
              </select>
            </div>

            <div>
              <label style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 4px;">Year Range</label>
              <div style="display: flex; gap: 6px; align-items: center;">
                <input type="number" id="adv-year-from" class="search-hero-input" style="padding: 8px;" placeholder="From (e.g. 1995)" value="${this.escapeHtml(this.currentSearchFilters.yearFrom)}" min="1900" max="2030" />
                <span style="color: var(--text-muted); font-size: 0.8rem;">to</span>
                <input type="number" id="adv-year-to" class="search-hero-input" style="padding: 8px;" placeholder="To (e.g. 2026)" value="${this.escapeHtml(this.currentSearchFilters.yearTo)}" min="1900" max="2030" />
              </div>
            </div>

            <div>
              <label style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); display: block; margin-bottom: 4px;">Match Precision</label>
              <select id="adv-match-mode" class="search-hero-scope" style="width: 100%;">
                <option value="all" ${this.currentSearchFilters.matchMode === 'all' ? 'selected' : ''}>All Terms (FTS5 BM25 Ranked)</option>
                <option value="exact" ${this.currentSearchFilters.matchMode === 'exact' ? 'selected' : ''}>Exact Phrase Match</option>
                <option value="title" ${this.currentSearchFilters.matchMode === 'title' ? 'selected' : ''}>Title / Heading / Catchwords Only</option>
              </select>
            </div>

            <div style="display: flex; gap: 8px; align-items: flex-end;">
              <button class="btn btn-primary" onclick="app.applyAdvancedSearch()" style="flex: 1;">Apply Filters</button>
              <button class="btn btn-secondary" onclick="app.resetAdvancedSearch()">Reset</button>
            </div>
          </div>
        </div>
    `;

    // If no query entered yet, show helpful suggestions
    if (!query.trim()) {
      html += `
        <div style="background: var(--bg-surface); border: 1px dashed var(--border-medium); border-radius: 8px; padding: 2.5rem 1.5rem; text-align: center; margin-top: 1rem;">
          <i data-lucide="compass" style="width: 36px; height: 36px; color: var(--border-active); margin-bottom: 1rem;"></i>
          <h3 style="font-size: 1.15rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--text-primary);">Explore Precedents, Provisions & Lawparts</h3>
          <p style="color: var(--text-muted); max-width: 580px; margin: 0 auto 1.5rem; font-size: 0.875rem;">
            Type any search term above or try one of these common inquiries to explore full-text judgment search:
          </p>
          <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
            <button class="quick-chip" onclick="app.setPageSearchTerm('Lakeman')"><i data-lucide="gavel" style="width: 12px; height: 12px;"></i> Lakeman</button>
            <button class="quick-chip" onclick="app.setPageSearchTerm('fit and proper person')"><i data-lucide="scale" style="width: 12px; height: 12px;"></i> fit and proper person</button>
            <button class="quick-chip" onclick="app.setPageSearchTerm('s 53')"><i data-lucide="file-text" style="width: 12px; height: 12px;"></i> s 53</button>
            <button class="quick-chip" onclick="app.setPageSearchTerm('PCA offences')"><i data-lucide="alert-triangle" style="width: 12px; height: 12px;"></i> PCA offences</button>
            <button class="quick-chip" onclick="app.setPageSearchTerm('drive whilst suspended')"><i data-lucide="car" style="width: 12px; height: 12px;"></i> drive whilst suspended</button>
            <button class="quick-chip" onclick="app.setPageSearchTerm('rule 20')"><i data-lucide="compass" style="width: 12px; height: 12px;"></i> rule 20</button>
          </div>
        </div>
      </div>
      `;
      this.elReaderContainer.innerHTML = html;
      lucide.createIcons();
      this.attachPageInputListeners();
      return;
    }

    // Facet Tabs Bar
    const activeTab = this.activeSearchTab || "all";
    html += `
      <div class="search-facet-bar">
        <button class="search-facet-tab ${activeTab === 'all' ? 'active' : ''}" onclick="app.setSearchTab('all')">
          <i data-lucide="layers" style="width: 14px; height: 14px;"></i> All Results
          <span class="search-facet-count">${counts.all || 0}</span>
        </button>
        <button class="search-facet-tab ${activeTab === 'cases' ? 'active' : ''}" onclick="app.setSearchTab('cases')">
          <i data-lucide="gavel" style="width: 14px; height: 14px;"></i> Judicial Decisions
          <span class="search-facet-count">${counts.cases || 0}</span>
        </button>
        <button class="search-facet-tab ${activeTab === 'provisions' ? 'active' : ''}" onclick="app.setSearchTab('provisions')">
          <i data-lucide="file-text" style="width: 14px; height: 14px;"></i> Statutory Provisions
          <span class="search-facet-count">${counts.provisions || 0}</span>
        </button>
        <button class="search-facet-tab ${activeTab === 'lawparts' ? 'active' : ''}" onclick="app.setSearchTab('lawparts')">
          <i data-lucide="scale" style="width: 14px; height: 14px;"></i> Offences & Lawparts
          <span class="search-facet-count">${counts.lawparts || 0}</span>
        </button>
        <button class="search-facet-tab ${activeTab === 'statutes' ? 'active' : ''}" onclick="app.setSearchTab('statutes')">
          <i data-lucide="landmark" style="width: 14px; height: 14px;"></i> Statutes & Regs
          <span class="search-facet-count">${counts.statutes || 0}</span>
        </button>
      </div>

      <div id="search-cards-container">
        ${this.buildSearchResultsHtml(data, activeTab)}
      </div>
    </div>
    `;

    this.elReaderContainer.innerHTML = html;
    lucide.createIcons();
    this.attachPageInputListeners();
  }

  attachPageInputListeners() {
    const input = document.getElementById("search-page-input");
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submitPageSearch();
        }
      });
    }
  }

  submitPageSearch() {
    const input = document.getElementById("search-page-input");
    const scopeSelect = document.getElementById("search-page-scope");
    const q = input ? input.value.trim() : "";
    const scope = scopeSelect ? scopeSelect.value : "all";

    if (this.elOmniboxInput) this.elOmniboxInput.value = q;
    if (this.elSearchScopeSelect) this.elSearchScopeSelect.value = scope;

    const hash = `#/search?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}`;
    window.location.hash = hash;
    this.renderSearchLandingPage(q, scope);
  }

  setPageSearchTerm(term) {
    const input = document.getElementById("search-page-input");
    if (input) input.value = term;
    if (this.elOmniboxInput) this.elOmniboxInput.value = term;
    this.submitPageSearch();
  }

  setSearchTab(tabKey) {
    this.activeSearchTab = tabKey;
    document.querySelectorAll(".search-facet-tab").forEach(tab => {
      tab.classList.remove("active");
    });
    event?.currentTarget?.classList.add("active");

    const container = document.getElementById("search-cards-container");
    if (container && this.currentSearchData) {
      container.innerHTML = this.buildSearchResultsHtml(this.currentSearchData, tabKey);
      lucide.createIcons();
    }
  }

  toggleAdvancedSearch() {
    this.searchAdvancedExpanded = !this.searchAdvancedExpanded;
    const panel = document.getElementById("search-advanced-panel");
    const btn = document.getElementById("adv-filter-toggle-btn");
    if (panel) {
      panel.style.display = this.searchAdvancedExpanded ? "grid" : "none";
    }
    if (btn) {
      btn.innerHTML = `<i data-lucide="sliders" style="width: 14px; height: 14px;"></i> Advanced ${this.searchAdvancedExpanded ? '▲' : '▼'}`;
      lucide.createIcons();
    }
  }

  applyAdvancedSearch() {
    const court = document.getElementById("adv-court-select")?.value || "";
    const yearFrom = document.getElementById("adv-year-from")?.value || "";
    const yearTo = document.getElementById("adv-year-to")?.value || "";
    const matchMode = document.getElementById("adv-match-mode")?.value || "all";

    this.currentSearchFilters = { court, yearFrom, yearTo, matchMode };
    const input = document.getElementById("search-page-input");
    const q = input ? input.value.trim() : this.currentSearchQuery;
    const scope = document.getElementById("search-page-scope")?.value || this.currentSearchScope;

    this.renderSearchLandingPage(q, scope, this.currentSearchFilters);
  }

  resetAdvancedSearch() {
    this.currentSearchFilters = { court: "", yearFrom: "", yearTo: "", matchMode: "all" };
    const courtEl = document.getElementById("adv-court-select");
    const yFromEl = document.getElementById("adv-year-from");
    const yToEl = document.getElementById("adv-year-to");
    const modeEl = document.getElementById("adv-match-mode");
    if (courtEl) courtEl.value = "";
    if (yFromEl) yFromEl.value = "";
    if (yToEl) yToEl.value = "";
    if (modeEl) modeEl.value = "all";

    const input = document.getElementById("search-page-input");
    const q = input ? input.value.trim() : this.currentSearchQuery;
    const scope = document.getElementById("search-page-scope")?.value || this.currentSearchScope;

    this.renderSearchLandingPage(q, scope, this.currentSearchFilters);
  }

  buildSearchResultsHtml(data, activeTab) {
    if (!data || data.total_count === 0) {
      return `
        <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 3rem 1.5rem; text-align: center;">
          <i data-lucide="search-x" style="width: 36px; height: 36px; color: var(--text-muted); margin-bottom: 0.75rem;"></i>
          <h3 style="font-size: 1.1rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--text-primary);">
            No matches found for "${this.escapeHtml(data.query)}"
          </h3>
          <p style="color: var(--text-muted); font-size: 0.875rem; max-width: 520px; margin: 0 auto 1rem;">
            No items matched your current search and filters. Try broadening your scope to "All Sources", removing court or year restrictions, or checking your spelling.
          </p>
          <button class="btn btn-secondary" onclick="app.resetAdvancedSearch()">Clear All Advanced Filters</button>
        </div>
      `;
    }

    let html = "";
    const showAll = (activeTab === "all");

    // 1. JUDICIAL DECISIONS
    if ((showAll || activeTab === "cases") && data.cases && data.cases.length > 0) {
      html += `
        <section class="search-results-section">
          <div class="search-section-header">
            <h2 class="search-section-title"><i data-lucide="gavel" style="color: #2563EB;"></i> Judicial Decisions (${data.cases.length})</h2>
            ${showAll && data.cases.length > 5 ? `<button class="btn-sm btn-secondary" onclick="app.setSearchTab('cases')">View all decisions (${data.counts.cases})</button>` : ''}
          </div>
          <div class="search-card-list">
            ${(showAll ? data.cases.slice(0, 10) : data.cases).map(c => this.buildCaseSearchCard(c)).join("")}
          </div>
        </section>
      `;
    }

    // 2. STATUTORY PROVISIONS
    if ((showAll || activeTab === "provisions") && data.provisions && data.provisions.length > 0) {
      html += `
        <section class="search-results-section">
          <div class="search-section-header">
            <h2 class="search-section-title"><i data-lucide="file-text" style="color: var(--border-active);"></i> Statutory Provisions (${data.provisions.length})</h2>
            ${showAll && data.provisions.length > 5 ? `<button class="btn-sm btn-secondary" onclick="app.setSearchTab('provisions')">View all provisions (${data.counts.provisions})</button>` : ''}
          </div>
          <div class="search-card-list">
            ${(showAll ? data.provisions.slice(0, 10) : data.provisions).map(p => this.buildProvisionSearchCard(p)).join("")}
          </div>
        </section>
      `;
    }

    // 3. OFFENCES & LAWPARTS
    if ((showAll || activeTab === "lawparts") && data.lawparts && data.lawparts.length > 0) {
      html += `
        <section class="search-results-section">
          <div class="search-section-header">
            <h2 class="search-section-title"><i data-lucide="scale" style="color: #059669;"></i> Offences & Lawparts (${data.lawparts.length})</h2>
            ${showAll && data.lawparts.length > 5 ? `<button class="btn-sm btn-secondary" onclick="app.setSearchTab('lawparts')">View all offences (${data.counts.lawparts})</button>` : ''}
          </div>
          <div class="search-card-list">
            ${(showAll ? data.lawparts.slice(0, 8) : data.lawparts).map(lp => this.buildLawpartSearchCard(lp)).join("")}
          </div>
        </section>
      `;
    }

    // 4. STATUTES & REGULATIONS
    if ((showAll || activeTab === "statutes") && data.statutes && data.statutes.length > 0) {
      html += `
        <section class="search-results-section">
          <div class="search-section-header">
            <h2 class="search-section-title"><i data-lucide="landmark" style="color: #6366F1;"></i> Statutes & Regulations (${data.statutes.length})</h2>
          </div>
          <div class="search-card-list">
            ${data.statutes.map(s => this.buildStatuteSearchCard(s)).join("")}
          </div>
        </section>
      `;
    }

    if (!html) {
      html = `
        <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 2.5rem 1.5rem; text-align: center;">
          <p style="color: var(--text-muted); font-size: 0.9rem;">No results found under the <strong>${this.escapeHtml(activeTab)}</strong> category for this query.</p>
          <button class="btn btn-secondary" style="margin-top: 0.5rem;" onclick="app.setSearchTab('all')">Show All Categories (${data.total_count})</button>
        </div>
      `;
    }

    return html;
  }

  buildCaseSearchCard(c) {
    const hasHighlightPara = Boolean(c.highlight_para);
    const caseUrl = `#/cases/${encodeURIComponent(c.id)}`;
    const jumpUrl = hasHighlightPara ? `#/cases/${encodeURIComponent(c.id)}#p${c.highlight_para}` : caseUrl;

    return `
      <div class="search-result-card">
        <div class="search-card-header">
          <a href="${jumpUrl}" class="search-card-title">
            ${this.escapeHtml(c.title)}
          </a>
          ${c.mnc ? `<span class="search-status-chip">${this.escapeHtml(c.mnc)}</span>` : ''}
        </div>

        <div class="search-card-meta">
          <span><i data-lucide="scale" style="width: 13px; height: 13px; vertical-align: middle;"></i> ${this.escapeHtml(c.court || 'Court')}</span>
          <span>•</span>
          <span><i data-lucide="calendar" style="width: 13px; height: 13px; vertical-align: middle;"></i> Year ${this.escapeHtml(c.year || 'N/A')}</span>
          ${hasHighlightPara ? `
            <span class="search-match-tag">
              <i data-lucide="file-text" style="width: 11px; height: 11px;"></i> Paragraph [${c.highlight_para}] Full-Text Match
            </span>
          ` : `
            <span class="search-match-tag tag-title">
              <i data-lucide="check" style="width: 11px; height: 11px;"></i> Case Title / Citation Match
            </span>
          `}
        </div>

        ${c.catchwords ? `
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.5rem; font-style: italic;">
            ${this.escapeHtml(c.catchwords)}
          </div>
        ` : ''}

        ${c.snippet ? `
          <div class="search-snippet">${c.snippet}</div>
        ` : ''}

        <div class="search-card-actions">
          <a href="${caseUrl}" class="btn-sm btn-primary" style="text-decoration: none;">
            <i data-lucide="book-open" style="width: 13px; height: 13px;"></i> Read Full Decision in Canopy
          </a>
          ${hasHighlightPara ? `
            <a href="${jumpUrl}" class="btn-sm btn-secondary" style="text-decoration: none;">
              <i data-lucide="corner-down-right" style="width: 13px; height: 13px;"></i> Jump to Para [${c.highlight_para}]
            </a>
          ` : ''}
          ${(() => {
            // Prioritize authentic web URLs over local file paths
            let rawUrl = (c.source_url && c.source_url.startsWith('http')) ? c.source_url : (c.nsw_caselaw_url || c.austlii_url || c.source_url);
            if (!rawUrl) return '';
            const pInfo = this.resolveSourceProvider(rawUrl);
            const sourceLabel = pInfo ? (pInfo.label.toLowerCase().includes('source') ? pInfo.label : `${pInfo.label} Source`) : 'External Source';
            let sHtml = `
              <a href="${rawUrl}" target="_blank" rel="noopener noreferrer" class="btn-sm btn-secondary" style="text-decoration: none;" title="Open original judgment on ${pInfo ? pInfo.label : 'source'}">
                <i data-lucide="${pInfo ? pInfo.icon : 'external-link'}" style="width: 13px; height: 13px;"></i> ${sourceLabel}
              </a>
            `;
            if (c.austlii_url && !rawUrl.includes('austlii.edu.au')) {
              sHtml += `
                <a href="${c.austlii_url}" target="_blank" rel="noopener noreferrer" class="btn-sm btn-secondary" style="text-decoration: none;" title="View on AustLII">
                  <i data-lucide="external-link" style="width: 13px; height: 13px;"></i> AustLII
                </a>
              `;
            }
            if (c.jade_url && !rawUrl.includes('jade.io')) {
              sHtml += `
                <a href="${c.jade_url}" target="_blank" rel="noopener noreferrer" class="btn-sm btn-secondary" style="text-decoration: none;" title="View on BarNet Jade">
                  <i data-lucide="external-link" style="width: 13px; height: 13px;"></i> BarNet Jade
                </a>
              `;
            }
            return sHtml;
          })()}
        </div>
      </div>
    `;
  }

  buildProvisionSearchCard(p) {
    const actBadge = (p.act_title || (p.act_slug || "").split("-").map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : "").join(" "));
    const targetUrl = `#/${encodeURIComponent(p.act_slug)}/${p.full_slug}`;
    return `
      <div class="search-result-card">
        <div class="search-card-header">
          <a href="${targetUrl}" class="search-card-title">
            s ${this.escapeHtml(p.identifier)} — ${this.escapeHtml(p.title || p.heading || '')}
          </a>
          <span class="badge-statute badge-act">${this.escapeHtml(actBadge)}</span>
        </div>

        <div class="search-card-meta">
          <span><i data-lucide="folder-tree" style="width: 13px; height: 13px; vertical-align: middle;"></i> ${this.escapeHtml(p.full_slug)}</span>
        </div>

        ${p.snippet ? `<div class="search-snippet">${p.snippet}</div>` : ''}

        <div class="search-card-actions">
          <a href="${targetUrl}" class="btn-sm btn-primary" style="text-decoration: none;">
            <i data-lucide="file-text" style="width: 13px; height: 13px;"></i> Open Provision in Workspace
          </a>
        </div>
      </div>
    `;
  }

  buildLawpartSearchCard(lp) {
    const code = String(lp.lawpart_code || "");
    const statute = lp.act_name || lp.statute_name || "";
    const sec = lp.section || lp.section_number || "";
    const desc = lp.variant_description || lp.description || lp.offence_description || "Offence description not specified";
    const citation = statute ? `${statute} s ${sec}` : (sec ? `s ${sec}` : "");

    // Categories tags
    let catChips = "";
    if (lp.categories && Array.isArray(lp.categories) && lp.categories.length > 0) {
      catChips = `
        <div class="lawpart-cats-wrap" style="margin-bottom: 0.35rem;">
          ${lp.categories.map(c => `<span class="lawpart-cat-chip">${this.escapeHtml(c)}</span>`).join('')}
        </div>
      `;
    }

    // Semantic Penalty Pills using shared generator
    const pills = this.buildLawpartPills(lp);

    // JudCom Link button
    let judComBtn = "";
    if (lp.lawcodes_url) {
      judComBtn = `
        <a href="${lp.lawcodes_url}" target="_blank" rel="noopener noreferrer" class="btn-sm btn-secondary" style="text-decoration: none;" title="Open official Judicial Commission Lawcodes record #${code}">
          <i data-lucide="external-link" style="width: 13px; height: 13px;"></i> JudCom Record
        </a>
      `;
    }

    return `
      <div class="search-result-card lawpart-search-card">
        <div class="search-card-header" style="align-items: flex-start;">
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1;">
            <button class="lawpart-code-badge" onclick="navigator.clipboard.writeText('${code}'); this.classList.add('copied'); setTimeout(() => this.classList.remove('copied'), 1500);" title="Click to copy Lawcode #${code}">
              <i data-lucide="hash"></i>
              <span>${code}</span>
            </button>
            ${citation ? `<span class="lawpart-sec-pill">${this.escapeHtml(citation)}</span>` : ''}
            <span class="search-card-title" style="margin-left: 2px;">${this.escapeHtml(desc)}</span>
          </div>
        </div>

        ${catChips}

        ${pills.length > 0 ? `
          <div class="lawpart-pills-grid" style="margin: 0.65rem 0 0.45rem 0;">
            ${pills.join('')}
          </div>
        ` : ''}

        <div class="search-card-actions" style="margin-top: 0.75rem;">
          <button class="btn-sm btn-primary" onclick="app.selectLawpartFlyout('${code}', '${this.escapeHtml(statute)}', '${this.escapeHtml(sec)}')">
            <i data-lucide="book-open" style="width: 13px; height: 13px;"></i> View Governing Statutory Section
          </button>
          ${judComBtn}
        </div>
      </div>
    `;
  }

  buildStatuteSearchCard(s) {
    const isAct = (s.category || "act").toLowerCase() === "act";
    const title = s.short_title || s.title || (s.slug ? s.slug.split("-").map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : "").join(" ") : "Statute");
    const rawJ = (s.jurisdiction_id || s.jurisdiction || (s.slug && s.slug.includes("nsw") ? "nsw" : "cth")).toLowerCase();
    const jurisdictionLabel = rawJ === "nsw" ? "New South Wales" : (rawJ === "cth" ? "Commonwealth" : (rawJ === "national" ? "National Scheme" : rawJ.toUpperCase()));
    const provCount = s.provision_count ? `${s.provision_count.toLocaleString()} Provisions` : "";
    const actNum = s.act_number && s.year ? `No. ${s.act_number} of ${s.year}` : (s.year ? `Year ${s.year}` : "");
    const targetUrl = `#/${encodeURIComponent(s.slug)}`;

    return `
      <div class="search-result-card">
        <div class="search-card-header">
          <a href="${targetUrl}" class="search-card-title">
            ${this.escapeHtml(title)}
          </a>
          <span class="badge-statute ${isAct ? 'badge-act' : 'badge-reg'}">${isAct ? 'Act' : 'Regulation'}</span>
        </div>

        <div class="search-card-meta">
          <span><i data-lucide="landmark" style="width: 13px; height: 13px; vertical-align: middle;"></i> Jurisdiction: ${this.escapeHtml(jurisdictionLabel)}</span>
          ${provCount ? `<span>•</span><span><i data-lucide="folder-tree" style="width: 13px; height: 13px; vertical-align: middle;"></i> ${provCount}</span>` : ''}
          ${actNum ? `<span>•</span><span><i data-lucide="calendar" style="width: 13px; height: 13px; vertical-align: middle;"></i> ${this.escapeHtml(actNum)}</span>` : ''}
        </div>

        <div class="search-card-actions">
          <a href="${targetUrl}" class="btn-sm btn-primary" style="text-decoration: none;">
            <i data-lucide="book-open" style="width: 13px; height: 13px;"></i> Browse Table of Contents
          </a>
          <a href="#/browse/legislation" class="btn-sm btn-secondary" style="text-decoration: none;">
            <i data-lucide="list" style="width: 13px; height: 13px;"></i> View in Legislation Directory
          </a>
        </div>
      </div>
    `;
  }

  copyCurrentLink() {
    navigator.clipboard.writeText(window.location.href);
    const btn = document.getElementById("copy-link-btn");
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i data-lucide="check"></i><span>Copied!</span>`;
    lucide.createIcons();
    setTimeout(() => {
      btn.innerHTML = originalText;
      lucide.createIcons();
    }, 2000);
  }

  initResizer() {
    const handle = document.getElementById("resize-handle");
    const sidebar = this.elTreeContainer.parentElement;
    let isResizing = false;

    handle.addEventListener("mousedown", (e) => {
      isResizing = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    window.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const newWidth = Math.max(220, Math.min(600, e.clientX));
      document.documentElement.style.setProperty("--sidebar-width", `${newWidth}px`);
    });

    window.addEventListener("mouseup", () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    });
  }

  // --- COMMENTARY & LINKING ENGINE METHODS ---

  renderCaseCommentaryPanel(caseData, commentaries, activeTier = "all") {
    const all = commentaries || [];
    const modCount = all.filter(c => (c.author_tier || c.tier) === "moderator" || (c.author_tier || c.tier) === "tier1_judge").length;
    const pracCount = all.filter(c => (c.author_tier || c.tier) === "practitioner" || !c.author_tier || (c.author_tier || c.tier) === "tier2_editorial" || (c.author_tier || c.tier) === "tier3_user").length;
    const aiCount = all.filter(c => (c.author_tier || c.tier) === "ai" || (c.author_tier || c.tier) === "ai_notation").length;

    let filtered = all;
    if (activeTier && activeTier !== "all") {
      filtered = all.filter(c => {
        const t = c.author_tier || c.tier || "practitioner";
        if (activeTier === "moderator") return t === "moderator" || t === "tier1_judge";
        if (activeTier === "practitioner") return t === "practitioner" || t === "tier2_editorial" || t === "tier3_user";
        if (activeTier === "ai") return t === "ai" || t === "ai_notation";
        return true;
      });
    }

    // Rule 5.1 Ordering: Case-level commentary first, Paragraph-level commentary second (sorted by target_paragraph_start ASC)
    const caseLevel = filtered.filter(c => !c.target_paragraph_start);
    const paraLevel = filtered.filter(c => c.target_paragraph_start).sort((a, b) => (a.target_paragraph_start || 0) - (b.target_paragraph_start || 0));

    let html = `
      <div class="case-intel-header" style="margin-bottom: 0.65rem;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div class="case-intel-title" style="margin-bottom: 0;">
            <i data-lucide="file-text"></i>
            <span>Judicial Notes & Commentary</span>
          </div>
          <button class="action-btn btn-primary" onclick="app.openCommentaryModal('case', '${caseData.id}')" style="font-size: 0.7rem; padding: 3px 8px; cursor: pointer;">
            <i data-lucide="plus" style="width: 12px; height: 12px;"></i> Add Note
          </button>
        </div>
        <p class="case-intel-desc" style="margin-top: 0.25rem;">Case summaries, ratio decidendi notes, and paragraph-level annotations.</p>
      </div>

      <!-- Tri-Tier Filter Pill Bar -->
      <div class="commentary-tier-bar">
        <button class="tier-pill-btn ${activeTier === 'all' ? 'active' : ''}" onclick="app.filterCommentaryByTier('all')">All (${all.length})</button>
        <button class="tier-pill-btn ${activeTier === 'moderator' ? 'active' : ''}" onclick="app.filterCommentaryByTier('moderator')">⚖️ Moderator (${modCount})</button>
        <button class="tier-pill-btn ${activeTier === 'practitioner' ? 'active' : ''}" onclick="app.filterCommentaryByTier('practitioner')">📝 Practitioner (${pracCount})</button>
        <button class="tier-pill-btn ${activeTier === 'ai' ? 'active' : ''}" onclick="app.filterCommentaryByTier('ai')">🤖 AI (${aiCount})</button>
      </div>
      <div id="commentary-cards-container">
    `;

    if (filtered.length === 0) {
      if (all.length === 0) {
        html += `
          <div class="commentary-box" style="margin-bottom: 0.75rem;">
            <h4><i data-lucide="sparkles" style="color: var(--border-active);"></i> Practitioner Summary</h4>
            <p>${caseData.catchwords || `Judgment of the ${caseData.court} delivered on ${caseData.judgment_date || 'N/A'}.`}</p>
          </div>
          <div class="info-empty-state" style="margin-top: 0.75rem;">
            <i data-lucide="edit-3"></i>
            <p>No notes published yet. Click <strong>+ Add Note</strong> above or on any paragraph in the reader to attach commentary.</p>
          </div>
        `;
      } else {
        html += `
          <div class="info-empty-state" style="margin-top: 0.75rem;">
            <i data-lucide="filter"></i>
            <p>No notes found in the <strong>${activeTier}</strong> tier.</p>
          </div>
        `;
      }
    } else {
      // 1. Case-Level Commentary
      if (caseLevel.length > 0) {
        html += `<div class="subheading-label" style="margin-bottom: 0.5rem;">Case-Level Practice Notes (${caseLevel.length})</div>`;
        for (const c of caseLevel) {
          html += this.buildCommentaryCardHtml(c);
        }
      }

      // 2. Paragraph-Level Annotations
      if (paraLevel.length > 0) {
        html += `<div class="subheading-label" style="margin-top: 0.85rem; margin-bottom: 0.5rem;">Paragraph Pinpoint Annotations (${paraLevel.length})</div>`;
        for (const c of paraLevel) {
          html += this.buildCommentaryCardHtml(c);
        }
      }
    }

    // 3. Inbound Cross-Citation Backlinks
    if (caseData && Array.isArray(caseData.referenced_by) && caseData.referenced_by.length > 0) {
      html += this.buildReferencedByHtml(caseData.referenced_by);
    }

    html += `</div>`;
    return html;
  }

  buildReferencedByHtml(referencedList) {
    if (!referencedList || referencedList.length === 0) return "";
    let html = `<div class="subheading-label" style="margin-top: 1rem; margin-bottom: 0.5rem;">🔗 Cross-Referenced From Other Notes (${referencedList.length})</div>`;
    for (const ref of referencedList) {
      let sourceHref = "#/";
      let sourceLabel = ref.target_id || "";
      if (ref.target_type === "case") {
        sourceHref = `#/cases/${ref.target_id}`;
        sourceLabel = `Case: ${ref.target_id.toUpperCase()}${ref.target_paragraph_start ? ` [${ref.target_paragraph_start}]` : ''}`;
      } else if (ref.target_type === "provision" && ref.target_id && ref.target_id.includes(":")) {
        const [actSlug, secSlug] = ref.target_id.split(":");
        sourceHref = `#/${actSlug}/${secSlug}`;
        sourceLabel = `${actSlug.replace(/-/g, ' ')} ${secSlug}`;
      }
      html += `
        <div class="commentary-box" style="margin-bottom: 0.65rem; border-left: 3px solid var(--border-active);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem; gap: 6px; flex-wrap: wrap;">
            <a href="${sourceHref}" class="badge-statute" style="font-size: 0.68rem; text-decoration: none; font-weight: 600;">
              <i data-lucide="arrow-up-right" style="width: 11px; height: 11px; vertical-align: middle;"></i> ${sourceLabel}
            </a>
            <span style="font-size: 0.68rem; color: var(--text-muted);">${ref.author_name || 'Practitioner'}</span>
          </div>
          ${ref.title ? `<h4 style="margin-bottom: 0.25rem; font-size: 0.78rem; font-weight: 700;">${ref.title}</h4>` : ''}
          <div class="commentary-card-body" style="font-size: 0.75rem; color: var(--text-secondary); line-height: 1.45;">
            ${ref.body_html || ref.body_markdown}
          </div>
        </div>
      `;
    }
    return html;
  }

  buildCommentaryCardHtml(c) {
    if (c && c.id) {
      this._commentaryById[c.id] = c;
    }
    const tier = c.author_tier || c.tier || "practitioner";
    let tierBadgeClass = "badge-tier-practitioner";
    let tierIcon = "📝";
    let tierLabel = "Practitioner Note";
    if (tier === "moderator" || tier === "tier1_judge") {
      tierBadgeClass = "badge-tier-moderator";
      tierIcon = "⚖️";
      tierLabel = "Moderator Note";
    } else if (tier === "ai" || tier === "ai_notation") {
      tierBadgeClass = "badge-tier-ai";
      tierIcon = "🤖";
      tierLabel = "AI Notation";
    }

    const paraStart = c.target_paragraph_start;
    const paraEnd = c.target_paragraph_end || paraStart;
    let paraChip = "";
    if (paraStart) {
      if (c.target_type === "provision" || (!c.target_type && this._infoPaneMode === "legislation")) {
        paraChip = `
          <div style="margin-bottom: 0.35rem;">
            <span class="badge-statute" style="background: rgba(4, 120, 87, 0.1); color: #047857; font-weight: 600; font-size: 0.6875rem; padding: 2px 6px;">
              Subsection (${paraStart}${paraEnd && paraEnd !== paraStart ? `–${paraEnd}` : ''}) Pinpoint
            </span>
          </div>
        `;
      } else {
        paraChip = `
          <div style="margin-bottom: 0.35rem;">
            <button class="para-jump-chip" onclick="app.jumpToParagraph(${paraStart}, ${paraEnd})" title="Jump to paragraph [${paraStart}] in reader">
              [${paraStart}${paraEnd && paraEnd !== paraStart ? `–${paraEnd}` : ''}] Jump to Para
            </button>
          </div>
        `;
      }
    }

    const isAuthed = !this.currentUser || this.currentUser.authenticated !== false;
    const versionBadge = c.version && c.version > 1 ? `<span style="font-size: 0.62rem; color: var(--text-muted);" title="Edited (version ${c.version})">v${c.version}</span>` : '';

    return `
      <div class="commentary-box ${paraStart ? `comm-card-para-${paraStart}` : 'comm-card-case'}" id="comm-card-${c.id}" data-tier="${tier}" style="margin-bottom: 0.75rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span class="badge-statute ${tierBadgeClass}" style="font-size: 0.65rem; padding: 1px 6px;">
              ${tierIcon} ${tierLabel}
            </span>
            <span style="font-size: 0.72rem; font-weight: 600; color: var(--text-primary);">${c.author_name || 'Practitioner'}</span>
            ${c.author_role ? `<span style="font-size: 0.65rem; color: var(--text-muted);">(${c.author_role})</span>` : ''}
            ${versionBadge}
          </div>
          ${isAuthed ? `
          <div style="display: inline-flex; align-items: center; gap: 4px;">
            <button class="close-btn" onclick="app.editCommentary('${c.id}')" title="Edit Note" style="color: var(--text-muted); opacity: 0.7; cursor: pointer;">
              <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i>
            </button>
            <button class="close-btn" onclick="app.deleteCommentary('${c.id}')" title="Delete Note" style="color: var(--text-muted); opacity: 0.6; cursor: pointer;">
              <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
            </button>
          </div>
          ` : ''}
        </div>
        ${c.title ? `<h4 style="margin-bottom: 0.35rem; font-size: 0.8125rem; font-weight: 700;">${c.title}</h4>` : ''}
        ${paraChip}
        <div class="commentary-card-body" style="font-size: 0.78rem; color: var(--text-secondary); line-height: 1.5;">
          ${c.body_html || c.body_markdown}
        </div>
      </div>
    `;
  }

  renderProvisionCommentary(prov, activeTier = "all") {
    const container = document.getElementById("info-commentary-container");
    if (!container) return;

    const commList = (prov.info && prov.info.commentary) ? prov.info.commentary : [];
    const referencedBy = (prov.info && prov.info.referenced_by) ? prov.info.referenced_by : [];
    const modCount = commList.filter(c => (c.author_tier || c.tier) === "moderator" || (c.author_tier || c.tier) === "tier1_judge").length;
    const pracCount = commList.filter(c => (c.author_tier || c.tier) === "practitioner" || !c.author_tier || (c.author_tier || c.tier) === "tier2_editorial" || (c.author_tier || c.tier) === "tier3_user").length;
    const aiCount = commList.filter(c => (c.author_tier || c.tier) === "ai" || (c.author_tier || c.tier) === "ai_notation").length;

    let filtered = commList;
    if (activeTier && activeTier !== "all") {
      filtered = commList.filter(c => {
        const t = c.author_tier || c.tier || "practitioner";
        if (activeTier === "moderator") return t === "moderator" || t === "tier1_judge";
        if (activeTier === "practitioner") return t === "practitioner" || t === "tier2_editorial" || t === "tier3_user";
        if (activeTier === "ai") return t === "ai" || t === "ai_notation";
        return true;
      });
    }

    const cleanId = String(prov.identifier).replace(/^s/i, "").trim();
    const prefix = (prov.act_slug && (prov.act_slug.includes("regulation") || prov.act_slug.includes("rules"))) ? "r" : "s";
    const targetId = `${prov.act_slug}:${prefix}${cleanId}`;

    let html = `
      <div class="case-intel-header" style="margin-bottom: 0.65rem;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div class="case-intel-title" style="margin-bottom: 0;">
            <i data-lucide="book-open"></i>
            <span>Statutory Purpose & Guidance</span>
          </div>
          <button class="action-btn btn-primary" onclick="app.openCommentaryModal('provision', '${targetId}')" style="font-size: 0.7rem; padding: 3px 8px; cursor: pointer;">
            <i data-lucide="plus" style="width: 12px; height: 12px;"></i> Add Note
          </button>
        </div>
      </div>

      <div class="commentary-box" style="margin-bottom: 0.75rem;">
        <h4><i data-lucide="shield-check" style="color: var(--border-active);"></i> Section Overview</h4>
        <p id="commentary-text">Statutory context, case interpretations, and practitioner guidance for <strong>s ${prov.identifier}</strong>.</p>
      </div>

      <!-- Tri-Tier Filter Pill Bar -->
      <div class="commentary-tier-bar">
        <button class="tier-pill-btn ${activeTier === 'all' ? 'active' : ''}" onclick="app.filterCommentaryByTier('all')">All (${commList.length})</button>
        <button class="tier-pill-btn ${activeTier === 'moderator' ? 'active' : ''}" onclick="app.filterCommentaryByTier('moderator')">⚖️ Moderator (${modCount})</button>
        <button class="tier-pill-btn ${activeTier === 'practitioner' ? 'active' : ''}" onclick="app.filterCommentaryByTier('practitioner')">📝 Practitioner (${pracCount})</button>
        <button class="tier-pill-btn ${activeTier === 'ai' ? 'active' : ''}" onclick="app.filterCommentaryByTier('ai')">🤖 AI (${aiCount})</button>
      </div>
    `;

    if (filtered.length === 0) {
      html += `
        <div class="info-empty-state" style="margin-top: 0.75rem;">
          <i data-lucide="edit-3"></i>
          <p>No practitioner notes indexed for <strong>s ${prov.identifier}</strong> yet. Click <strong>+ Add Note</strong> above to attach analysis.</p>
        </div>
      `;
    } else {
      for (const c of filtered) {
        html += this.buildCommentaryCardHtml(c);
      }
    }

    if (referencedBy.length > 0) {
      html += this.buildReferencedByHtml(referencedBy);
    }

    container.innerHTML = html;
    lucide.createIcons();
  }

  openCommentaryModal(targetType, targetId, paraStart = null, paraEnd = null, existingNote = null) {
    if (this.currentUser && this.currentUser.authenticated === false) {
      if (confirm("Sign in via Cloudflare Access is required to add or edit annotations. Proceed to Sign In?")) {
        window.location.href = `/api/auth/login?redirect=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
      }
      return;
    }

    this.activeCommentaryTarget = { type: targetType, id: targetId };
    this.editingCommentaryId = existingNote ? existingNote.id : null;
    
    // Label
    const labelEl = document.getElementById("commentary-target-label");
    if (labelEl) {
      labelEl.textContent = `${targetType === 'case' ? 'Judgment' : 'Provision'}: ${targetId}${paraStart ? ` (Para [${paraStart}])` : ''}`;
    }

    // Modal Title
    const modalTitle = document.getElementById("commentary-modal-title");
    if (modalTitle) {
      modalTitle.textContent = `${existingNote ? 'Edit' : 'Add'} Legal Commentary — ${targetType === 'case' ? 'Judgment' : 'Provision'}`;
    }

    // Scope Radio & Pinpoint inputs
    const docRadio = document.getElementById("comm-scope-doc");
    const paraRadio = document.getElementById("comm-scope-para");
    const paraInputsRow = document.getElementById("comm-para-inputs-row");
    const pStartInput = document.getElementById("comm-para-start");
    const pEndInput = document.getElementById("comm-para-end");
    const docRadioLabel = document.getElementById("comm-scope-doc-label");

    if (docRadioLabel) {
      docRadioLabel.textContent = targetType === "case" ? "Entire Decision / Case-Level" : "Entire Provision";
    }
    const paraRadioLabel = document.getElementById("comm-scope-para-label");
    if (paraRadioLabel) {
      paraRadioLabel.textContent = targetType === "case" ? "Specific Paragraph(s)" : "Subsection Pinpoint (e.g. (3))";
    }

    if (paraStart) {
      if (paraRadio) paraRadio.checked = true;
      if (paraInputsRow) paraInputsRow.style.display = "block";
      if (pStartInput) pStartInput.value = paraStart;
      if (pEndInput) pEndInput.value = paraEnd && paraEnd !== paraStart ? paraEnd : "";
    } else {
      if (docRadio) docRadio.checked = true;
      if (paraInputsRow) paraInputsRow.style.display = "none";
      if (pStartInput) pStartInput.value = "";
      if (pEndInput) pEndInput.value = "";
    }

    const tierSelect = document.getElementById("comm-tier-select");
    if (tierSelect) {
      tierSelect.value = existingNote ? (existingNote.author_tier || "practitioner") : "practitioner";
    }
    const authorInput = document.getElementById("comm-author-input");
    if (authorInput) {
      authorInput.value = existingNote
        ? (existingNote.author_name || "Practitioner")
        : (this.currentUser?.display_name || "Practitioner");
    }

    // Populate or Clear Title & Body
    const titleInput = document.getElementById("comm-title-input");
    if (titleInput) titleInput.value = existingNote ? (existingNote.title || "") : "";

    const bodyInput = document.getElementById("comm-body-input");
    if (bodyInput) bodyInput.value = existingNote ? (existingNote.body_markdown || "") : "";

    // Reset or trigger Live Preview
    const previewBox = document.getElementById("comm-live-preview-box");
    if (previewBox) previewBox.style.display = "none";
    const previewContent = document.getElementById("comm-preview-content");
    if (previewContent) previewContent.innerHTML = "";
    if (existingNote && existingNote.body_markdown) {
      this.updateLivePreview();
    }

    // Show modal
    const modal = document.getElementById("commentary-modal");
    if (modal) {
      modal.style.display = "flex";
      lucide.createIcons();
      setTimeout(() => titleInput?.focus(), 50);
    }
  }

  editCommentary(commentId) {
    const existing = this._commentaryById[commentId];
    if (!existing) return;
    const tType = existing.target_type || (this._infoPaneMode === "case" ? "case" : "provision");
    const tId = existing.target_id || (this._infoPaneMode === "case" ? this._currentCaseData?.id : "");
    this.openCommentaryModal(
      tType,
      tId,
      existing.target_paragraph_start || null,
      existing.target_paragraph_end || null,
      existing
    );
  }

  closeCommentaryModal() {
    this.editingCommentaryId = null;
    const modal = document.getElementById("commentary-modal");
    if (modal) modal.style.display = "none";
  }

  handleCommentaryScopeChange() {
    const isPara = document.getElementById("comm-scope-para")?.checked;
    const paraInputsRow = document.getElementById("comm-para-inputs-row");
    if (paraInputsRow) {
      paraInputsRow.style.display = isPara ? "block" : "none";
    }
    this.updateLivePreview();
  }

  updateLivePreview() {
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(async () => {
      const bodyInput = document.getElementById("comm-body-input");
      const val = bodyInput ? bodyInput.value.trim() : "";
      const previewBox = document.getElementById("comm-live-preview-box");
      const previewContent = document.getElementById("comm-preview-content");
      const countEl = document.getElementById("comm-detected-count");

      if (!val) {
        if (previewBox) previewBox.style.display = "none";
        return;
      }

      try {
        const res = await fetch("/api/commentary/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body_markdown: val,
            current_act_slug: this.currentAct
          })
        });
        if (res.ok) {
          const data = await res.json();
          if (previewContent) previewContent.innerHTML = data.body_html;
          const numCitations = (data.citations || []).length;
          if (countEl) countEl.textContent = `${numCitations} citation${numCitations === 1 ? '' : 's'} linked`;
          if (previewBox) previewBox.style.display = "block";
          lucide.createIcons();
        }
      } catch (e) {
        console.error("Live preview error:", e);
      }
    }, 150);
  }

  async saveCommentary() {
    if (!this.activeCommentaryTarget) return;

    const titleInput = document.getElementById("comm-title-input");
    const bodyInput = document.getElementById("comm-body-input");
    const tierSelect = document.getElementById("comm-tier-select");
    const authorInput = document.getElementById("comm-author-input");
    const isPara = document.getElementById("comm-scope-para")?.checked;
    const pStartInput = document.getElementById("comm-para-start");
    const pEndInput = document.getElementById("comm-para-end");

    const title = titleInput ? titleInput.value.trim() : "";
    const body = bodyInput ? bodyInput.value.trim() : "";
    const tier = tierSelect ? tierSelect.value : "practitioner";
    const authorName = authorInput ? authorInput.value.trim() : "Practitioner Note";

    if (!title) {
      alert("Please provide a title or headline for this note.");
      titleInput?.focus();
      return;
    }
    if (!body) {
      alert("Please enter the commentary body text.");
      bodyInput?.focus();
      return;
    }

    let pStart = null;
    let pEnd = null;
    if (isPara && pStartInput && pStartInput.value) {
      const cleanStart = String(pStartInput.value).replace(/[^\d]/g, '');
      pStart = cleanStart ? parseInt(cleanStart, 10) : null;
      if (pEndInput && pEndInput.value) {
        const cleanEnd = String(pEndInput.value).replace(/[^\d]/g, '');
        pEnd = cleanEnd ? parseInt(cleanEnd, 10) : pStart;
      } else {
        pEnd = pStart;
      }
    }

    const payload = {
      target_type: this.activeCommentaryTarget.type,
      target_id: this.activeCommentaryTarget.id,
      title: title,
      body_markdown: body,
      author_tier: tier,
      author_name: authorName,
      target_paragraph_start: pStart,
      target_paragraph_end: pEnd,
      current_act_slug: this.currentAct
    };

    const saveBtn = document.getElementById("comm-save-btn");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = `<span>Saving...</span>`;
    }

    try {
      const targetMeta = this.activeCommentaryTarget;
      const endpoint = this.editingCommentaryId
        ? `/api/commentary/${this.editingCommentaryId}`
        : "/api/commentary";
      const method = this.editingCommentaryId ? "PUT" : "POST";

      const res = await fetch(endpoint, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (res.status === 401) {
        if (confirm("Your session requires Cloudflare Access authentication. Sign in now?")) {
          window.location.href = `/api/auth/login?redirect=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
        }
        return;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert("Failed to save commentary: " + (err.detail || "Server error"));
        return;
      }

      this.closeCommentaryModal();

      // Refresh data
      if (targetMeta.type === "case" && this._currentCaseData) {
        const caseRes = await fetch(`/api/cases/${this._currentCaseData.id}`);
        if (caseRes.ok) {
          const updatedCase = await caseRes.json();
          this.renderJudgmentReader(updatedCase);
          this.switchInfoTab("case-commentary");
        }
      } else if (targetMeta.type === "provision") {
        let actSlug = this._currentProvData?.act_slug;
        let fullSlug = this._currentProvData?.full_slug || this._currentProvData?.slug;
        if (!actSlug || !fullSlug) {
          const parts = (targetMeta.id || "").split(":");
          if (parts.length === 2) {
            actSlug = parts[0];
            fullSlug = parts[1];
          }
        }
        if (actSlug && fullSlug) {
          const provRes = await fetch(`/api/acts/${actSlug}/provisions/${fullSlug}`);
          if (provRes.ok) {
            const updatedProv = await provRes.json();
            this._currentProvData = updatedProv;
            this.renderInfoPaneData(updatedProv);
            this.switchInfoTab("commentary");
          }
        }
      }
    } catch (e) {
      console.error("Save commentary error:", e);
      alert("Error saving note: " + e.message);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `<i data-lucide="check" style="width: 13px; height: 13px;"></i><span>Save & Publish Note</span>`;
        lucide.createIcons();
      }
    }
  }

  async deleteCommentary(commentId) {
    if (this.currentUser && this.currentUser.authenticated === false) {
      if (confirm("Sign in via Cloudflare Access is required to delete annotations. Proceed to Sign In?")) {
        window.location.href = `/api/auth/login?redirect=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
      }
      return;
    }
    if (!confirm("Are you sure you want to delete this commentary note?")) return;

    try {
      const res = await fetch(`/api/commentary/${commentId}`, { method: "DELETE" });
      if (res.status === 401) {
        if (confirm("Your session requires Cloudflare Access authentication. Sign in now?")) {
          window.location.href = `/api/auth/login?redirect=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
        }
        return;
      }
      if (!res.ok) {
        alert("Failed to delete commentary.");
        return;
      }

      // Refresh active pane
      if (this._infoPaneMode === "case" && this._currentCaseData) {
        const caseRes = await fetch(`/api/cases/${this._currentCaseData.id}`);
        if (caseRes.ok) {
          const updatedCase = await caseRes.json();
          this.renderJudgmentReader(updatedCase);
          this.switchInfoTab("case-commentary");
        }
      } else if (this._infoPaneMode === "legislation") {
        let actSlug = this._currentProvData?.act_slug;
        let fullSlug = this._currentProvData?.full_slug || this._currentProvData?.slug;
        if (actSlug && fullSlug) {
          const provRes = await fetch(`/api/acts/${actSlug}/provisions/${fullSlug}`);
          if (provRes.ok) {
            const updatedProv = await provRes.json();
            this._currentProvData = updatedProv;
            this.renderInfoPaneData(updatedProv);
            this.switchInfoTab("commentary");
          }
        }
      }
    } catch (e) {
      console.error("Delete commentary error:", e);
      alert("Error deleting commentary: " + e.message);
    }
  }

  filterCommentaryByTier(tier) {
    this.commentaryTierFilter = tier;
    if (this._infoPaneMode === "case" && this._currentCaseData) {
      const panel = document.getElementById("panel-case-commentary");
      if (panel) {
        panel.innerHTML = this.renderCaseCommentaryPanel(this._currentCaseData, this._currentCaseData.commentary, tier);
        lucide.createIcons();
      }
    } else if (this._infoPaneMode === "legislation" && this._currentProvData) {
      this.renderProvisionCommentary(this._currentProvData, tier);
    }
  }

  showParagraphCommentary(paraNum) {
    if (this.elInfoPane && this.elInfoPane.style.display !== "flex") {
      this.toggleInfoPane();
    }
    this.switchInfoTab("case-commentary");
    this.filterCommentaryByTier("all");

    // Scroll to the commentary card matching this paragraph and pulse it
    const cards = document.querySelectorAll(`.comm-card-para-${paraNum}`);
    if (cards.length > 0) {
      cards[0].scrollIntoView({ behavior: "smooth", block: "center" });
      cards.forEach(c => {
        c.classList.remove("card-targeted-pulse");
        void c.offsetWidth;
        c.classList.add("card-targeted-pulse");
      });
    } else {
      this.openCommentaryModal("case", this._currentCaseData?.id || "", paraNum);
    }
  }

  // ==========================================================================
  // --- IN-READER FIND ENGINE METHODS (Phase 3) ---
  // ==========================================================================

  openReaderFindBar() {
    if (!this.elReaderFindBar) return;
    this.findBarOpen = true;
    this.elReaderFindBar.style.display = "block";
    
    if (this.elFindInReaderBtn) {
      this.elFindInReaderBtn.classList.add("active");
    }

    if (this.elReaderFindInput) {
      this.elReaderFindInput.focus();
      this.elReaderFindInput.select();
    }

    if (this.elReaderFindInput && this.elReaderFindInput.value.trim()) {
      this.executeReaderFind();
    }
  }

  closeReaderFindBar() {
    if (!this.elReaderFindBar) return;
    this.findBarOpen = false;
    this.elReaderFindBar.style.display = "none";

    if (this.elFindInReaderBtn) {
      this.elFindInReaderBtn.classList.remove("active");
    }

    this.clearReaderFindHighlights();
    this.updateFindStatus();
  }

  toggleFindOption(option) {
    if (option === "case") {
      this.findCaseSensitive = !this.findCaseSensitive;
      if (this.elReaderFindCaseBtn) {
        this.elReaderFindCaseBtn.classList.toggle("active", this.findCaseSensitive);
      }
    } else if (option === "word") {
      this.findWholeWord = !this.findWholeWord;
      if (this.elReaderFindWordBtn) {
        this.elReaderFindWordBtn.classList.toggle("active", this.findWholeWord);
      }
    }
    this.executeReaderFind();
  }

  clearReaderFindHighlights() {
    const marks = document.querySelectorAll("mark.canopy-find-match");
    marks.forEach(m => {
      const parent = m.parentNode;
      if (parent) {
        while (m.firstChild) {
          parent.insertBefore(m.firstChild, m);
        }
        m.remove();
        parent.normalize();
      }
    });
    this.findMatches = [];
    this.activeMatchIndex = -1;
  }

  executeReaderFind() {
    this.clearReaderFindHighlights();

    if (!this.elReaderFindInput) return;
    const rawQuery = this.elReaderFindInput.value;
    if (!rawQuery || !rawQuery.trim()) {
      this.updateFindStatus();
      return;
    }

    const query = rawQuery.trim();

    // Target the reader container content
    const root = this.elReaderContainer;
    if (!root) return;

    // Build regex
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = this.findWholeWord ? `\\b${escaped}\\b` : escaped;
    const flags = this.findCaseSensitive ? 'g' : 'gi';
    let regex;
    try {
      regex = new RegExp(pattern, flags);
    } catch (e) {
      return;
    }

    // Non-destructive TreeWalker traversal
    const textNodes = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          
          // Skip interactive, non-content, or find-bar elements
          if (
            parent.closest("#reader-find-bar") ||
            parent.closest("button") ||
            parent.closest(".subbar-actions") ||
            parent.closest(".continuous-sec-bar") ||
            parent.closest(".para-comment-badge") ||
            parent.closest(".para-add-note-btn") ||
            parent.closest(".print-intelligence-section") ||
            parent.closest(".doc-header-top") ||
            parent.closest(".doc-disclaimer") ||
            parent.tagName === "SCRIPT" ||
            parent.tagName === "STYLE" ||
            parent.tagName === "NOSCRIPT"
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let currentNode;
    while ((currentNode = walker.nextNode())) {
      textNodes.push(currentNode);
    }

    const createdMarks = [];
    let matchIdx = 0;

    for (const node of textNodes) {
      const text = node.nodeValue;
      regex.lastIndex = 0;
      let match;
      const matchesInNode = [];

      while ((match = regex.exec(text)) !== null) {
        matchesInNode.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[0]
        });
        if (!regex.global) break;
      }

      if (matchesInNode.length > 0) {
        const parent = node.parentNode;
        if (!parent) continue;

        const frag = document.createDocumentFragment();
        let lastIndex = 0;

        for (const m of matchesInNode) {
          // Text before match
          if (m.start > lastIndex) {
            frag.appendChild(document.createTextNode(text.substring(lastIndex, m.start)));
          }

          // Matched text inside <mark>
          const mark = document.createElement("mark");
          mark.className = "canopy-find-match";
          mark.dataset.matchIdx = String(matchIdx++);
          mark.textContent = m.text;
          frag.appendChild(mark);
          createdMarks.push(mark);

          lastIndex = m.end;
        }

        // Remaining text after last match
        if (lastIndex < text.length) {
          frag.appendChild(document.createTextNode(text.substring(lastIndex)));
        }

        parent.replaceChild(frag, node);
      }
    }

    this.findMatches = createdMarks;
    this.activeMatchIndex = createdMarks.length > 0 ? 0 : -1;

    if (this.findMatches.length > 0) {
      this.scrollToActiveMatch();
    } else {
      this.updateFindStatus();
    }
  }

  navigateReaderFind(direction) {
    if (this.findMatches.length === 0) return;

    if (direction > 0) {
      this.activeMatchIndex = (this.activeMatchIndex + 1) % this.findMatches.length;
    } else {
      this.activeMatchIndex = (this.activeMatchIndex - 1 + this.findMatches.length) % this.findMatches.length;
    }

    this.scrollToActiveMatch();
  }

  scrollToActiveMatch() {
    if (this.activeMatchIndex < 0 || this.activeMatchIndex >= this.findMatches.length) {
      this.updateFindStatus();
      return;
    }

    this.findMatches.forEach((m, idx) => {
      if (idx === this.activeMatchIndex) {
        m.classList.add("active-match");
      } else {
        m.classList.remove("active-match");
      }
    });

    const activeEl = this.findMatches[this.activeMatchIndex];
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }

    this.updateFindStatus();
  }

  updateFindStatus() {
    const total = this.findMatches.length;
    const current = this.activeMatchIndex >= 0 ? this.activeMatchIndex + 1 : 0;
    const query = this.elReaderFindInput ? this.elReaderFindInput.value.trim() : "";

    if (this.elReaderFindCounter) {
      this.elReaderFindCounter.classList.remove("has-matches", "no-matches");
      if (!query) {
        this.elReaderFindCounter.textContent = "0 of 0";
      } else if (total === 0) {
        this.elReaderFindCounter.textContent = "No matches";
        this.elReaderFindCounter.classList.add("no-matches");
      } else {
        this.elReaderFindCounter.textContent = `${current} of ${total}`;
        this.elReaderFindCounter.classList.add("has-matches");
      }
    }

    if (this.elReaderFindPrevBtn) this.elReaderFindPrevBtn.disabled = total === 0;
    if (this.elReaderFindNextBtn) this.elReaderFindNextBtn.disabled = total === 0;

    // Pinpoint context detection
    if (this.elReaderFindPinpoint) {
      if (total > 0 && this.activeMatchIndex >= 0) {
        const activeEl = this.findMatches[this.activeMatchIndex];
        const pinpoint = this.resolveMatchPinpoint(activeEl);
        if (pinpoint) {
          this.elReaderFindPinpoint.textContent = pinpoint;
          this.elReaderFindPinpoint.title = `Match ${current} of ${total} located in ${pinpoint}`;
          this.elReaderFindPinpoint.style.display = "inline-block";
        } else {
          this.elReaderFindPinpoint.style.display = "none";
        }
      } else {
        this.elReaderFindPinpoint.style.display = "none";
      }
    }
  }

  resolveMatchPinpoint(el) {
    if (!el) return "";

    // 1. Check if inside a provision article
    const article = el.closest(".provision-article");
    if (article) {
      const secTag = article.querySelector(".continuous-sec-tag");
      if (secTag && secTag.textContent) {
        return secTag.textContent.trim();
      }
      if (article.id && article.id.startsWith("prov-view-")) {
        const heading = article.querySelector(".frag-heading, .heading, h2, h3, .clause-heading");
        if (heading && heading.textContent) {
          const m = heading.textContent.match(/^(?:Section\s+|s\s*)?([0-9A-Za-z]+)/i);
          if (m) return `s ${m[1]}`;
        }
        const provId = article.id.replace("prov-view-", "");
        return `s ${provId}`;
      }
    }

    // 2. Check if inside a paragraph (caselaw)
    const paraWrap = el.closest(".para-wrap") || el.closest("[id^='para-']");
    if (paraWrap) {
      const pNumEl = paraWrap.querySelector(".para-num");
      if (pNumEl && pNumEl.textContent) {
        return `Para ${pNumEl.textContent.trim()}`;
      }
      const match = (paraWrap.id || "").match(/para-(\d+)/);
      if (match) return `Para [${match[1]}]`;
    }

    return "";
  }
}

// Global App Instance
let app;
window.addEventListener("DOMContentLoaded", () => {
  app = new LegislationApp();
});
