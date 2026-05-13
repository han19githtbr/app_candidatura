const state = {
  data: null,
  jobs: [],
  filters: {
    search: "",
    location: "remote",
    type: "all",
    strongOnly: false,
    lowCompetitionOnly: true,
    sort: "opportunity"
  },
  notifiedJobIds: new Set(JSON.parse(localStorage.getItem("notifiedJobIds") || "[]"))
};

const els = {
  profileSummary: document.querySelector("#profile-summary"),
  profileRole: document.querySelector("#profile-role"),
  profileTags: document.querySelector("#profile-tags"),
  profileLanguages: document.querySelector("#profile-languages"),
  cvButton: document.querySelector("#cv-button"),
  matchCount: document.querySelector("#match-count"),
  sourceCount: document.querySelector("#source-count"),
  platformLinks: document.querySelector("#platform-links"),
  jobList: document.querySelector("#job-list"),
  resultsSubtitle: document.querySelector("#results-subtitle"),
  syncStatus: document.querySelector("#sync-status"),
  filters: document.querySelector("#filters"),
  searchInput: document.querySelector("#search-input"),
  locationSelect: document.querySelector("#location-select"),
  typeSelect: document.querySelector("#type-select"),
  strongOnly: document.querySelector("#strong-only"),
  lowCompetitionOnly: document.querySelector("#low-competition-only"),
  startImmediateOnly: document.querySelector("#start-immediate-only"),
  sortSelect: document.querySelector("#sort-select"),
  refreshButton: document.querySelector("#refresh-button"),
  notifyButton: document.querySelector("#notify-button"),
  toggleFiltersButton: document.querySelector("#toggle-filters"),
  template: document.querySelector("#job-card-template")
};

const API_SOURCES = [
  {
    name: "Remotive",
    buildUrl: (query) => `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}`,
    normalize: (payload) =>
      (payload.jobs || []).map((job) => ({
        id: `remotive-${job.id}`,
        title: job.title,
        company: job.company_name,
        location: job.candidate_required_location || "Remoto",
        type: job.job_type || "full-time",
        source: "Remotive",
        url: job.url,
        createdAt: job.publication_date,
        description: stripHtml(job.description),
        tags: [...(job.tags || []), job.category].filter(Boolean)
      }))
  },
  {
    name: "Arbeitnow",
    buildUrl: () => "https://www.arbeitnow.com/api/job-board-api",
    normalize: (payload) =>
      (payload.data || []).map((job) => ({
        id: `arbeitnow-${job.slug}`,
        title: job.title,
        company: job.company_name,
        location: job.location || "Remoto",
        type: job.job_types?.[0] || "full-time",
        source: "Arbeitnow",
        url: job.url,
        createdAt: job.created_at ? new Date(job.created_at * 1000).toISOString() : "",
        description: stripHtml(job.description),
        tags: [...(job.tags || []), ...(job.job_types || [])]
      }))
  },
  {
    name: "RemoteOK",
    buildUrl: () => "https://remoteok.com/api",
    normalize: (payload) =>
      (Array.isArray(payload) ? payload.slice(1) : []).map((job) => ({
        id: `remoteok-${job.id}`,
        title: job.position,
        company: job.company,
        location: job.location || "Remoto",
        type: job.tags?.some((tag) => /contract|freelance/i.test(tag)) ? "contract" : "full-time",
        source: "RemoteOK",
        url: job.url,
        createdAt: job.date,
        description: stripHtml(job.description || ""),
        tags: job.tags || []
      }))
  }
];

init();

async function init() {
  await registerServiceWorker();
  state.data = await fetchJson("database/data.json");
  hydrateProfile();
  bindEvents();
  renderPlatformLinks();
  state.jobs = rankJobs(state.data.seedJobs);
  renderJobs();
  await refreshJobs();
}

