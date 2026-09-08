const $ = (selector, root = document) => root.querySelector(selector);
const won = (value) => `${new Intl.NumberFormat("ko-KR", {maximumFractionDigits: 0}).format(value)}원`;
const number = (value, digits = 0) => new Intl.NumberFormat("ko-KR", {maximumFractionDigits: digits}).format(value);
const monthLabel = (month) => `${Number(month.slice(5))}월`;
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;"})[character]);
const app = $("#app");
const searchForm = $("#location-search-form");
const searchButton = $("button[type='submit']", searchForm);
const searchStatus = $("#location-search-status");
const locationResults = $("#location-results");
const sampleButton = $("#sample-location");
const progressSection = $("#progress");
const progressTitle = $("#progress-title");
const progressList = $("#progress-steps");
const capacityTabs = $("#capacity-tabs");
const localHosts = ["127.0.0.1", "localhost"];
const usesStaticServices = new URLSearchParams(window.location.search).has("static")
  || window.location.protocol === "file:"
  || !localHosts.includes(window.location.hostname);
const locationSearchCache = new Map();
const demoDataUrls = ["data/demo.json", "../data/demo.json"];
const progressStepLabels = ["주소 위치 확인", "지난해 시간별 날씨 분석", "설치 용량별 절감 효과 비교"];
let baseDemoData = null;
let currentData = null;
let selectedCapacity = null;
let lastLocationSearchAt = 0;

function availableCapacities(data) {
  return data.capacities.map((item) => item.capacity_kwp);
}

function activeCapacity(data) {
  return availableCapacities(data).includes(selectedCapacity) ? selectedCapacity : data.recommendation.capacity_kwp;
}

function scenarioFor(data, capacityKwp) {
  return data.capacities.find((item) => item.capacity_kwp === capacityKwp) || data.capacities[0];
}

function selectedScenario(data) {
  return scenarioFor(data, activeCapacity(data));
}

function renderProgress(activeIndex) {
  progressSection.hidden = false;
  progressTitle.textContent = activeIndex >= progressStepLabels.length
    ? "계산 완료 — 우리 집 예상 절감액을 구했어요"
    : "우리 집 태양광 절감 효과를 계산하고 있어요";
  progressList.innerHTML = progressStepLabels.map((label, index) => {
    const state = index < activeIndex ? "is-done" : index === activeIndex ? "is-active" : "";
    const icon = index < activeIndex ? "✓" : index === activeIndex ? "" : String(index + 1);
    const status = index < activeIndex ? "완료" : index === activeIndex ? "확인 중…" : "대기";
    return `<li class="progress-step ${state}"><span class="progress-icon" aria-hidden="true">${icon}</span><strong>${escapeHtml(label)}</strong><small>${status}</small></li>`;
  }).join("");
}

const rounded = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

function usageThresholds(month) {
  return [7, 8].includes(Number(month.slice(5))) ? [300, 450] : [200, 400];
}

function chargeFor(data, usageKwh, month) {
  const kwh = Math.max(0, usageKwh);
  const [first, second] = usageThresholds(month);
  const rates = data.sources.tariff.rates_won_per_kwh;
  const basics = data.sources.tariff.basic_won;
  const tier = kwh === 0 ? 0 : kwh <= first ? 1 : kwh <= second ? 2 : 3;
  const energy = Math.min(kwh, first) * rates[0]
    + Math.min(Math.max(kwh - first, 0), second - first) * rates[1]
    + Math.max(kwh - second, 0) * rates[2];
  const basic = tier ? basics[tier - 1] : 0;
  return {tier, basic_won: Math.round(basic), energy_won: Math.round(energy), total_won: Math.round(basic + energy)};
}

