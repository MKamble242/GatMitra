const DB_NAME = "GatMitraDB";
const DB_VERSION = 2;

export const DEFAULT_SETTINGS = Object.freeze({
  id: "config",
  gatName: "माऊली बचत गट",
  monthlyBachat: 200,
  interestRate: 2.0,
  lateFine: 20,
});

let databasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("Database transaction was aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("Database transaction failed."));
  });
}

export function openDB() {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("This browser does not support IndexedDB."));
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("settings")) {
          database.createObjectStore("settings", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("members")) {
          database.createObjectStore("members", { keyPath: "id", autoIncrement: true });
        }
        if (!database.objectStoreNames.contains("meetings")) {
          database.createObjectStore("meetings", { keyPath: "id", autoIncrement: true });
        }
        if (!database.objectStoreNames.contains("expenses")) {
          database.createObjectStore("expenses", { keyPath: "id", autoIncrement: true });
        }
        if (!database.objectStoreNames.contains("loans")) {
          database.createObjectStore("loans", { keyPath: "id", autoIncrement: true });
        }
      };

      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => {
        databasePromise = undefined;
        reject(request.error || new Error("Could not open the local database."));
      };
      request.onblocked = () => {
        databasePromise = undefined;
        reject(new Error("Database upgrade is blocked by another open GatMitra tab."));
      };
    });
  }

  return databasePromise;
}

export async function getSettings() {
  const database = await openDB();
  const transaction = database.transaction("settings", "readwrite");
  const store = transaction.objectStore("settings");
  const settings = await requestResult(store.get("config"));
  if (settings) {
    await transactionResult(transaction);
    return { ...DEFAULT_SETTINGS, ...settings };
  }

  store.add({ ...DEFAULT_SETTINGS });
  await transactionResult(transaction);
  return { ...DEFAULT_SETTINGS };
}

export async function updateSettings(changes) {
  const current = await getSettings();
  const next = { ...current, ...changes, id: "config" };

  if (typeof next.gatName !== "string" || !next.gatName.trim()) {
    throw new TypeError("Group name cannot be empty.");
  }
  for (const field of ["monthlyBachat", "interestRate", "lateFine"]) {
    if (!Number.isFinite(Number(next[field])) || Number(next[field]) < 0) {
      throw new TypeError(`${field} must be a non-negative number.`);
    }
    next[field] = Number(next[field]);
  }
  next.gatName = next.gatName.trim();

  const database = await openDB();
  const transaction = database.transaction("settings", "readwrite");
  transaction.objectStore("settings").put(next);
  await transactionResult(transaction);
  return next;
}

export async function getAllMembers() {
  const database = await openDB();
  const transaction = database.transaction("members", "readonly");
  const members = await requestResult(transaction.objectStore("members").getAll());
  await transactionResult(transaction);
  return members.sort((left, right) => left.name.localeCompare(right.name, "mr"));
}

export async function addMember(member) {
  if (!member || typeof member.name !== "string" || !member.name.trim()) {
    throw new TypeError("Member name is required.");
  }
  const database = await openDB();
  const transaction = database.transaction("members", "readwrite");
  const id = await requestResult(transaction.objectStore("members").add({
    name: member.name.trim(),
    phone: String(member.phone || "").trim(),
    totalBachat: Number(member.totalBachat) || 0,
    activeLoan: Number(member.activeLoan) || 0,
    lastMeetingDate: String(member.lastMeetingDate || ""),
  }));
  await transactionResult(transaction);
  return id;
}

export async function getAllMeetings() {
  const database = await openDB();
  const transaction = database.transaction("meetings", "readonly");
  const meetings = await requestResult(transaction.objectStore("meetings").getAll());
  await transactionResult(transaction);
  return meetings.sort((left, right) => right.date.localeCompare(left.date) || right.id - left.id);
}

export async function getAllExpenses() {
  const database = await openDB();
  const transaction = database.transaction("expenses", "readonly");
  const expenses = await requestResult(transaction.objectStore("expenses").getAll());
  await transactionResult(transaction);
  return expenses.sort((left, right) => right.date.localeCompare(left.date));
}

export async function getAllLoans() {
  const database = await openDB();
  const transaction = database.transaction("loans", "readonly");
  const loans = await requestResult(transaction.objectStore("loans").getAll());
  await transactionResult(transaction);
  return loans.sort((left, right) => right.date.localeCompare(left.date));
}

export async function exportDatabase() {
  const database = await openDB();
  const storeNames = ["settings", "members", "meetings", "expenses", "loans"];
  const transaction = database.transaction(storeNames, "readonly");
  const snapshot = Object.fromEntries(await Promise.all(storeNames.map(async (name) => [
    name,
    await requestResult(transaction.objectStore(name).getAll()),
  ])));
  await transactionResult(transaction);
  return {
    format: DB_NAME,
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stores: snapshot,
  };
}