function bindEvents() {
  els.filters.addEventListener("submit", (event) => {
    event.preventDefault();
    syncFiltersFromForm();
    renderPlatformLinks();
    renderJobs();
    refreshJobs();
    document.body.classList.remove("filters-open");
  });

  [els.locationSelect, els.typeSelect, els.strongOnly, els.lowCompetitionOnly, els.startImmediateOnly].forEach((input) => {
    input.addEventListener("change", () => {
      syncFiltersFromForm();
      renderPlatformLinks();
      renderJobs();
    });
  });

  els.sortSelect.addEventListener("change", () => {
    state.filters.sort = els.sortSelect.value;
    renderJobs();
  });

  els.refreshButton.addEventListener("click", refreshJobs);
  els.notifyButton.addEventListener("click", enableNotifications);
  els.toggleFiltersButton?.addEventListener("click", () => {
    document.body.classList.toggle("filters-open");
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 620) {
      document.body.classList.remove("filters-open");
    }
  });
}

function syncFiltersFromForm() {
  state.filters.search = els.searchInput.value.trim();
  state.filters.location = els.locationSelect.value;
  state.filters.type = els.typeSelect.value;
  state.filters.strongOnly = els.strongOnly.checked;
  state.filters.lowCompetitionOnly = els.lowCompetitionOnly.checked;
  state.filters.startImmediateOnly = els.startImmediateOnly.checked;
}

function buildSearchQuery() {
  const explicitSearch = state.filters.search.trim();
  const immediateTerms = state.filters.startImmediateOnly ? ["inicio imediato", "início imediato", "start immediately", "immediate start"] : [];

  if (explicitSearch) {
    return `${explicitSearch} ${immediateTerms.join(" ")}`.trim();
  }

  const terms = [
    ...state.data.profile.preferredTerms,
    ...(state.data.profile.keywords || []),
    ...immediateTerms
  ]
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .filter((value) => !/remote|remoto|pj|freelance|clt|full-time|contract|internship|estagio/i.test(value) || /inicio imediato|start immediately|immediate start/i.test(value))
    .slice(0, 12);

  return terms.join(" ");
}

async function refreshJobs() {
  const query = buildSearchQuery();
  setStatus("Buscando vagas...");
  els.refreshButton.disabled = true;

  const results = await Promise.allSettled(
    API_SOURCES.map(async (source) => {
      const payload = await fetchJson(source.buildUrl(query));
      return source.normalize(payload);
    })
  );

  const remoteJobs = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const merged = dedupeJobs([...remoteJobs, ...state.data.seedJobs]);
  state.jobs = rankJobs(merged);

  const failed = results.filter((result) => result.status === "rejected").length;
  setStatus(failed ? `Atualizado com ${failed} fonte(s) bloqueada(s)` : "Vagas atualizadas");
  els.refreshButton.disabled = false;
  renderJobs();
  notifyStrongMatches();
}

function rankJobs(jobs) {
  const keywords = state.data.profile.keywords.map(normalizeText);
  const preferred = state.data.profile.preferredTerms.map(normalizeText);
  const coreFrontend = [
    "front-end",
    "frontend",
    "react",
    "reactjs",
    "react.js",
    "next.js",
    "nextjs",
    "angular",
    "javascript",
    "html",
    "css",
    "ui",
    "web",
    "typescript",
    "node",
    "node.js",
    "nodejs"
  ];
  const adjacent = [
    "firebase",
    "firestore",
    "mongodb",
    "postgresql",
    "wordpress",
    "elementor",
    "api",
    "rest",
    "web sockets",
    "websockets",
    "git",
    "gitlab",
    "figma",
    "java",
    "spring boot",
    "springboot"
  ];
  const distantRoles = ["devops", "android", "ios", "mobile", "aws", "azure", ".net", "c#", "c++", "golang", "python", "data engineer", "qa automation", "salesforce"];

  return jobs.map((job) => {
    const haystack = normalizeText(`${job.title} ${job.company} ${job.location} ${job.type} ${job.description} ${(job.tags || []).join(" ")}`);
    const titleText = normalizeText(job.title || "");
    const keywordHits = keywords.filter((word) => haystack.includes(word)).length;
    const preferredHits = preferred.filter((word) => haystack.includes(word)).length;
    const coreHits = coreFrontend.filter((word) => haystack.includes(word)).length;
    const titleCoreHits = coreFrontend.filter((word) => titleText.includes(word)).length;
    const adjacentHits = adjacent.filter((word) => haystack.includes(word)).length;
    const distantHits = distantRoles.filter((word) => haystack.includes(word)).length;
    const remoteBonus = /remoto|remote|worldwide|anywhere|brasil/.test(`${job.location} ${job.description}`) ? 12 : 0;
    const freelanceBonus = /freelance|contract|pj|contrato|part-time/.test(`${job.type} ${job.title} ${job.description}`) ? 8 : 0;
    const startImmediateBonus = /inicio imediato|inicio imediato|início imediato|start immediately|immediate start|imediato/.test(haystack) ? 8 : 0;
    const rolePenalty = titleCoreHits === 0 && distantHits > 0 ? distantHits * 14 : distantHits * 6;
    const noFrontendPenalty = coreHits === 0 ? 28 : 0;
    const score = clamp(
      Math.round(
        28 +
          keywordHits * 2 +
          preferredHits * 7 +
          coreHits * 7 +
          titleCoreHits * 12 +
          adjacentHits * 3 +
          remoteBonus +
          freelanceBonus +
          startImmediateBonus -
          rolePenalty -
          noFrontendPenalty
      ),
      12,
      98
    );
    const competitionScore = calculateCompetitionScore(job, haystack);
    const opportunityScore = Math.round(score * 0.7 + competitionScore * 0.3);
    const pitch = buildCandidatePitch(job, haystack);

    return {
      ...job,
      score,
      competitionScore,
      opportunityScore,
      pitch,
      tags: Array.from(new Set((job.tags || []).filter(Boolean))).slice(0, 6)
    };
  });
}