function summarizeWeather(weatherPayload, expectedMonths) {
  const expected = new Set(expectedMonths);
  const monthly = new Map(expectedMonths.map((month) => [month, {sunlight:0, temperature:0, temperatureCount:0, cloud:0, cloudCount:0}]));
  const hourly = weatherPayload.hourly || {};
  (hourly.time || []).forEach((timestamp, index) => {
    const month = timestamp.slice(0, 7);
    if (!expected.has(month)) return;
    const item = monthly.get(month);
    item.sunlight += Math.max(0, Number(hourly.global_tilted_irradiance?.[index] || 0)) / 1000;
    if (hourly.temperature_2m?.[index] != null) {
      item.temperature += Number(hourly.temperature_2m[index]);
      item.temperatureCount += 1;
    }
    if (hourly.cloud_cover?.[index] != null) {
      item.cloud += Number(hourly.cloud_cover[index]);
      item.cloudCount += 1;
    }
  });
  return expectedMonths.map((month) => {
    const item = monthly.get(month);
    if (!item.temperatureCount || !item.cloudCount) throw new Error("지난 1년 기상자료가 충분하지 않습니다.");
    return {
      month,
      sunlight_kwh_m2: rounded(item.sunlight, 1),
      average_temperature_c: rounded(item.temperature / item.temperatureCount, 1),
      average_cloud_cover_percent: rounded(item.cloud / item.cloudCount, 1),
    };
  });
}

function capacityScenario(data, monthlySunlight, capacityKwp) {
  const homeMonths = data.capacities[0].months;
  const sunlightByMonth = Object.fromEntries(monthlySunlight.map((item) => [item.month, item.sunlight_kwh_m2]));
  let creditKwh = 0;
  const months = homeMonths.map((baseMonth) => {
    const sunlightKwhM2 = sunlightByMonth[baseMonth.month];
    const solarKwh = sunlightKwhM2 * capacityKwp * 0.82 * 0.82;
    const availableKwh = solarKwh + creditKwh;
    const netMeteredKwh = Math.max(0, baseMonth.home_use_kwh - availableKwh);
    const creditOutKwh = Math.max(0, availableKwh - baseMonth.home_use_kwh);
    const before = chargeFor(data, baseMonth.home_use_kwh, baseMonth.month);
    const after = chargeFor(data, netMeteredKwh, baseMonth.month);
    const result = {
      month: baseMonth.month,
      home_use_kwh: rounded(baseMonth.home_use_kwh, 1),
      sunlight_kwh_m2: sunlightKwhM2,
      solar_kwh: rounded(solarKwh, 1),
      credit_in_kwh: rounded(creditKwh, 1),
      net_metered_kwh: rounded(netMeteredKwh, 1),
      credit_out_kwh: rounded(creditOutKwh, 1),
      before,
      after,
      saved_won: before.total_won - after.total_won,
    };
    creditKwh = creditOutKwh;
    return result;
  });
  const annual = {
    home_use_kwh: rounded(months.reduce((sum, item) => sum + item.home_use_kwh, 0), 1),
    solar_kwh: rounded(months.reduce((sum, item) => sum + item.solar_kwh, 0), 1),
    before_won: months.reduce((sum, item) => sum + item.before.total_won, 0),
    after_won: months.reduce((sum, item) => sum + item.after.total_won, 0),
    credit_at_period_end_kwh: rounded(creditKwh, 1),
  };
  annual.saved_won = annual.before_won - annual.after_won;
  const tierDrops = months.filter((item) => item.before.tier > item.after.tier);
  annual.tier_drop_months = tierDrops.length;
  annual.third_to_second_months = tierDrops.filter((item) => item.before.tier === 3 && item.after.tier === 2).length;
  annual.third_to_first_months = tierDrops.filter((item) => item.before.tier === 3 && item.after.tier === 1).length;
  annual.savings_breakdown = savingsBreakdown(data, {months, annual:{}});
  return {capacity_kwp: capacityKwp, months, annual};
}

