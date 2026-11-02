import {
  addMember,
  exportDatabase,
  getAllExpenses,
  getAllLoans,
  getAllMeetings,
  getAllMembers,
  getSettings,
  restoreDatabase,
  saveMeeting,
  updateSettings,
} from "./db.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const currency = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const dateToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const money = (amount) => `₹${currency.format(Math.round(Number(amount) || 0))}`;

let settings;
let members = [];
let meetings = [];
let expenses = [];
let loans = [];
let expenseDrafts = [];
let loanDrafts = [];
let paymentMode = "cash";
let receiptMeetingId = "";
let resolutionMeetingId = "";
let recognition;
let retryHindiRecognition = false;
let toastTimer;

const sampleMembers = [
  { name: "आशा पाटील", phone: "", totalBachat: 8400, activeLoan: 0 },
  { name: "सुनीता शिंदे", phone: "", totalBachat: 6200, activeLoan: 4500 },
  { name: "मंगला जाधव", phone: "", totalBachat: 9600, activeLoan: 8000 },
  { name: "रेखा कदम", phone: "", totalBachat: 5400, activeLoan: 2500 },
  { name: "वंदना मोरे", phone: "", totalBachat: 7200, activeLoan: 0 },
];

function showStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("is-error", isError);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function isLate(member, meetingDate) {
  return Boolean(member.lastMeetingDate && member.lastMeetingDate.slice(0, 7) < meetingDate.slice(0, 7));
}

function calculateSplit(paidAmount, member, meetingDate) {
  let remaining = Math.max(0, Math.round(Number(paidAmount) || 0));
  const fine = isLate(member, meetingDate) ? Math.min(remaining, settings.lateFine) : 0;
  remaining -= fine;

  const bachat = Math.min(remaining, settings.monthlyBachat);
  remaining -= bachat;

  const interestDue = member.activeLoan > 0
    ? Math.round(member.activeLoan * (settings.interestRate / 100))
    : 0;
  const interest = Math.min(remaining, interestDue);
  remaining -= interest;

  const principal = Math.min(remaining, Math.max(0, member.activeLoan));
  const extra = remaining - principal;
  return { fine, bachat, interest, principal, extra };
}

function splitMarkup(split) {
  const parts = [];
  if (split.fine) parts.push(`<span class="split-fine">दंड ${money(split.fine)}</span>`);
  if (split.bachat) parts.push(`<span>बचत ${money(split.bachat)}</span>`);
  if (split.interest) parts.push(`<span class="split-interest">व्याज ${money(split.interest)}</span>`);
  if (split.principal) parts.push(`<span class="split-principal">मुद्दल ${money(split.principal)}</span>`);
  if (split.extra) parts.push(`<span class="split-extra">जादा ${money(split.extra)}</span>`);
  if (!parts.length) parts.push("<span>रक्कम टाका</span>");
  return parts.join("");
}

function updateMeetingTotal() {
  const total = $$(".payment-input").reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  $("#meeting-total").textContent = money(total);
}

function renderCollectionList() {
  const date = $("#meeting-date").value || dateToday();
  $("#member-count").textContent = `${members.length} सदस्य`;
  $("#collect-all-caption").textContent = `प्रत्येकी ${money(settings.monthlyBachat)} भरणा भरा`;
  const list = $("#collection-list");

  if (!members.length) {
    list.innerHTML = '<div class="empty-state">अजून सदस्य नाहीत. सदस्य पानावरून पहिला सदस्य जोडा.</div>';
    updateMeetingTotal();
    renderMeetingOutflows();
    updateReconciliation();
    return;
  }

  list.innerHTML = members.map((member) => {
    const loan = Number(member.activeLoan) || 0;
    const late = isLate(member, date);
    return `<article class="member-row" data-member-row="${member.id}">
      <div class="member-info">
        <div class="member-name-line"><span class="member-name">${escapeHTML(member.name)}</span>${loan ? '<span class="loan-pill">कर्ज</span>' : ""}</div>
        <small class="member-sub">${loan ? `बाकी कर्ज ${money(loan)}` : "कर्ज नाही"}${late ? " · दंड लागू" : ""}</small>
      </div>
      <div class="member-payment">
        <input class="payment-input" type="number" min="0" step="1" inputmode="numeric" placeholder="₹ रक्कम" aria-label="${escapeHTML(member.name)} यांची भरलेली रक्कम" data-member-id="${member.id}">
        <div class="split-badge" data-split-for="${member.id}"><span>रक्कम टाका</span></div>
      </div>
    </article>`;
  }).join("");
  updateMeetingTotal();
  renderMeetingOutflows();
  updateReconciliation();
}