function renderJobs() {
  const jobs = getVisibleJobs();
  els.jobList.innerHTML = "";
  els.matchCount.textContent = state.jobs.filter((job) => job.score >= 72).length;
  els.resultsSubtitle.textContent = `${jobs.length} vaga${jobs.length === 1 ? "" : "s"} com aderência e menor concorrência de ${state.jobs.length}.`;

  if (!jobs.length) {
    els.jobList.innerHTML = '<div class="empty-state">Nenhuma vaga bateu com esses filtros. Tente remover o filtro de compatibilidade alta ou buscar por outro termo.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  jobs.forEach((job) => {
    const card = els.template.content.firstElementChild.cloneNode(true);
    card.querySelector(".source-badge").textContent = job.source || "Fonte";
    card.querySelector(".job-date").textContent = formatDate(job.createdAt);
    card.querySelector("h4").textContent = job.title || "Vaga sem titulo";
    card.querySelector(".company-line").textContent = `${job.company || "Empresa nao informada"} - ${job.location || "Local nao informado"}`;
    card.querySelector(".job-description").textContent = job.description || "Abra a vaga para conferir os detalhes completos.";
    card.querySelector(".match-value").textContent = `${job.score}%`;
    card.querySelector(".competition-value").textContent = getCompetitionLabel(job.competitionScore);

    if (job.pitch) {
      const pitch = document.createElement("p");
      pitch.className = "job-pitch";
      pitch.textContent = job.pitch;
      card.querySelector(".job-description").insertAdjacentElement("afterend", pitch);
    }

    const tagRow = card.querySelector(".tag-row");
    job.tags.forEach((tag) => {
      const item = document.createElement("span");
      item.className = "tag";
      item.textContent = tag;
      tagRow.appendChild(item);
    });

    const link = card.querySelector(".apply-link");
    link.href = job.url || "#";
    link.textContent = "Candidatar";
    fragment.appendChild(card);
  });

  els.jobList.appendChild(fragment);
}