function locationPayload(baseData, location, weatherUrl, weatherPayload) {
  const expectedMonths = baseData.capacities[0].months.map((item) => item.month);
  const monthlySunlight = summarizeWeather(weatherPayload, expectedMonths);
  const capacities = baseData.capacities.map((item) => capacityScenario(baseData, monthlySunlight, item.capacity_kwp));
  const annualUse = capacities[0].annual.home_use_kwh;
  const balanced = capacities.filter((item) => item.annual.credit_at_period_end_kwh <= 0.1);
  const recommended = (balanced.length ? balanced : capacities).reduce((best, item) =>
    Math.abs(item.annual.solar_kwh - annualUse) < Math.abs(best.annual.solar_kwh - annualUse) ? item : best
  );
  const highlight = recommended.months.find((item) => item.before.tier === 3 && item.after.tier === 2)
    || recommended.months.find((item) => item.before.tier > item.after.tier)
    || recommended.months[0];
  const payload = typeof structuredClone === "function" ? structuredClone(baseData) : JSON.parse(JSON.stringify(baseData));
  payload.generated_at = new Date().toISOString();
  payload.location = {...location, description:"검색해 선택한 위치입니다. 주소 검색어와 검색 결과는 이 시제품에 저장하지 않습니다."};
  payload.input_summary.address = `${location.label} · 검색해 선택한 위치`;
  payload.input_summary.sunlight = "검색한 위치의 지난 1년 일사량·기온·구름량을 월별로 합산";
  payload.sources.weather = {provider:"Open-Meteo Archive API", request_url:weatherUrl, fetched_at:new Date().toISOString(), interpretation:"검색해 선택한 위치의 지난 1년 기상·일사량 입력"};
  payload.data_receipt.weather_hours = weatherPayload.hourly?.time?.length || 0;
  payload.monthly_sunlight = monthlySunlight;
  payload.capacities = capacities;
  payload.recommendation = {
    capacity_kwp: recommended.capacity_kwp,
    title: `${recommended.capacity_kwp}kW를 먼저 살펴보세요`,
    reason: "지난 1년 사용량과 가장 균형이 맞고, 계산 기간이 끝난 뒤 남는 전기도 없습니다.",
    highlight_month: highlight.month,
    highlight_before_tier: highlight.before.tier,
    highlight_after_tier: highlight.after.tier,
  };
  return payload;
}

function renderBars(target, items, firstKey, secondKey, type) {
  const maximum = Math.max(...items.flatMap((item) => secondKey ? [item[firstKey], item[secondKey]] : [item[firstKey]]), 1);
  target.innerHTML = items.map((item) => {
    const first = Math.max(3, item[firstKey] / maximum * 100);
    const second = secondKey ? Math.max(3, item[secondKey] / maximum * 100) : 0;
    const label = monthLabel(item.month);
    if (type === "bill") return `<div class="month-bars" title="${label}: 설치 전 ${won(item[firstKey])}, 설치 후 ${won(item[secondKey])}"><div class="pair"><i class="before" style="height:${first}%"></i><i class="after" style="height:${second}%"></i></div><small>${label}</small></div>`;
    return `<div class="month-bars" title="${label}: ${number(item[firstKey], 1)} kWh/㎡"><div class="single"><i style="height:${first}%"></i></div><small>${label}</small></div>`;
  }).join("");
}

function tierSentence(scenario) {
  const month = scenario.months.find((item) => item.before.tier > item.after.tier);
  if (!month) return "설치 전후의 전기요금 단계 변화를 월별로 다시 계산했어요.";
  if (month.after.tier === 0) {
    return `작년 ${monthLabel(month.month)}에는 전기요금 ${month.before.tier}단계였지만, ${scenario.capacity_kwp}kW 태양광이 있었다면 단계 요금이 적용되지 않는 수준으로 예상돼요.`;
  }
  return `작년 ${monthLabel(month.month)}에는 전기요금 ${month.before.tier}단계였지만, ${scenario.capacity_kwp}kW 태양광이 있었다면 ${month.after.tier}단계로 예상돼요.`;
}

function renderHero(data, recommendation) {
  const recommended = scenarioFor(data, recommendation.capacity_kwp);
  const annual = recommended.annual;
  $("#hero-capacity").textContent = `${recommendation.capacity_kwp}kW`;
  $("#hero-missed").textContent = won(annual.saved_won);
  $("#hero-monthly").textContent = won(annual.saved_won / 12);
  $("#hero-rate").textContent = `${number(annual.saved_won / annual.before_won * 100, 1)}%`;
}