function renderDirectory() {
  $("#directory-count").textContent = `${members.length} सदस्य`;
  $("#directory-list").innerHTML = members.length
    ? members.map((member) => `<div class="directory-item">
        <div><strong>${escapeHTML(member.name)}</strong><small>${escapeHTML(member.phone || "मोबाइल नोंदलेला नाही")}</small></div>
        <div class="directory-balance"><strong>${money(member.totalBachat)}</strong><small>एकूण बचत</small></div>
      </div>`).join("")
    : '<div class="empty-state">सदस्यांची नोंद येथे दिसेल.</div>';
}

function renderBalances() {
  let cash = 0;
  let bank = 0;
  for (const meeting of meetings) {
    const records = meeting.records || [];
    const meetingCash = Number.isFinite(Number(meeting.cashCollected))
      ? Number(meeting.cashCollected)
      : records.reduce((sum, record) => sum + (record.paymentMode === "bank" ? 0 : Number(record.paid) || 0), 0);
    const directBank = Number.isFinite(Number(meeting.directBankCollected))
      ? Number(meeting.directBankCollected)
      : records.reduce((sum, record) => sum + (record.paymentMode === "bank" ? Number(record.paid) || 0 : 0), 0);
    cash += meetingCash;
    bank += directBank + (Number(meeting.bankDeposit) || 0);
  }
  cash = Math.max(0, cash - expenses.reduce((sum, expense) => sum + Number(expense.amount), 0)
    - loans.reduce((sum, loan) => sum + Number(loan.amount), 0)
    - meetings.reduce((sum, meeting) => sum + (Number(meeting.bankDeposit) || 0), 0));
  $("#cash-balance").textContent = money(cash);
  $("#bank-balance").textContent = money(bank);
  $("#active-loans-balance").textContent = money(members.reduce((sum, member) => sum + (Number(member.activeLoan) || 0), 0));
}

function renderReport() {
  const currentMonth = dateToday().slice(0, 7);
  const monthly = meetings.filter((meeting) => meeting.date.slice(0, 7) === currentMonth);
  const totals = monthly.reduce((result, meeting) => {
    result.bachat += Number(meeting.collectedBachat) || 0;
    result.interest += Number(meeting.collectedInterest) || 0;
    result.principal += Number(meeting.collectedPrincipal) || 0;
    result.total += Number(meeting.totalCash) || 0;
    return result;
  }, { bachat: 0, interest: 0, principal: 0, total: 0 });

  $("#report-month").textContent = new Intl.DateTimeFormat("mr-IN", { month: "long", year: "numeric" }).format(new Date());
  $("#report-bachat").textContent = money(totals.bachat);
  $("#report-interest").textContent = money(totals.interest);
  $("#report-principal").textContent = money(totals.principal);
  $("#report-collected").textContent = money(totals.total);
  $("#report-meetings").textContent = `${monthly.length} बैठका`;
  $("#recent-meetings").innerHTML = meetings.length
    ? meetings.slice(0, 8).map((meeting) => `<div class="recent-item"><span>${escapeHTML(meeting.date.split("-").reverse().join("/"))}</span><strong>${money(meeting.totalCash)}</strong></div>`).join("")
    : '<div class="empty-state">अहवालासाठी अजून बैठक जतन केलेली नाही.</div>';
  renderReceipt();
  renderDividend();
}

function renderDividend() {
  const yearSelect = $("#dividend-year");
  const currentYear = String(new Date().getFullYear());
  const availableYears = new Set([currentYear]);
  for (const meeting of meetings) if (meeting.date) availableYears.add(meeting.date.slice(0, 4));
  for (const expense of expenses) if (expense.date) availableYears.add(expense.date.slice(0, 4));
  const selectedYear = yearSelect.value && availableYears.has(yearSelect.value) ? yearSelect.value : currentYear;
  yearSelect.innerHTML = [...availableYears].sort((left, right) => Number(right) - Number(left))
    .map((year) => `<option value="${year}">${year}</option>`).join("");
  yearSelect.value = selectedYear;

  const yearMeetings = meetings.filter((meeting) => meeting.date?.startsWith(selectedYear));
  const yearExpenses = expenses.filter((expense) => expense.date?.startsWith(selectedYear));
  const interest = yearMeetings.reduce((sum, meeting) => sum + (Number(meeting.collectedInterest) || 0), 0);
  const fines = yearMeetings.reduce((sum, meeting) => sum + (meeting.records || []).reduce(
    (recordSum, record) => recordSum + (Number(record.fine) || 0), 0,
  ), 0);
  const expenseTotal = yearExpenses.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0);
  const net = interest + fines - expenseTotal;
  const perMember = members.length ? net / members.length : 0;
  $("#dividend-interest").textContent = money(interest);
  $("#dividend-fines").textContent = money(fines);
  $("#dividend-expenses").textContent = `−${money(expenseTotal)}`;
  $("#dividend-net").textContent = money(net);
  $("#dividend-per-member").textContent = money(perMember);
  $("#dividend-member-count").textContent = `${members.length} सदस्य`;

  const lines = [
    `*${settings.gatName} - ${selectedYear} वार्षिक नफा वाटप*`,
    "",
    `एकूण मिळालेले व्याज: ${money(interest)}`,
    `एकूण दंड वसुली: ${money(fines)}`,
    `वजा: एकूण गट खर्च: ${money(expenseTotal)}`,
    `निव्वळ वाटपयोग्य नफा: ${money(net)}`,
    "",
    `सदस्यनिहाय समान वाटप (${members.length} सदस्य):`,
    ...members.map((member) => `${member.name}: ${money(perMember)}`),
  ];
  $("#dividend-whatsapp").href = `https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`;
}