function getVisibleJobs() {
  const term = normalizeText(state.filters.search);
  const termTokens = term.split(/\s+/).filter((token) => token.length > 1);
  const location = normalizeText(state.filters.location);

  return state.jobs
    .filter((job) => {
      const haystack = normalizeText(`${job.title} ${job.company} ${job.location} ${job.type} ${job.description} ${(job.tags || []).join(" ")}`);
      const matchesTerm = !termTokens.length || termTokens.some((token) => haystack.includes(token));
      const matchesLocation = location === "remote" ? /remote|remoto|worldwide|anywhere/.test(haystack) : haystack.includes(location) || location === "worldwide";
      const matchesType = state.filters.type === "all" || normalizeText(job.type).includes(state.filters.type) || haystack.includes(state.filters.type);
      const matchesStrength = !state.filters.strongOnly || job.score >= 72;
      const matchesCompetition = !state.filters.lowCompetitionOnly || (job.score >= 62 && job.competitionScore >= 58);
      const matchesImmediate = !state.filters.startImmediateOnly || /inicio imediato|inicio imediato|início imediato|start immediately|immediate start|imediato/.test(haystack);
      return matchesTerm && matchesLocation && matchesType && matchesStrength && matchesCompetition && matchesImmediate;
    })
    .sort(sortJobs);
}

function sortJobs(a, b) {
  if (state.filters.sort === "opportunity") return b.opportunityScore - a.opportunityScore;
  if (state.filters.sort === "competition") return b.competitionScore - a.competitionScore || b.score - a.score;
  if (state.filters.sort === "recent") return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  if (state.filters.sort === "company") return String(a.company).localeCompare(String(b.company));
  return b.score - a.score;
}

function calculateCompetitionScore(job, haystack) {
  const createdAt = new Date(job.createdAt || 0);
  const ageInDays = Number.isNaN(createdAt.getTime()) ? 21 : (Date.now() - createdAt.getTime()) / 86400000;
  const recentBonus = ageInDays <= 3 ? 22 : ageInDays <= 10 ? 14 : ageInDays <= 30 ? 6 : -8;
  const nicheSourceBonus = /programathor|trampos|workana|99freelas|remoteok|arbeitnow/i.test(job.source || "") ? 12 : 0;
  const contractBonus = /freelance|contract|pj|contrato|part-time/i.test(`${job.type} ${job.title} ${job.description}`) ? 14 : 0;
  const genericPenalty = /senior|lead|principal|staff|manager/i.test(job.title || "") ? 8 : 0;
  const bigRegionPenalty = /americas|europe|asia|oceania|worldwide|anywhere/i.test(`${job.location} ${job.description}`) ? 10 : 0;
  const easyApplyPenalty = /lemon\.io|turing|crossover/i.test(`${job.company} ${job.description}`) ? 12 : 0;

  return clamp(Math.round(58 + recentBonus + nicheSourceBonus + contractBonus - genericPenalty - bigRegionPenalty - easyApplyPenalty), 12, 96);
}

function getCompetitionLabel(score) {
  if (score >= 78) return "baixa";
  if (score >= 58) return "media";
  return "alta";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function renderPlatformLinks() {
  const query = buildSearchQuery();
  const location = state.filters.location === "remote" ? "Brasil remoto" : state.filters.location;
  els.platformLinks.innerHTML = "";
  els.sourceCount.textContent = state.data.platforms.length + API_SOURCES.length;

  state.data.platforms.forEach((platform) => {
    const link = document.createElement("a");
    link.className = "platform-link";
    link.href = platform.urlTemplate
      .replaceAll("{query}", encodeURIComponent(query).replaceAll("%20", "+"))
      .replaceAll("{location}", encodeURIComponent(location).replaceAll("%20", "+"));
    link.target = "_blank";
    link.rel = "noreferrer";
    link.innerHTML = `<div><strong>${platform.name}</strong><span>${platform.type}</span></div><span>abrir</span>`;
    els.platformLinks.appendChild(link);
  });
}

function hydrateProfile() {
  const profile = state.data.profile;
  els.profileRole.textContent = profile.title || "Desenvolvedor Front-end";
  els.profileSummary.textContent = profile.summary;
  els.profileLanguages.textContent = (profile.languages || []).join(" • ");
  els.profileTags.innerHTML = (profile.preferredTerms || [])
    .slice(0, 6)
    .map((term) => `<span class="chip">${term}</span>`)
    .join("");

  if (profile.cvUrl) {
    els.cvButton.href = profile.cvUrl;
    els.cvButton.style.display = "inline-flex";
  } else {
    els.cvButton.style.display = "none";
  }

  els.searchInput.value = "";
  els.searchInput.placeholder = profile.preferredTerms.slice(0, 3).join(" ");
  state.filters.search = "";
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    setStatus("Notificacoes indisponiveis");
    return;
  }

  const permission = await Notification.requestPermission();
  setStatus(permission === "granted" ? "Notificacoes ativadas" : "Notificacoes bloqueadas");
  notifyStrongMatches();
}