function renderSummary(data, recommendation) {
  const recommended = scenarioFor(data, recommendation.capacity_kwp);
  const recommendedAnnual = recommended.annual;
  $("#summary-capacity").textContent = `${recommendation.capacity_kwp}kW`;
  $("#summary-saved").textContent = won(recommendedAnnual.saved_won);
  $("#summary-rate").textContent = `${number(recommendedAnnual.saved_won / recommendedAnnual.before_won * 100, 1)}%`;
  $("#summary-before").textContent = won(recommendedAnnual.before_won);
  $("#summary-reason").textContent = `${recommendation.capacity_kwp}kW를 설치했다고 가정한 결과예요. ${tierSentence(recommended)}`;
  $("#sample-badge").textContent = data.input_summary.home_use.includes("시연용")
    ? "시제품 계산 · 전기 사용량 샘플 적용 중"
    : "입력한 전기 사용량 기준";
  $("#result-cards").innerHTML = data.capacities.map((item) => {
    const isRecommended = item.capacity_kwp === recommendation.capacity_kwp;
    return `<div class="compare-item ${isRecommended ? "is-recommended" : ""}"><span>${item.capacity_kwp}kW${isRecommended ? " · 절감 효율 균형" : ""}</span><strong>연 ${won(item.annual.saved_won)}</strong></div>`;
  }).join("");
}

function renderCapacityTabs(data) {
  const active = activeCapacity(data);
  const capacities = availableCapacities(data);
  const activeIndex = capacities.indexOf(active);
  capacityTabs.style.setProperty("--selector-position", `${(activeIndex + 0.5) / capacities.length * 100}%`);
  capacityTabs.innerHTML = data.capacities.map((item) => {
    const isActive = item.capacity_kwp === active;
    const isRecommended = item.capacity_kwp === data.recommendation.capacity_kwp;
    return `<button type="button" class="capacity-tab" role="tab" id="capacity-tab-${item.capacity_kwp}" aria-selected="${isActive}" aria-controls="capacity-panel" tabindex="${isActive ? 0 : -1}" data-capacity="${item.capacity_kwp}"><strong>${item.capacity_kwp}kW</strong><small aria-hidden="true">${isRecommended ? "추천" : "&nbsp;"}</small></button>`;
  }).join("");
  $("#capacity-panel").setAttribute("aria-labelledby", `capacity-tab-${active}`);
}

function renderCapacityMetrics(scenario) {
  const annual = scenario.annual;
  $("#capacity-metrics").innerHTML = [
    {label:"지난 1년 예상 발전량", value:`${number(annual.solar_kwh)} kWh`},
    {label:"설치 후 연간 전기요금", value:won(annual.after_won)},
    {label:"연간 예상 절감액", value:won(annual.saved_won), tone:"is-saving"},
    {label:"계산 기간 종료 후 남는 전기", value:`${number(annual.credit_at_period_end_kwh)} kWh`},
  ].map((item) => `<div class="capacity-metric ${item.tone || ""}"><span>${escapeHtml(item.label)}</span><strong>${item.value}</strong></div>`).join("");
}

function renderDeltas(data) {
  const sorted = [...data.capacities].sort((a, b) => a.capacity_kwp - b.capacity_kwp);
  const steps = sorted.slice(1).map((item, index) => {
    const previous = sorted[index];
    const gap = item.capacity_kwp - previous.capacity_kwp;
    return {
      from: previous.capacity_kwp,
      to: item.capacity_kwp,
      perKw: (item.annual.saved_won - previous.annual.saved_won) / gap,
      credit: item.annual.credit_at_period_end_kwh,
    };
  });
  $("#capacity-deltas").innerHTML = steps.map((step) => `<div class="delta-item"><span>${step.from}kW → ${step.to}kW</span><strong>연 +${won(step.perKw)}</strong><small>용량 1kW가 늘 때 늘어나는 연 절감액</small></div>`).join("");
  const last = steps[steps.length - 1];
  $("#delta-note").textContent = last && last.perKw < steps[0].perKw
    ? `${last.to}kW는 발전량은 늘지만 1kW당 추가 절감액이 ${won(last.perKw)}로 줄고, 계산 기간이 끝난 뒤 ${number(last.credit)}kWh가 남습니다. 같은 1kW를 더 설치해도 절감액 증가폭은 달라질 수 있어요.`
    : "설치 용량이 커질수록 늘어나는 연간 절감액을 함께 비교해 보세요.";
}

