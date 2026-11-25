"use strict";

const DAY_MS = 86_400_000;
const DAILY_RATE = 25_000;
const LODGING_LIMITS = { seoul: 100_000, metro: 80_000, other: 70_000 };
const REGION_NAMES = { seoul: "서울특별시", metro: "광역시", other: "그 밖의 지역" };
const TRANSPORT_NAMES = { train: "철도", bus: "버스", air: "항공", ship: "선박" };
const won = (amount) => amount.toLocaleString("ko-KR") + "원";

function insideAllowance(minutes, vehicle) {
  const base = minutes >= 240 ? 20_000 : 10_000;
  if (vehicle === "assigned") return { amount: 0, basis: "전용 차량 배정자" };

  const basis = minutes >= 240 ? "4시간 이상" : "4시간 미만";
  if (vehicle === "official") {
    return { amount: base - 10_000, basis: basis + " · 공무용 차량 이용 등 10,000원 감액" };
  }
  return { amount: base, basis };
}

function transportGrade(transport, grade) {
  if (transport === "train") return grade === "first" ? "특실" : "일반실";
  if (transport === "ship") return grade === "first" ? "1등급" : "2등급";
  return "";
}

function outsideFare(trip) {
  if (trip.transport === "official") return { amount: 0, basis: "공용 교통수단 이용" };
  if (trip.transport === "car" && trip.necessaryCar) {
    return {
      amount: trip.fuel + trip.toll,
      basis: "인정 연료비 " + won(trip.fuel) + " + 인정 통행료 " + won(trip.toll)
    };
  }

  const mode = trip.transport === "car" ? trip.referenceTransport : trip.transport;
  const grade = transportGrade(mode, trip.grade);
  const modeLabel = TRANSPORT_NAMES[mode] + (grade ? " " + grade : "");
  const basis = trip.transport === "car" ? "자가용 · 왕복 " + modeLabel + " 기준" : modeLabel + " · 지급 대상 왕복 운임";
  return { amount: trip.fare, basis };
}

function lodgingAllowance(night, grade) {
  if (grade === "first") return { amount: night.cost, basis: "실비 " + won(night.cost) };

  const limit = LODGING_LIMITS[night.region];
  const ceiling = night.extra ? limit + limit * 0.3 : limit;
  const amount = Math.min(ceiling, night.cost);
  let basis = REGION_NAMES[night.region] + " · 결제 " + won(night.cost) + " · 기본 상한 " + won(limit);
  if (night.extra && amount > limit) basis += " · 추가 지급 " + won(amount - limit) + " 반영";
  return { amount, basis, extraApplied: amount > limit };
}

function outsideAllowances(trip) {
  const fullDays = trip.days - trip.reducedDays;
  const halfRate = DAILY_RATE / 2;
  const dayBasis = trip.reducedDays
    ? won(DAILY_RATE) + " × " + fullDays + "일 + " + won(halfRate) + " × " + trip.reducedDays + "일"
    : won(DAILY_RATE) + " × " + trip.days + "일";
  const lodging = trip.nights.map((night) => lodgingAllowance(night, trip.grade));
  const rows = [
    { name: "운임", ...outsideFare(trip) },
    { name: "일비", amount: DAILY_RATE * fullDays + halfRate * trip.reducedDays, basis: dayBasis },
    {
      name: "숙박비",
      amount: lodging.reduce((sum, night) => sum + night.amount, 0),
      basis: lodging.length ? lodging.map((night) => night.basis).join(" / ") : "지급 대상 숙박 없음"
    },
    { name: "식비", amount: DAILY_RATE * trip.mealDays, basis: won(DAILY_RATE) + " × " + trip.mealDays + "일" }
  ];
  const notes = [];
  if (lodging.some((night) => night.extraApplied)) {
    notes.push("숙박비 추가 지급은 출장 종료 다음 날부터 1주 이내에 증빙을 갖춰 정산을 신청해야 합니다.");
  }
  if (trip.days >= 17) notes.push("같은 곳에 장기 체재했다면 제17조의 일비 감액을 별도로 확인하세요.");
  if (trip.mileage) notes.push("공적 항공마일리지 사용에 따른 일비 추가 지급액은 합계에 포함되지 않았습니다.");
  if (trip.grade === "first") notes.push("대통령과 국무총리의 일비·식비 실비 특례는 별도 확인이 필요합니다.");
  return { rows, notes };
}