function validateBackup(backup) {
  const storeNames = ["settings", "members", "meetings", "expenses", "loans"];
  if (!backup || backup.format !== DB_NAME || backup.version !== DB_VERSION
    || !backup.stores || typeof backup.stores !== "object") {
    throw new TypeError("ही GatMitra बॅकअप JSON फाइल नाही.");
  }
  for (const name of storeNames) {
    if (!Array.isArray(backup.stores[name])) {
      throw new TypeError(`बॅकअपमध्ये ${name} नोंदींची यादी नाही.`);
    }
  }
  const config = backup.stores.settings.find((setting) => setting?.id === "config");
  if (!config || typeof config.gatName !== "string" || !config.gatName.trim()
    || ["monthlyBachat", "interestRate", "lateFine"].some((field) => (
      !Number.isFinite(Number(config[field])) || Number(config[field]) < 0
    ))) {
    throw new TypeError("बॅकअपमध्ये गटाची config माहिती नाही.");
  }

  const validateIds = (name) => {
    const ids = new Set();
    for (const record of backup.stores[name]) {
      if (!record || !Number.isInteger(record.id) || record.id < 1 || ids.has(record.id)) {
        throw new TypeError(`${name} मध्ये चुकीचा किंवा पुनरावृत्त ID आहे.`);
      }
      ids.add(record.id);
    }
  };
  for (const name of ["members", "meetings", "expenses", "loans"]) validateIds(name);

  for (const member of backup.stores.members) {
    if (typeof member.name !== "string" || !Number.isFinite(Number(member.totalBachat))
      || Number(member.totalBachat) < 0 || !Number.isFinite(Number(member.activeLoan))
      || Number(member.activeLoan) < 0 || typeof member.phone !== "string") {
      throw new TypeError("बॅकअपमधील सदस्य नोंद अपूर्ण आहे.");
    }
  }
  const memberIds = new Set(backup.stores.members.map((member) => member.id));
  const meetingIds = new Set(backup.stores.meetings.map((meeting) => meeting.id));
  for (const meeting of backup.stores.meetings) {
    if (typeof meeting.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(meeting.date)
      || !Array.isArray(meeting.records) || !Number.isFinite(Number(meeting.totalCash))
      || Number(meeting.totalCash) < 0 || meeting.records.some((record) => (
        !record || !memberIds.has(Number(record.memberId))
        || !Number.isFinite(Number(record.paid)) || Number(record.paid) < 0
      ))) {
      throw new TypeError("बॅकअपमधील बैठक नोंद अपूर्ण आहे.");
    }
  }
  for (const expense of backup.stores.expenses) {
    if (!Number.isInteger(expense.meetingId) || typeof expense.title !== "string"
      || !Number.isFinite(Number(expense.amount)) || Number(expense.amount) <= 0
      || typeof expense.date !== "string" || !meetingIds.has(expense.meetingId)) {
      throw new TypeError("बॅकअपमधील खर्च नोंद अपूर्ण आहे.");
    }
  }
  for (const loan of backup.stores.loans) {
    if (!Number.isInteger(loan.memberId) || !memberIds.has(loan.memberId)
      || typeof loan.memberName !== "string" || !Number.isFinite(Number(loan.amount))
      || Number(loan.amount) <= 0 || typeof loan.purpose !== "string"
      || typeof loan.date !== "string" || typeof loan.resolutionNo !== "string"
      || !Number.isInteger(loan.meetingId) || !meetingIds.has(loan.meetingId)) {
      throw new TypeError("बॅकअपमधील कर्ज नोंद अपूर्ण आहे.");
    }
  }
  return storeNames;
}

export async function restoreDatabase(backup) {
  const storeNames = validateBackup(backup);
  const database = await openDB();
  const transaction = database.transaction(storeNames, "readwrite");
  const completion = transactionResult(transaction);
  for (const name of storeNames) {
    const store = transaction.objectStore(name);
    store.clear();
    for (const record of backup.stores[name]) store.put(record);
  }
  await completion;
  return true;
}