function selectCapacity(capacityKwp) {
  if (!currentData) return;
  selectedCapacity = capacityKwp;
  render(currentData);
  const tab = $(`#capacity-tab-${capacityKwp}`);
  if (tab) tab.focus();
}

function savingsBreakdown(data, scenario) {
  if (scenario.annual.savings_breakdown) return scenario.annual.savings_breakdown;
  const baseRate = data.sources.tariff.rates_won_per_kwh[0];
  return scenario.months.reduce((totals, month) => {
    const coveredKwh = Math.max(0, month.home_use_kwh - month.net_metered_kwh);
    const baseEnergyWon = Math.round(coveredKwh * baseRate);
    const energySaved = month.before.energy_won - month.after.energy_won;
    totals.base_energy_won += baseEnergyWon;
    totals.progressive_energy_won += energySaved - baseEnergyWon;
    totals.basic_charge_won += month.before.basic_won - month.after.basic_won;
    totals.total_won += month.before.total_won - month.after.total_won;
    return totals;
  }, {base_energy_won: 0, progressive_energy_won: 0, basic_charge_won: 0, total_won: 0});
}

function renderSavingsBreakdown(data, scenario) {
  const breakdown = savingsBreakdown(data, scenario);
  const parts = [
    {key:"base_energy_won", className:"base", label:"태양광 전기를 사용해서 줄어든 금액", note:"한전에서 덜 산 전기를 1단계 단가로 계산", color:"#f5c651"},
    {key:"progressive_energy_won", className:"progressive", label:"비싼 전기요금 단계에 들어가는 시기를 늦춘 효과", note:"2·3단계의 더 높은 전력량요금을 피한 금액", color:"#df8c35"},
    {key:"basic_charge_won", className:"basic", label:"사용량이 낮아져 줄어든 기본요금", note:`전기요금 단계가 낮아진 ${scenario.annual.tier_drop_months}개월의 기본요금 차이`, color:"#2b795a"},
  ];
  $("#savings-total").textContent = `연 ${won(breakdown.total_won)} 절감`;
  $("#benefit-stack").innerHTML = parts.map((part) => `<span class="${part.className}" style="width:${Math.max(0, breakdown[part.key]) / Math.max(1, breakdown.total_won) * 100}%" title="${escapeHtml(part.label)} ${won(breakdown[part.key])}"></span>`).join("");
  $("#benefit-items").innerHTML = parts.map((part) => `<div class="benefit-item" style="--item-color:${part.color}"><span>${escapeHtml(part.label)}</span><strong>${won(breakdown[part.key])}</strong><small>${escapeHtml(part.note)}</small></div>`).join("");
  $("#breakdown-note").textContent = "세 금액의 합이 위 절감액입니다. 같은 효과를 다시 더하지 않았고, 한전에 보내고 남은 전기는 판매수익이 아니라 다음 달 전기사용량을 줄이는 것으로 계산했습니다.";
}