function init() {
  const get = (id) => document.getElementById(id);
  const form = get("trip-form");
  const departure = get("departure");
  const returnDate = get("return-date");
  const details = get("details");
  const nights = get("nights");
  const carol = get("carol");
  const musicPlay = get("music-play");
  const musicStop = get("music-stop");
  let returnEdited = false;
  let currentResult = null;

  function updateMusicControls() {
    musicPlay.disabled = !carol.paused;
    musicStop.disabled = carol.paused;
    get("music-status").textContent = carol.paused ? "징글벨" : "징글벨 재생 중";
  }

  musicPlay.addEventListener("click", async () => {
    try {
      await carol.play();
    } catch (error) {
      updateMusicControls();
      if (error.name !== "AbortError") get("music-status").textContent = "음악을 재생할 수 없습니다.";
    }
  });
  musicStop.addEventListener("click", () => {
    carol.pause();
    carol.currentTime = 0;
  });
  carol.addEventListener("play", updateMusicControls);
  carol.addEventListener("pause", updateMusicControls);

  const isInside = () => form.elements["trip-type"].value === "inside";
  const tripDays = () => {
    const days = (returnDate.valueAsNumber - departure.valueAsNumber) / DAY_MS + 1;
    return Number.isSafeInteger(days) && days >= 1 ? days : 0;
  };

  function showMessage(id, message) {
    const element = get(id);
    element.textContent = message;
    element.hidden = !message;
  }

  function dateError(requireBoth = false) {
    if (requireBoth && (!departure.value || !returnDate.value)) return "출발일과 복귀일을 입력하세요.";
    if (departure.value && returnDate.value && !tripDays()) return "복귀일은 출발일과 같거나 이후여야 합니다.";
    return "";
  }

  function travelMinutes() {
    const start = get("start-time").valueAsNumber;
    const end = get("end-time").valueAsNumber;
    return (tripDays() - 1) * 24 * 60 + (end - start) / 60_000;
  }

  function durationLabel(minutes) {
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    return (hours ? hours + "시간" : "") + (remaining || !hours ? (hours ? " " : "") + remaining + "분" : "");
  }

  function updateDates() {
    const error = dateError();
    const days = tripDays();
    showMessage("date-error", error);
    returnDate.setAttribute("aria-invalid", String(Boolean(error)));
    showMessage("duration", days ? (days === 1 ? "당일 출장 · " : "") + "출장일수 " + days + "일" : "");
    if (!days) details.hidden = true;
    get("next").hidden = !details.hidden;
  }

  function updateFields() {
    const inside = isInside();
    const transport = get("transport").value;
    const grade = get("grade").value;
    const byCar = transport === "car";
    const necessaryCar = get("necessary-car").checked;
    const byOfficial = transport === "official";
    const special = transport === "air" || transport === "ship";
    const days = tripDays();

    get("inside-fields").hidden = !inside;
    get("outside-fields").hidden = inside;
    get("next").textContent = inside ? "다음 · 출장시간 입력" : "다음 · 교통편 입력";
    get("details-title").textContent = inside ? "출장시간 및 차량 이용" : "교통편 및 지급 조건";
    const minutes = travelMinutes();
    showMessage("inside-duration", inside && minutes >= 0 ? "총 출장시간 " + durationLabel(minutes) : "");

    get("car-fields").hidden = !byCar;
    get("reference-fields").hidden = necessaryCar;
    get("recognized-fields").hidden = !necessaryCar;
    get("fare-fields").hidden = byOfficial || (byCar && necessaryCar);
    get("official-fare-hint").hidden = !byOfficial;
    get("fare-label").textContent = byCar ? "왕복 기준 운임 (원)" : "지급 대상 왕복 운임 (원)";
    const mode = byCar ? get("reference-transport").value : transport;
    const gradeLabel = transportGrade(mode, grade);
    const fareBasis = gradeLabel ? TRANSPORT_NAMES[mode] + " " + gradeLabel + " 기준으로 " : "";
    get("fare-hint").textContent = fareBasis + "가는 편과 오는 편의 운임을 합해 입력하세요.";
    get("special-transport").hidden = !special;
    get("mileage-field").hidden = transport !== "air";
    get("reduced-days").max = days;
    get("meal-days").max = days;

    get("lodging-fields").hidden = days < 2;
    get("lodging-editor").hidden = !get("lodging").checked;
    get("lodging-travel-hint").hidden = !special;
    get("add-night").disabled = nights.children.length >= days - 1;
    Array.from(nights.children).forEach((night, index) => {
      night.querySelector("legend").textContent = "숙박 " + (index + 1);
      night.querySelector(".night-extra-label").hidden = grade === "first";
    });
  }

  function clearResult() {
    if (!currentResult) return;
    currentResult = null;
    get("total").textContent = "—";
    get("result-context").textContent = "변경된 조건으로 여비를 다시 계산하세요.";
    showMessage("result-dates", "");
    get("breakdown").hidden = true;
    get("result-notes").hidden = true;
    get("result-actions").hidden = true;
  }

  function addNight(focus = false) {
    const fragment = get("night-template").content.cloneNode(true);
    nights.append(fragment);
    updateFields();
    if (focus) nights.lastElementChild.querySelector(".night-region").focus();
  }

  function showDetails() {
    const error = dateError(true);
    if (error) {
      showMessage("date-error", error);
      const invalid = !departure.value ? departure : returnDate;
      invalid.setAttribute("aria-invalid", "true");
      invalid.focus();
      return;
    }
    details.hidden = false;
    get("next").hidden = true;
    updateFields();
    get("details-title").focus();
  }

  function readInput(input, label) {
    if (!input.validity.valid || input.value === "") {
      const error = new Error(label + (input.type === "number" ? " 항목에 허용 범위 내의 정수를 입력하세요." : " 항목을 입력하거나 선택하세요."));
      error.input = input;
      throw error;
    }
    return input.type === "number" ? input.valueAsNumber : input.value;
  }

  function readNumber(id, label) {
    return readInput(get(id), label);
  }

  function readOutsideTrip(days) {
    const transport = get("transport").value;
    const grade = get("grade").value;
    const necessaryCar = transport === "car" && get("necessary-car").checked;
    const trip = {
      days, grade, transport, necessaryCar,
      reducedDays: readNumber("reduced-days", "일비 반액 적용 일수"),
      mealDays: transport === "air" || transport === "ship" ? readNumber("meal-days", "식비 지급 대상 일수") : days,
      mileage: transport === "air" && get("mileage").checked,
      nights: []
    };

    if (necessaryCar) {
      trip.fuel = readNumber("fuel", "인정 연료비");
      trip.toll = readNumber("toll", "인정 통행료");
    } else if (transport !== "official") {
      if (transport === "car") trip.referenceTransport = readInput(get("reference-transport"), "기준 교통편");
      trip.fare = readNumber("fare", "왕복 운임");
    }

    if (days > 1 && get("lodging").checked) {
      if (nights.children.length > days - 1) throw new Error("입력한 숙박 박수가 출장 기간보다 많습니다. 숙박 건수를 확인하세요.");
      trip.nights = Array.from(nights.children, (night) => ({
        region: grade === "first" ? night.querySelector(".night-region").value : readInput(night.querySelector(".night-region"), "숙박 지역"),
        cost: readInput(night.querySelector(".night-cost"), "1박 결제액"),
        extra: night.querySelector(".night-extra").checked
      }));
    }
    return trip;
  }

  function renderResult(rows, notes, context) {
    const breakdown = get("breakdown");
    const noteList = get("result-notes");
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    currentResult = { departure: departure.value, returnDate: returnDate.value, context, total, rows, notes };
    get("total").textContent = won(total);
    get("result-context").textContent = context;
    const printDate = (input) => input.value.replaceAll("-", ". ");
    showMessage("result-dates", "출발일 " + printDate(departure) + " · 복귀일 " + printDate(returnDate));
    breakdown.replaceChildren(...rows.map((row) => {
      const item = document.createElement("div");
      const label = document.createElement("dt");
      const amount = document.createElement("dd");
      const basis = document.createElement("dd");
      label.textContent = row.name;
      amount.className = "amount";
      amount.textContent = won(row.amount);
      basis.className = "basis";
      basis.textContent = row.basis;
      item.append(label, amount, basis);
      return item;
    }));
    noteList.replaceChildren(...notes.map((note) => {
      const item = document.createElement("li");
      item.textContent = note;
      return item;
    }));
    breakdown.hidden = false;
    noteList.hidden = notes.length === 0;
    get("result-actions").hidden = false;
    get("result-title").focus();
  }

  form.addEventListener("input", (event) => {
    if (event.target === departure) {
      departure.removeAttribute("aria-invalid");
      if (!returnEdited || !returnDate.value) {
        returnDate.value = departure.value;
        returnEdited = false;
      }
    }
    if (event.target === returnDate) returnEdited = Boolean(returnDate.value);
    if (["transport", "reference-transport", "grade"].includes(event.target.id)) get("fare").value = "";
    if (event.target.id === "lodging" && event.target.checked && !nights.children.length) addNight();
    showMessage("form-error", "");
    clearResult();
    updateDates();
    updateFields();
  });

  get("next").addEventListener("click", showDetails);
  get("print-result").addEventListener("click", () => window.print());
  get("save-excel").addEventListener("click", () => {
    if (!currentResult) return;
    const url = URL.createObjectURL(makeTripWorkbook(currentResult));
    const link = document.createElement("a");
    link.href = url;
    link.download = "출장여비_" + currentResult.departure + ".xlsx";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  get("add-night").addEventListener("click", () => {
    clearResult();
    addNight(true);
  });
  nights.addEventListener("click", (event) => {
    if (!event.target.classList.contains("remove-night")) return;
    event.target.closest(".night").remove();
    if (!nights.children.length) get("lodging").checked = false;
    clearResult();
    showMessage("form-error", "");
    updateFields();
    (nights.lastElementChild?.querySelector(".remove-night") ?? get("lodging")).focus();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (details.hidden || dateError(true)) {
      showDetails();
      return;
    }

    try {
      if (isInside()) {
        readInput(get("start-time"), "출발 시각");
        readInput(get("end-time"), "복귀 시각");
        const minutes = travelMinutes();
        if (minutes < 0) throw new Error("복귀 시각은 출발 시각과 같거나 이후여야 합니다.");
        const row = insideAllowance(minutes, get("inside-vehicle").value);
        renderResult([{ name: "근무지 내 출장여비", ...row }], [], "근무지 내 · " + durationLabel(minutes));
      } else {
        const days = tripDays();
        const { rows, notes } = outsideAllowances(readOutsideTrip(days));
        renderResult(rows, notes, "근무지 밖 · " + (days === 1 ? "당일 출장" : days + "일 출장"));
      }
      showMessage("form-error", "");
    } catch (error) {
      showMessage("form-error", error.message);
      error.input?.focus();
    }
  });

  form.addEventListener("reset", () => {
    window.setTimeout(() => {
      returnEdited = false;
      details.hidden = true;
      nights.replaceChildren();
      departure.removeAttribute("aria-invalid");
      showMessage("form-error", "");
      clearResult();
      get("result-context").textContent = "출장 조건을 입력하고 여비를 계산하세요.";
      updateDates();
      updateFields();
      departure.focus();
    });
  });

  updateDates();
  updateFields();
}

if (typeof document !== "undefined") init();