function notifyStrongMatches() {
  if (Notification.permission !== "granted") return;

  const freshStrong = state.jobs.filter((job) => job.score >= 78 && !state.notifiedJobIds.has(job.id)).slice(0, 5);
  if (!freshStrong.length) return;

  freshStrong.forEach((job) => state.notifiedJobIds.add(job.id));
  localStorage.setItem("notifiedJobIds", JSON.stringify([...state.notifiedJobIds]));

  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "NEW_JOBS", count: freshStrong.length });
    return;
  }

  new Notification("Radar de Vagas", {
    body: `${freshStrong.length} vaga${freshStrong.length === 1 ? "" : "s"} com bom encaixe para o seu perfil.`,
    icon: "assets/icon.svg"
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("sw.js");
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function dedupeJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = normalizeText(`${job.title}-${job.company}-${job.url}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripHtml(value = "") {
  const doc = new DOMParser().parseFromString(value, "text/html");
  return doc.body.textContent?.replace(/\s+/g, " ").trim() || "";
}

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCandidatePitch(job, haystack) {
  const profile = state.data.profile;
  const skillCandidates = (profile.skills || profile.keywords || [])
    .filter((skill) => !/remote|remoto|pj|freelance|clt|full-time|contract|internship|estagio/i.test(skill))
    .map((skill) => ({ label: skill, token: normalizeText(skill) }));

  const matchedSkills = skillCandidates
    .filter((skill) => skill.token && haystack.includes(skill.token))
    .map((skill) => skill.label);

  const skills = Array.from(new Set(matchedSkills)).slice(0, 6);
  const featureSkills = skills.length ? skills : (profile.preferredTerms || []).slice(0, 4);
  const skillText = featureSkills.join(", ").replace(/, ([^,]*)$/, " e $1");

  const isReact = /react|reactjs/.test(haystack);
  const isAngular = /angular/.test(haystack);
  const isNext = /next|nextjs/.test(haystack);
  const isFrontend = /frontend|ui|interface|web/.test(haystack);
  const isRemote = /remote|remoto|worldwide|anywhere/.test(`${job.location} ${job.description}`);
  const isPJ = /pj|contract|freelance|autonomo|autônomo/.test(`${job.type} ${job.title} ${job.description}`);
  const isImmediate = /inicio imediato|início imediato|start immediately|immediate start|inmediato|imediato/.test(haystack);

  let roleFocus = "soluções web sólidas com integrações de API e experiência de usuário";
  if (isReact) {
    roleFocus = "projetos React escaláveis com foco em componentes reutilizáveis e desempenho";
  } else if (isNext) {
    roleFocus = "aplicações Next.js com entrega rápida, SEO otimizado e experiência de usuário moderna";
  } else if (isAngular) {
    roleFocus = "aplicações Angular robustas com arquitetura modular e continuidade de produto";
  } else if (isFrontend) {
    roleFocus = "interfaces web modernas e experiências responsivas";
  }

  const extraNote = [];
  if (isRemote) {
    extraNote.push("trabalho remoto com disciplina, comunicação proativa e foco em entregas");
  }
  if (isPJ) {
    extraNote.push("experiência em projetos PJ/freelance com autonomia e entrega dentro do prazo");
  }
  if (isImmediate) {
    extraNote.push("estou disponível para início imediato e pronto para começar assim que precisar");
  }

  const extraText = extraNote.length ? ` ${extraNote.join(" e ")}.` : "";

  return `Como candidato para esta vaga, com 2-3 anos de experiência no mercado, posso contribuir com minha experiência em ${skillText}, entregando ${roleFocus} e mantendo foco em qualidade, produtividade e comunicação clara com o time.${extraText}`;
}

function formatDate(value) {
  if (!value) return "recente";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recente";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(date);
}

function setStatus(message) {
  els.syncStatus.textContent = message;
}