function render(data) {
  currentData = data;
  selectedCapacity = activeCapacity(data);
  const scenario = selectedScenario(data);
  const annual = scenario.annual;
  const recommendation = data.recommendation;
  const billMonths = scenario.months.map((item) => ({...item, before_won: item.before.total_won, after_won: item.after.total_won}));
  const receipt = data.data_receipt;
  const gridPurchaseKwh = annual.home_use_kwh - annual.solar_kwh + annual.credit_at_period_end_kwh;
  const solarCoveredKwh = annual.home_use_kwh - gridPurchaseKwh;
  const annualSunlight = data.monthly_sunlight.reduce((total, item) => total + item.sunlight_kwh_m2, 0);
  const averageTemperature = data.monthly_sunlight.reduce((total, item) => total + item.average_temperature_c, 0) / data.monthly_sunlight.length;
  const averageCloud = data.monthly_sunlight.reduce((total, item) => total + item.average_cloud_cover_percent, 0) / data.monthly_sunlight.length;
  $("#demo-notice").textContent = data.demo_notice;
  $("#address-value").textContent = data.input_summary.address;
  $("#location-badge").textContent = data.input_summary.address.includes("검색해 선택한 위치") ? "검색한 위치" : "시연용 예시";
  $("#location-description").textContent = data.location.description;
  $("#period-label").textContent = data.period.label;
  $("#receipt-grid").innerHTML = [
    {value:`${number(receipt.weather_hours)}시간`, label:"검색 위치의 지난 날씨", note:`${receipt.weather_variables}을 ${receipt.weather_interval} 확인`},
    {value:"12개월", label:"우리 집 전기사용", note:`공식 ${receipt.ami_interval} AMI 원본 ${receipt.ami_sample_days}일을 참고한 시연용 샘플`},
    {value:`${receipt.billing_months}번`, label:"공개 요금 기준 재계산", note:"남는 전기를 다음 달에 반영하고 전기요금 단계도 함께 계산"},
  ].map((item) => `<div><strong>${item.value}</strong><span>${item.label}</span><small>${item.note}</small></div>`).join("");
  $("#flow-grid").innerHTML = [
    {icon:"☀", label:"지난 햇빛", value:`${number(annualSunlight)} kWh/㎡`, note:"태양광 발전량 계산의 기준이에요"},
    {icon:"℃", label:"평균 기온", value:`${number(averageTemperature, 1)}℃`, note:"같은 기간의 주소별 날씨예요"},
    {icon:"☁", label:"평균 구름량", value:`${number(averageCloud)}%`, note:"같은 기간의 주소별 날씨예요"},
  ].map((card) => `<article class="flow-card"><span class="flow-icon" aria-hidden="true">${card.icon}</span><p>${card.label}</p><strong>${card.value}</strong><small>${card.note}</small></article>`).join("");
  renderBars($("#sunlight-chart"), data.monthly_sunlight, "sunlight_kwh_m2", null, "sunlight");
  $("#bill-chart-title").textContent = `${scenario.capacity_kwp}kW 설치 전후, 작년 우리 집 전기요금`;
  renderBars($("#bill-chart"), billMonths, "before_won", "after_won", "bill");
  $("#numbers-detail").innerHTML = `<div class="number-grid"><div><span>작년 우리 집 사용</span><strong>${number(annual.home_use_kwh)} kWh</strong></div><div><span>태양광이 채운 전기</span><strong>${number(solarCoveredKwh)} kWh</strong></div><div><span>한전에서 계속 산 전기</span><strong>${number(gridPurchaseKwh)} kWh</strong></div><div><span>작년 전기요금 기준</span><strong>${won(annual.before_won)}</strong></div><div><span>설치 후 예상</span><strong>${won(annual.after_won)}</strong></div><div><span>1년 예상 절감</span><strong>${won(annual.saved_won)}</strong></div></div>`;
  $("#monthly-detail").innerHTML = `<table><caption>${scenario.capacity_kwp}kW 설치 가정 월별 계산값</caption><thead><tr><th>월</th><th>전기 사용</th><th>예상 발전</th><th>설치 전 요금</th><th>설치 후 요금</th><th>예상 절감</th></tr></thead><tbody>${scenario.months.map((item) => `<tr><th>${monthLabel(item.month)}</th><td>${number(item.home_use_kwh)} kWh</td><td>${number(item.solar_kwh)} kWh</td><td>${won(item.before.total_won)}</td><td>${won(item.after.total_won)}</td><td>${won(item.saved_won)}</td></tr>`).join("")}</tbody></table>`;
  renderHero(data, recommendation);
  renderSummary(data, recommendation);
  renderCapacityTabs(data);
  renderCapacityMetrics(scenario);
  renderDeltas(data);
  renderSavingsBreakdown(data, scenario);
  $("#calculation-scope").textContent = data.calculation_scope;
  $("#basis-intro").textContent = data.demo_notice;
  $("#basis-list").innerHTML = `<dt>우리 집 위치</dt><dd>${escapeHtml(data.input_summary.address)}</dd><dt>지난 날씨</dt><dd>${escapeHtml(data.input_summary.sunlight)}</dd><dt>전기 사용량</dt><dd>${escapeHtml(data.input_summary.home_use)}</dd><dt>요금 계산</dt><dd>${escapeHtml(data.input_summary.tariff)}</dd><dt>요금표</dt><dd>${escapeHtml(data.sources.tariff.label)} · 1·2·3단계 ${data.sources.tariff.rates_won_per_kwh.join(" / ")}원/kWh</dd><dt>출처</dt><dd><a href="${escapeHtml(data.sources.tariff.source_url)}" target="_blank" rel="noreferrer">${escapeHtml(data.sources.tariff.source)}</a> · 지난 날씨 ${escapeHtml(data.sources.weather.provider)}</dd>`;
  $("#basis-note").textContent = data.actual_service_scope;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "요청을 처리하지 못했습니다.");
  return data;
}