export async function saveMeeting(meeting) {
  if (!meeting || !/^\d{4}-\d{2}-\d{2}$/.test(meeting.date) || !Array.isArray(meeting.records)) {
    throw new TypeError("A meeting date and collection records are required.");
  }
  const expenses = Array.isArray(meeting.expenses) ? meeting.expenses : [];
  const loans = Array.isArray(meeting.loans) ? meeting.loans : [];

  const records = meeting.records.map((record) => {
    const amounts = ["paid", "fine", "bachat", "interest", "principal"];
    if (!Number.isInteger(Number(record.memberId)) || Number(record.memberId) < 1) {
      throw new TypeError("Each collection record must have a valid member ID.");
    }
    for (const field of amounts) {
      if (!Number.isFinite(Number(record[field])) || Number(record[field]) < 0) {
        throw new TypeError(`Collection ${field} must be a non-negative number.`);
      }
    }
    return { ...record, memberId: Number(record.memberId) };
  });
  const safeExpenses = expenses.map((expense) => {
    const amount = Number(expense.amount);
    if (typeof expense.title !== "string" || !expense.title.trim() || !Number.isFinite(amount) || amount <= 0) {
      throw new TypeError("Each expense needs a title and a positive amount.");
    }
    return { title: expense.title.trim(), amount, date: meeting.date };
  });
  const safeLoans = loans.map((loan) => {
    const amount = Number(loan.amount);
    if (!Number.isInteger(Number(loan.memberId)) || Number(loan.memberId) < 1
      || !Number.isFinite(amount) || amount <= 0
      || typeof loan.purpose !== "string" || !loan.purpose.trim()
      || typeof loan.resolutionNo !== "string" || !loan.resolutionNo.trim()) {
      throw new TypeError("Each new loan needs a member, positive amount, purpose, and resolution number.");
    }
    return {
      memberId: Number(loan.memberId),
      memberName: String(loan.memberName || "").trim(),
      amount,
      purpose: loan.purpose.trim(),
      date: meeting.date,
      resolutionNo: loan.resolutionNo.trim(),
    };
  });

  const totalCollected = records.reduce((sum, record) => sum + Number(record.paid), 0);
  const cashCollected = records.reduce((sum, record) => (
    sum + (record.paymentMode === "bank" ? 0 : Number(record.paid))
  ), 0);
  const directBankCollected = totalCollected - cashCollected;
  const expensesTotal = safeExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const loansDisbursed = safeLoans.reduce((sum, loan) => sum + loan.amount, 0);
  const cashToDeposit = cashCollected - expensesTotal - loansDisbursed;
  if (cashToDeposit < 0) {
    throw new RangeError("कर्ज वाटप आणि खर्चाची बेरीज हातातील जमा रोकडीपेक्षा जास्त आहे.");
  }

  const safeMeeting = {
    date: meeting.date,
    collectedBachat: records.reduce((sum, record) => sum + Number(record.bachat), 0),
    collectedInterest: records.reduce((sum, record) => sum + Number(record.interest), 0),
    collectedPrincipal: records.reduce((sum, record) => sum + Number(record.principal), 0),
    totalCash: totalCollected,
    cashCollected,
    directBankCollected,
    expensesTotal,
    loansDisbursed,
    bankDeposit: cashToDeposit,
    records,
  };
  const database = await openDB();
  const transaction = database.transaction(["meetings", "members", "expenses", "loans"], "readwrite");
  const completion = transactionResult(transaction);
  const membersStore = transaction.objectStore("members");
  const memberChanges = new Map();
  for (const record of records) {
    const change = memberChanges.get(record.memberId) || { bachat: 0, principal: 0, newLoan: 0 };
    change.bachat += Number(record.bachat);
    change.principal += Number(record.principal);
    memberChanges.set(record.memberId, change);
  }
  for (const loan of safeLoans) {
    const change = memberChanges.get(loan.memberId) || { bachat: 0, principal: 0, newLoan: 0 };
    change.newLoan += loan.amount;
    memberChanges.set(loan.memberId, change);
  }

  const meetingRequest = transaction.objectStore("meetings").add(safeMeeting);
  meetingRequest.addEventListener("success", () => {
    const meetingId = meetingRequest.result;
    for (const expense of safeExpenses) {
      transaction.objectStore("expenses").add({ ...expense, meetingId });
    }
    for (const loan of safeLoans) {
      transaction.objectStore("loans").add({ ...loan, meetingId });
    }
    for (const [memberId, change] of memberChanges) {
      const request = membersStore.get(memberId);
      request.onsuccess = () => {
        const member = request.result;
        if (!member) {
          transaction.abort();
          return;
        }
        member.totalBachat = (Number(member.totalBachat) || 0) + change.bachat;
        member.activeLoan = Math.max(0, (Number(member.activeLoan) || 0) - change.principal) + change.newLoan;
        if (records.some((record) => record.memberId === memberId)) member.lastMeetingDate = meeting.date;
        membersStore.put(member);
      };
    }
  });

  try {
    const id = await requestResult(meetingRequest);
    await completion;
    return { ...safeMeeting, id };
  } catch (error) {
    await completion.catch(() => {});
    throw error;
  }
}