function dateLabel(date) {
  return date ? date.split("-").reverse().join("/") : "—";
}

function draftKey() {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function renderMeetingOutflows() {
  const memberSelect = $("#loan-member");
  if (!memberSelect) return;
  const previousMember = memberSelect.value;
  memberSelect.innerHTML = members.length
    ? members.map((member) => `<option value="${member.id}">${escapeHTML(member.name)}</option>`).join("")
    : '<option value="">आधी सदस्य जोडा</option>';
  if (members.some((member) => String(member.id) === previousMember)) memberSelect.value = previousMember;

  $("#loan-draft-list").innerHTML = loanDrafts.length
    ? loanDrafts.map((loan) => `<div class="draft-row"><span><strong>${escapeHTML(loan.memberName)}</strong><small>${escapeHTML(loan.purpose)} · ठराव ${escapeHTML(loan.resolutionNo)}</small></span><b>${money(loan.amount)}</b><button type="button" class="remove-draft" data-remove-loan="${loan.draftId}" aria-label="कर्ज नोंद काढा">×</button></div>`).join("")
    : '<p class="draft-empty">या बैठकीसाठी कर्ज नोंद नाही.</p>';
  $("#expense-draft-list").innerHTML = expenseDrafts.length
    ? expenseDrafts.map((expense) => `<div class="draft-row"><span><strong>${escapeHTML(expense.title)}</strong><small>गट खर्च</small></span><b>${money(expense.amount)}</b><button type="button" class="remove-draft" data-remove-expense="${expense.draftId}" aria-label="खर्च नोंद काढा">×</button></div>`).join("")
    : '<p class="draft-empty">या बैठकीसाठी खर्च नोंद नाही.</p>';
  updateReconciliation();
}

function updateReconciliation() {
  const collectedCash = $$(".payment-input").reduce((sum, input) => (
    sum + (paymentMode === "cash" ? Number(input.value) || 0 : 0)
  ), 0);
  const newLoans = loanDrafts.reduce((sum, loan) => sum + loan.amount, 0);
  const pettyExpenses = expenseDrafts.reduce((sum, expense) => sum + expense.amount, 0);
  const deposit = collectedCash - newLoans - pettyExpenses;
  $("#reconcile-collected").textContent = money(collectedCash);
  $("#reconcile-loans").textContent = money(newLoans);
  $("#reconcile-expenses").textContent = money(pettyExpenses);
  $("#reconcile-deposit").textContent = money(Math.max(0, deposit));
  const warning = $("#reconcile-warning");
  warning.textContent = deposit < 0 ? `रोकड अपुरी: आणखी ${money(Math.abs(deposit))} आवश्यक` : "";
  warning.classList.toggle("is-visible", deposit < 0);
}

function normalizeDigits(value) {
  return String(value).replace(/[०-९]/g, (digit) => String("०१२३४५६७८९".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function normalizedWords(value) {
  const honorifics = new Set(["ताई", "ताईजी", "जी", "tai", "didi"]);
  return normalizeDigits(value).normalize("NFC").toLocaleLowerCase("mr-IN")
    .replace(/[.,!?;:]/g, " ").split(/\s+/).filter((word) => word && !honorifics.has(word));
}

function findMemberBySpokenName(name) {
  const query = normalizedWords(name);
  if (!query.length) return { member: null, ambiguous: false };
  const matches = members.filter((member) => {
    const memberWords = normalizedWords(member.name);
    if (query.length === 1) return memberWords.includes(query[0]);
    return memberWords.some((_, index) => query.every((word, offset) => memberWords[index + offset] === word));
  });
  return { member: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}

function showQuickEntryToast(message, isError = false) {
  const toast = $("#quick-entry-toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 4200);
}

function parseQuickEntry(rawText, preserveInput = false) {
  const text = normalizeDigits(rawText).normalize("NFC").trim();
  if (!text) {
    showQuickEntryToast("आधी नाव आणि रक्कम लिहा किंवा बोला.", true);
    return false;
  }

  const expenseMatch = text.match(/^खर्च\s+([\d,]+)\s+(.+)$/i);
  if (expenseMatch) {
    const amount = Number(expenseMatch[1].replace(/,/g, ""));
    const title = expenseMatch[2].trim();
    if (amount <= 0 || !title) {
      showQuickEntryToast("खर्चासाठी योग्य रक्कम आणि तपशील द्या.", true);
      return false;
    }
    expenseDrafts.push({ draftId: draftKey(), title, amount });
    renderMeetingOutflows();
    showQuickEntryToast(`${title} खर्च ${money(amount)} जोडला.`);
    if (!preserveInput) $("#quick-entry-text").value = "";
    return true;
  }

  const loanMatch = text.match(/^कर्ज\s+(.+?)\s+([\d,]+)\s+(.+)$/i);
  if (loanMatch) {
    const match = findMemberBySpokenName(loanMatch[1]);
    if (match.ambiguous) {
      showQuickEntryToast("या नावाचे एकापेक्षा जास्त सदस्य आहेत. पूर्ण नाव लिहा.", true);
      return false;
    }
    if (!match.member) {
      showQuickEntryToast("कर्जासाठी सदस्य सापडला नाही.", true);
      return false;
    }
    $("#loan-member").value = String(match.member.id);
    $("#loan-form [name=amount]").value = Number(loanMatch[2].replace(/,/g, ""));
    $("#loan-form [name=purpose]").value = loanMatch[3].trim();
    if (!$("#loan-form [name=resolutionNo]").value) {
      $("#loan-form [name=resolutionNo]").value = `०१/${$("#meeting-date").value.slice(0, 4)}`;
    }
    $("#loan-form [name=amount]").focus();
    showQuickEntryToast(`${match.member.name} यांचे ${money(loanMatch[2].replace(/,/g, ""))} कर्ज फॉर्ममध्ये भरले.`);
    if (!preserveInput) $("#quick-entry-text").value = "";
    return true;
  }

  const collectionMatch = text.match(/^(.+?)\s+₹?\s*([\d,]+)(?:\s*(?:रु|रुपये))?$/i);
  if (collectionMatch) {
    const match = findMemberBySpokenName(collectionMatch[1]);
    if (match.ambiguous) {
      showQuickEntryToast("या नावाचे एकापेक्षा जास्त सदस्य आहेत. पूर्ण नाव लिहा.", true);
      return false;
    }
    if (!match.member) {
      showQuickEntryToast("या नावाचा सदस्य सापडला नाही.", true);
      return false;
    }
    const input = $(`.payment-input[data-member-id="${match.member.id}"]`);
    input.value = Number(collectionMatch[2].replace(/,/g, ""));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    showQuickEntryToast(`${match.member.name} यांची ${money(input.value)} वसुली भरली.`);
    if (!preserveInput) $("#quick-entry-text").value = "";
    return true;
  }

  showQuickEntryToast("नोंद समजली नाही. नाव + रक्कम, ‘खर्च 50 ऑटो’ किंवा ‘कर्ज आशा 5000 शिलाई’ वापरा.", true);
  return false;
}

function toggleVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showQuickEntryToast("या ब्राउझरमध्ये आवाज नोंद उपलब्ध नाही. मजकूर टाइप करा.", true);
    return;
  }
  if (recognition) {
    recognition.stop();
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = "mr-IN";
  recognition.interimResults = true;
  recognition.continuous = false;
  retryHindiRecognition = false;
  const mic = $("#voice-input");
  mic.classList.add("is-listening");
  mic.setAttribute("aria-label", "आवाज नोंद थांबवा");
  $("#quick-entry-text").value = "";

  recognition.onresult = (event) => {
    const transcript = [...event.results].map((result) => result[0].transcript).join(" ").trim();
    $("#quick-entry-text").value = transcript;
  };
  recognition.onerror = (event) => {
    if (event.error === "language-not-supported" && recognition.lang === "mr-IN") {
      retryHindiRecognition = true;
      recognition.lang = "hi-IN";
      return;
    }
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showQuickEntryToast("मायक्रोफोन परवानगी नाकारली. ब्राउझर सेटिंगमध्ये परवानगी द्या.", true);
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      showQuickEntryToast("आवाज नोंद अयशस्वी. मजकूर टाइप करून पाहा.", true);
    }
  };
  recognition.onend = () => {
    if (retryHindiRecognition && recognition) {
      retryHindiRecognition = false;
      try {
        recognition.start();
        return;
      } catch (error) {
        showQuickEntryToast("मराठी/हिंदी आवाज सेवा सुरू झाली नाही. मजकूर टाइप करा.", true);
      }
    }
    const transcript = $("#quick-entry-text").value;
    recognition = null;
    mic.classList.remove("is-listening");
    mic.setAttribute("aria-label", "आवाजाने नोंद करा");
    if (transcript) parseQuickEntry(transcript, true);
  };
  try {
    recognition.start();
  } catch (error) {
    recognition = null;
    mic.classList.remove("is-listening");
    mic.setAttribute("aria-label", "आवाजाने नोंद करा");
    showQuickEntryToast("मायक्रोफोन सुरू करता आला नाही. परवानगी तपासा किंवा मजकूर टाइप करा.", true);
  }
}

function backupFilename() {
  return `gatmitra-backup-${dateToday()}.json`;
}

function downloadBackupFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function createBackupFile() {
  const backup = await exportDatabase();
  const content = JSON.stringify(backup, null, 2);
  return {
    backup,
    file: new File([content], backupFilename(), { type: "application/json" }),
  };
}

async function refreshDatabaseState() {
  settings = await getSettings();
  members = await getAllMembers();
  meetings = await getAllMeetings();
  expenses = await getAllExpenses();
  loans = await getAllLoans();
  renderAll();
}

async function restoreFromSelectedFile(file) {
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (!window.confirm("हा बॅकअप सध्याची सर्व स्थानिक गट माहिती बदलून टाकेल. पुढे सुरू करायचे?")) return;
    await restoreDatabase(backup);
    expenseDrafts = [];
    loanDrafts = [];
    await refreshDatabaseState();
    showStatus($("#backup-status"), "बॅकअप रिस्टोअर झाला. गटाची सर्व माहिती अद्ययावत केली.");
  } catch (error) {
    showStatus($("#backup-status"), error.message || "बॅकअप रिस्टोअर करता आला नाही.", true);
  } finally {
    $("#backup-file").value = "";
  }
}

function balancesThroughMeeting(targetMeeting) {
  let cash = 0;
  let bank = 0;
  const chronological = [...meetings].sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);
  for (const meeting of chronological) {
    const records = meeting.records || [];
    const cashCollected = Number.isFinite(Number(meeting.cashCollected))
      ? Number(meeting.cashCollected)
      : records.reduce((sum, record) => sum + (record.paymentMode === "bank" ? 0 : Number(record.paid) || 0), 0);
    const directBank = Number.isFinite(Number(meeting.directBankCollected))
      ? Number(meeting.directBankCollected)
      : records.reduce((sum, record) => sum + (record.paymentMode === "bank" ? Number(record.paid) || 0 : 0), 0);
    const expenseTotal = expenses.filter((expense) => expense.meetingId === meeting.id)
      .reduce((sum, expense) => sum + Number(expense.amount), 0) || Number(meeting.expensesTotal) || 0;
    const loanTotal = loans.filter((loan) => loan.meetingId === meeting.id)
      .reduce((sum, loan) => sum + Number(loan.amount), 0) || Number(meeting.loansDisbursed) || 0;
    cash += cashCollected - expenseTotal - loanTotal - (Number(meeting.bankDeposit) || 0);
    bank += directBank + (Number(meeting.bankDeposit) || 0);
    if (meeting.id === targetMeeting) break;
  }
  return { cash: Math.max(0, cash), bank: Math.max(0, bank) };
}

function renderReceipt() {
  const select = $("#receipt-meeting");
  if (!select) return;
  const previousId = receiptMeetingId || select.value;
  select.innerHTML = meetings.length
    ? meetings.map((meeting) => `<option value="${meeting.id}">${escapeHTML(dateLabel(meeting.date))} · ${money(meeting.totalCash)}</option>`).join("")
    : '<option value="">बैठक उपलब्ध नाही</option>';
  receiptMeetingId = meetings.some((meeting) => String(meeting.id) === String(previousId))
    ? String(previousId)
    : String(meetings[0]?.id || "");
  select.value = receiptMeetingId;
  const meeting = meetings.find((item) => String(item.id) === receiptMeetingId);
  const preview = $("#receipt-preview");
  const sendButton = $("#whatsapp-send");
  const copyButton = $("#copy-receipt");
  if (!meeting) {
    preview.textContent = "बैठक जतन झाल्यावर येथे पावती तयार होईल.";
    sendButton.href = "https://wa.me/";
    copyButton.disabled = true;
    return;
  }

  const meetingLoans = loans.filter((loan) => loan.meetingId === meeting.id);
  const meetingExpenses = expenses.filter((expense) => expense.meetingId === meeting.id);
  const loanTotal = meetingLoans.reduce((sum, loan) => sum + Number(loan.amount), 0) || Number(meeting.loansDisbursed) || 0;
  const expenseTotal = meetingExpenses.reduce((sum, expense) => sum + Number(expense.amount), 0) || Number(meeting.expensesTotal) || 0;
  const balances = balancesThroughMeeting(meeting.id);
  const receipt = [
    `*${settings.gatName} - मासिक बैठक पावती (दि. ${dateLabel(meeting.date)})*`,
    "",
    `एकूण बचत जमा: ${money(meeting.collectedBachat)}`,
    `कर्ज परतफेड (व्याज + मुद्दल): ${money((Number(meeting.collectedInterest) || 0) + (Number(meeting.collectedPrincipal) || 0))}`,
    `नवीन अंतर्गत कर्ज: ${money(loanTotal)}`,
    `गट इतर खर्च: ${money(expenseTotal)}${meetingExpenses.length ? `\n${meetingExpenses.map((expense) => `  - ${expense.title}: ${money(expense.amount)}`).join("\n")}` : ""}`,
    "",
    `हातातील रोकड शिल्लक: ${money(balances.cash)}`,
    `बँक शिल्लक: ${money(balances.bank)}`,
  ].join("\n");
  preview.textContent = receipt;
  sendButton.href = `https://wa.me/?text=${encodeURIComponent(receipt)}`;
  copyButton.disabled = false;
}

function renderResolutions() {
  const select = $("#resolution-meeting");
  if (!select) return;
  const loanMeetingIds = new Set(loans.map((loan) => loan.meetingId));
  const availableMeetings = meetings.filter((meeting) => loanMeetingIds.has(meeting.id));
  const previousId = resolutionMeetingId || select.value;
  select.innerHTML = availableMeetings.length
    ? availableMeetings.map((meeting) => `<option value="${meeting.id}">${escapeHTML(dateLabel(meeting.date))}</option>`).join("")
    : '<option value="">कर्ज वाटपाची बैठक नाही</option>';
  resolutionMeetingId = availableMeetings.some((meeting) => String(meeting.id) === String(previousId))
    ? String(previousId)
    : String(availableMeetings[0]?.id || "");
  select.value = resolutionMeetingId;

  const meeting = availableMeetings.find((item) => String(item.id) === resolutionMeetingId);
  const meetingLoans = meeting ? loans.filter((loan) => loan.meetingId === meeting.id) : [];
  const hasLoans = meetingLoans.length > 0;
  $("#resolution-print").hidden = !hasLoans;
  $("#resolution-empty").hidden = hasLoans;
  $("#print-resolution").disabled = !hasLoans;
  if (!hasLoans) return;

  const resolutionNumbers = [...new Set(meetingLoans.map((loan) => loan.resolutionNo).filter(Boolean))];
  const total = meetingLoans.reduce((sum, loan) => sum + Number(loan.amount), 0);
  const groupGenitive = settings.gatName.endsWith("गट") ? `${settings.gatName}ा` : settings.gatName;
  $("#resolution-gat-name").textContent = settings.gatName;
  $("#resolution-number").textContent = resolutionNumbers.join(" / ") || "—";
  $("#resolution-date").textContent = dateLabel(meeting.date);
  $("#resolution-body").textContent = `${groupGenitive}च्या दिनांक ${dateLabel(meeting.date)} रोजी झालेल्या मासिक बैठकीत सदस्यांना अंतर्गत कर्ज मंजूर करण्याचा ठराव सर्वानुमते मंजूर करण्यात आला. अध्यक्षा व सचिव यांना गटाच्या बँक बचत खात्यातून एकूण ${money(total)} काढून खालील लाभार्थी सदस्यांना मंजूर कर्ज वितरित करण्यास अधिकृत करण्यात येत आहे.`;
  $("#resolution-loan-rows").innerHTML = meetingLoans.map((loan, index) => `<tr><td>${index + 1}</td><td>${escapeHTML(loan.memberName)}</td><td>${money(loan.amount)}</td><td>${escapeHTML(loan.purpose)}</td></tr>`).join("");
  $("#resolution-total").textContent = money(total);
  $("#resolution-member-signatures").innerHTML = members.map((member) => `<div class="member-signature"><span></span><strong>${escapeHTML(member.name)}</strong></div>`).join("");
}

function renderSettings() {
  $("#group-name").textContent = settings.gatName;
  const form = $("#settings-form");
  form.elements.gatName.value = settings.gatName;
  form.elements.monthlyBachat.value = settings.monthlyBachat;
  form.elements.interestRate.value = settings.interestRate;
  form.elements.lateFine.value = settings.lateFine;
}

function renderAll() {
  renderSettings();
  renderCollectionList();
  renderDirectory();
  renderBalances();
  renderReport();
  renderResolutions();
}

async function seedMembersIfEmpty() {
  const existing = await getAllMembers();
  if (existing.length) return existing;
  const today = dateToday();
  await Promise.all(sampleMembers.map((member) => addMember({ ...member, lastMeetingDate: today })));
  return getAllMembers();
}

function switchScreen(screenName) {
  $$(".screen").forEach((screen) => {
    const active = screen.id === `screen-${screenName}`;
    screen.hidden = !active;
    screen.classList.toggle("is-active", active);
  });
  $$(".nav-button").forEach((button) => {
    const active = button.dataset.screen === screenName;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function bindEvents() {
  $$(".nav-button").forEach((button) => button.addEventListener("click", () => switchScreen(button.dataset.screen)));

  $("#quick-entry-form").addEventListener("submit", (event) => {
    event.preventDefault();
    parseQuickEntry($("#quick-entry-text").value);
  });
  $("#voice-input").addEventListener("click", toggleVoiceInput);

  $("#meeting-date").addEventListener("change", renderCollectionList);
  $("#collection-list").addEventListener("input", (event) => {
    const input = event.target.closest(".payment-input");
    if (!input) return;
    input.removeAttribute("aria-invalid");
    const member = members.find((item) => item.id === Number(input.dataset.memberId));
    if (!member) return;
    const split = calculateSplit(input.value, member, $("#meeting-date").value || dateToday());
    $(`[data-split-for="${member.id}"]`).innerHTML = splitMarkup(split);
    updateMeetingTotal();
    updateReconciliation();
  });

  $("#collect-all").addEventListener("click", () => {
    $$(".payment-input").forEach((input) => {
      input.value = settings.monthlyBachat;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  $$(".mode-button").forEach((button) => button.addEventListener("click", () => {
    paymentMode = button.dataset.mode;
    $$(".mode-button").forEach((option) => {
      const selected = option === button;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    updateReconciliation();
  }));

  $("#loan-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const member = members.find((item) => item.id === Number(data.get("memberId")));
    if (!member) return;
    loanDrafts.push({
      draftId: draftKey(),
      memberId: member.id,
      memberName: member.name,
      amount: Number(data.get("amount")),
      purpose: String(data.get("purpose")).trim(),
      resolutionNo: String(data.get("resolutionNo")).trim(),
    });
    form.reset();
    renderMeetingOutflows();
  });

  $("#expense-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    expenseDrafts.push({
      draftId: draftKey(),
      title: String(data.get("title")).trim(),
      amount: Number(data.get("amount")),
    });
    form.reset();
    renderMeetingOutflows();
  });

  $("#loan-draft-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-loan]");
    if (!button) return;
    loanDrafts = loanDrafts.filter((loan) => loan.draftId !== button.dataset.removeLoan);
    renderMeetingOutflows();
  });

  $("#expense-draft-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-expense]");
    if (!button) return;
    expenseDrafts = expenseDrafts.filter((expense) => expense.draftId !== button.dataset.removeExpense);
    renderMeetingOutflows();
  });

  $("#receipt-meeting").addEventListener("change", (event) => {
    receiptMeetingId = event.currentTarget.value;
    renderReceipt();
  });
  $("#resolution-meeting").addEventListener("change", (event) => {
    resolutionMeetingId = event.currentTarget.value;
    renderResolutions();
  });
  $("#dividend-year").addEventListener("change", renderDividend);
  $("#copy-receipt").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#receipt-preview").textContent);
      showStatus($("#receipt-status"), "पावती कॉपी झाली.");
    } catch (error) {
      showStatus($("#receipt-status"), "कॉपी करता आली नाही. पावती मजकूर निवडून कॉपी करा.", true);
    }
  });
  $("#print-resolution").addEventListener("click", () => {
    if (!resolutionMeetingId) return;
    switchScreen("resolutions");
    window.print();
  });

  $("#download-backup").addEventListener("click", async () => {
    try {
      const { file } = await createBackupFile();
      downloadBackupFile(file);
      showStatus($("#backup-status"), `${file.name} डाउनलोडसाठी तयार आहे.`);
    } catch (error) {
      showStatus($("#backup-status"), error.message || "बॅकअप तयार करता आला नाही.", true);
    }
  });
  $("#share-backup").addEventListener("click", async () => {
    try {
      const { backup, file } = await createBackupFile();
      const summary = `${settings.gatName} GatMitra बॅकअप (${dateToday()})\nसदस्य: ${backup.stores.members.length} · बैठका: ${backup.stores.meetings.length} · खर्च: ${backup.stores.expenses.length} · कर्ज: ${backup.stores.loans.length}\nफाइल: ${file.name}`;
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: `${settings.gatName} बॅकअप`, text: summary, files: [file] });
        showStatus($("#backup-status"), "बॅकअप फाइल शेअर करण्यासाठी तयार आहे.");
        return;
      }
      downloadBackupFile(file);
      window.open(`https://wa.me/?text=${encodeURIComponent(`${summary}\n\nJSON फाइल डाउनलोड झाली आहे. ती WhatsApp संदेशासोबत जोडा.`)}`, "_blank", "noopener");
      showStatus($("#backup-status"), "JSON फाइल डाउनलोड झाली. WhatsApp मध्ये ती संदेशासोबत जोडा.");
    } catch (error) {
      if (error.name !== "AbortError") {
        showStatus($("#backup-status"), error.message || "बॅकअप शेअर करता आला नाही.", true);
      }
    }
  });
  $("#choose-backup").addEventListener("click", () => $("#backup-file").click());
  $("#backup-file").addEventListener("change", (event) => restoreFromSelectedFile(event.currentTarget.files[0]));

  $("#save-meeting").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const date = $("#meeting-date").value;
      if (!date) {
        showStatus($("#baithak-status"), "बैठकीची तारीख निवडा.", true);
        return;
      }

      const records = [];
      for (const input of $$(".payment-input")) {
        if (!input.value.trim()) continue;
        const member = members.find((item) => item.id === Number(input.dataset.memberId));
        if (!member) {
          input.setAttribute("aria-invalid", "true");
          input.focus();
          showStatus($("#baithak-status"), "या रकमेचा सदस्य सापडला नाही. पृष्ठ रीफ्रेश करून पुन्हा प्रयत्न करा.", true);
          return;
        }

        const paid = Number(input.value);
        if (!Number.isFinite(paid) || paid < 0 || !Number.isInteger(paid)) {
          input.setAttribute("aria-invalid", "true");
          input.focus();
          showStatus($("#baithak-status"), `${member.name} यांची रक्कम शून्य किंवा त्याहून अधिक पूर्णांक असावी.`, true);
          return;
        }
        input.removeAttribute("aria-invalid");
        if (paid === 0) continue;
        if (paymentMode !== "cash" && paymentMode !== "bank") {
          showStatus($("#baithak-status"), "जमा करण्याचे खाते निवडा: रोकड किंवा बँक.", true);
          return;
        }
        records.push({
          memberId: member.id,
          memberName: member.name,
          paid,
          ...calculateSplit(paid, member, date),
          paymentMode,
        });
      }

      if (!records.length) {
        showStatus($("#baithak-status"), "जतन करण्यापूर्वी किमान एका सदस्याची रक्कम भरा.", true);
        return;
      }
      const cashCollected = records.reduce((sum, record) => sum + (record.paymentMode === "cash" ? record.paid : 0), 0);
      const expensesTotal = expenseDrafts.reduce((sum, expense) => sum + expense.amount, 0);
      const loansTotal = loanDrafts.reduce((sum, loan) => sum + loan.amount, 0);
      if (expensesTotal + loansTotal > cashCollected) {
        showStatus($("#baithak-status"), `कर्ज वाटप आणि खर्चासाठी रोकड अपुरी आहे. अजून ${money(expensesTotal + loansTotal - cashCollected)} जमा करा.`, true);
        return;
      }

      showStatus($("#baithak-status"), "बैठक जतन होत आहे…");
      await saveMeeting({
        date,
        collectedBachat: records.reduce((sum, record) => sum + record.bachat, 0),
        collectedInterest: records.reduce((sum, record) => sum + record.interest, 0),
        collectedPrincipal: records.reduce((sum, record) => sum + record.principal, 0),
        totalCash: records.reduce((sum, record) => sum + record.paid, 0),
        records,
        expenses: expenseDrafts.map(({ title, amount }) => ({ title, amount })),
        loans: loanDrafts.map(({ memberId, memberName, amount, purpose, resolutionNo }) => ({
          memberId, memberName, amount, purpose, resolutionNo,
        })),
      });
      meetings = await getAllMeetings();
      members = await getAllMembers();
      expenses = await getAllExpenses();
      loans = await getAllLoans();
      expenseDrafts = [];
      loanDrafts = [];
      renderAll();
      showStatus($("#baithak-status"), "बैठक, जमा-खर्च आणि कर्ज वाटप जतन झाले.");
    } catch (error) {
      const details = error instanceof Error ? error.message : "";
      showStatus(
        $("#baithak-status"),
        details ? `बैठक जतन करता आली नाही: ${details}` : "बैठक जतन करता आली नाही.",
        true,
      );
    } finally {
      button.disabled = false;
    }
  });

  $("#add-member-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await addMember({
        name: data.get("name"),
        phone: data.get("phone"),
        activeLoan: Number(data.get("activeLoan")) || 0,
        lastMeetingDate: dateToday(),
      });
      members = await getAllMembers();
      form.reset();
      renderCollectionList();
      renderDirectory();
      renderBalances();
      renderDividend();
      showStatus($("#members-status"), "नवीन सदस्य जोडला.");
    } catch (error) {
      showStatus($("#members-status"), error.message || "सदस्य जोडता आला नाही.", true);
    }
  });

  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      settings = await updateSettings({
        gatName: data.get("gatName"),
        monthlyBachat: data.get("monthlyBachat"),
        interestRate: data.get("interestRate"),
        lateFine: data.get("lateFine"),
      });
      renderAll();
      showStatus($("#settings-status"), "नियम जतन झाले.");
    } catch (error) {
      showStatus($("#settings-status"), error.message || "नियम जतन करता आले नाहीत.", true);
    } finally {
      button.disabled = false;
    }
  });
}

async function start() {
  try {
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
    settings = await getSettings();
    members = await seedMembersIfEmpty();
    meetings = await getAllMeetings();
    expenses = await getAllExpenses();
    loans = await getAllLoans();
    $("#meeting-date").value = dateToday();
    bindEvents();
    renderAll();
  } catch (error) {
    document.querySelector("main").innerHTML = `<div class="empty-state" role="alert">गटमित्र सुरू करता आले नाही: ${escapeHTML(error.message || "स्थानिक डेटाबेस उपलब्ध नाही.")}</div>`;
  }
}

start();