async function searchLocations(query) {
  if (!usesStaticServices) return postJson("/api/location-search", {query});
  const normalized = query.replace(/\s+/g, " ").trim();
  if (normalized.length < 2 || normalized.length > 100) throw new Error("동·읍·면, 도시 또는 주소를 두 글자 이상 입력해 주세요.");
  if (locationSearchCache.has(normalized)) return locationSearchCache.get(normalized);
  const waitMs = Math.max(0, 1050 - (Date.now() - lastLocationSearchAt));
  if (waitMs) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
  const params = new URLSearchParams({q:normalized, format:"jsonv2", countrycodes:"kr", limit:"5", "accept-language":"ko"});
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  lastLocationSearchAt = Date.now();
  if (!response.ok) throw new Error("위치검색 서비스에 잠시 연결할 수 없습니다.");
  const rawResults = await response.json();
  const result = {
    results: rawResults.map((item) => ({label:String(item.display_name).slice(0, 180), latitude:rounded(item.lat, 6), longitude:rounded(item.lon, 6)}))
      .filter((item) => item.latitude >= 32.5 && item.latitude <= 39.5 && item.longitude >= 124 && item.longitude <= 132),
    attribution: "OpenStreetMap contributors",
  };
  locationSearchCache.set(normalized, result);
  return result;
}

async function previewLocation(result) {
  if (!usesStaticServices) return postJson("/api/location-preview", result);
  if (!baseDemoData) throw new Error("시연 데이터를 아직 불러오지 못했습니다.");
  const params = new URLSearchParams({
    latitude:String(result.latitude), longitude:String(result.longitude),
    start_date:baseDemoData.period.start, end_date:baseDemoData.period.end,
    hourly:"global_tilted_irradiance,shortwave_radiation,temperature_2m,cloud_cover",
    tilt:"26", azimuth:"0", timezone:"Asia/Seoul",
  });
  const weatherUrl = `https://archive-api.open-meteo.com/v1/archive?${params}`;
  const response = await fetch(weatherUrl);
  const weather = await response.json();
  if (!response.ok || weather.error) throw new Error(weather.reason || "지난 날씨를 불러오지 못했습니다.");
  return locationPayload(baseDemoData, result, weatherUrl, weather);
}

async function selectLocation(result, button) {
  searchButton.disabled = true;
  if (sampleButton) sampleButton.disabled = true;
  locationResults.querySelectorAll("button").forEach((item) => { item.disabled = true; });
  if (button) button.textContent = "이 위치의 지난 1년을 계산하고 있어요…";
  searchStatus.textContent = "검색 위치의 지난해 날씨와 전기 사용량을 함께 계산하고 있어요…";
  renderProgress(1);
  try {
    const data = await previewLocation(result);
    renderProgress(2);
    selectedCapacity = null;
    render(data);
    renderProgress(progressStepLabels.length);
    locationResults.hidden = true;
    searchStatus.textContent = "계산이 끝났습니다. 아래에서 결과를 확인해 보세요.";
    const resultTitle = $("#result-title");
    resultTitle.focus({preventScroll:true});
    resultTitle.scrollIntoView({behavior:"smooth", block:"start"});
  } catch (error) {
    searchStatus.textContent = error.message;
    progressSection.hidden = true;
    if (button) button.textContent = result.label;
  } finally {
    searchButton.disabled = false;
    if (sampleButton) sampleButton.disabled = false;
    locationResults.querySelectorAll("button").forEach((item) => { item.disabled = false; });
  }
}

capacityTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-capacity]");
  if (button) selectCapacity(Number(button.dataset.capacity));
});

capacityTabs.addEventListener("keydown", (event) => {
  if (!currentData) return;
  const capacities = availableCapacities(currentData);
  const index = capacities.indexOf(activeCapacity(currentData));
  const keys = {ArrowRight:1, ArrowDown:1, ArrowLeft:-1, ArrowUp:-1};
  if (keys[event.key]) {
    event.preventDefault();
    selectCapacity(capacities[(index + keys[event.key] + capacities.length) % capacities.length]);
  }
  if (event.key === "Home") { event.preventDefault(); selectCapacity(capacities[0]); }
  if (event.key === "End") { event.preventDefault(); selectCapacity(capacities[capacities.length - 1]); }
});

if (sampleButton) sampleButton.addEventListener("click", () => {
  if (!baseDemoData) return;
  const location = baseDemoData.location;
  searchStatus.textContent = "예시 주소의 지난해 날씨를 다시 불러오고 있어요…";
  renderProgress(0);
  selectLocation({label:location.label, latitude:location.latitude, longitude:location.longitude}, null);
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("#address-query").value.trim();
  locationResults.hidden = true;
  locationResults.replaceChildren();
  searchButton.disabled = true;
  searchStatus.textContent = "검색할 위치를 확인하고 있어요…";
  renderProgress(0);
  try {
    const data = await searchLocations(query);
    if (!data.results.length) {
      searchStatus.textContent = "검색 결과가 없습니다. 동·읍·면이나 가까운 장소 이름으로 다시 찾아보세요.";
      progressSection.hidden = true;
      return;
    }
    data.results.forEach((result) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = result.label;
      button.addEventListener("click", () => selectLocation(result, button));
      locationResults.append(button);
    });
    const attribution = document.createElement("div");
    attribution.className = "location-attribution";
    attribution.innerHTML = `위치검색 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">${escapeHtml(data.attribution.replace(/^위치검색 © /, ""))}</a>`;
    locationResults.append(attribution);
    locationResults.hidden = false;
    if (data.results.length === 1) {
      await selectLocation(data.results[0], locationResults.querySelector("button"));
      return;
    }
    searchStatus.textContent = "같은 이름의 위치가 여러 곳이에요. 계산할 위치를 선택해 주세요.";
  } catch (error) {
    searchStatus.textContent = error.message;
    progressSection.hidden = true;
  } finally {
    searchButton.disabled = false;
  }
});

async function loadDemoData() {
  for (const url of demoDataUrls) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      // 다음 경로로 계속 시도합니다.
    }
  }
  throw new Error("시연용 자료를 찾지 못했습니다.");
}

loadDemoData()
  .then((data) => {
    baseDemoData = data;
    render(data);
    $("#loading").hidden = true;
    app.hidden = false;
    if (window.location.hash) {
      const target = document.querySelector(window.location.hash);
      if (target) requestAnimationFrame(() => target.scrollIntoView({behavior:"instant", block:"start"}));
    }
  })
  .catch(() => { $("#loading").hidden = true; $("#error").hidden = false; $("#error").textContent = "시연용 데이터를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요."; });
