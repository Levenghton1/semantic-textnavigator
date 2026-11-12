"use strict";

const byId = id => document.getElementById(id);
const currency = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const fieldLabels = { amount: "Сумма", deadline: "Срок поставки" };
const documentLabels = {
  contract: "Договор", amendment: "Допсоглашение", draft: "Проект допсоглашения",
  email: "Письмо поставщика", unknown: "Неизвестный тип"
};
const statusLabels = {
  base: "Исходный договор", applied: "Вступило в силу", proposal: "Не согласовано",
  review: "Требуется проверка", future: "Вне даты проверки"
};
const demoFiles = [
  "01_contract.txt", "02_amendment_signed.txt", "03_contract.txt",
  "04_contract.txt", "05_supplier_email.txt", "06_amendment_draft.txt"
];
const state = { files: [], report: null, upload: 0, currentBlock: null, selection: null };

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(label, className, action) {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function labelValue(name, term) {
  if (term.state === "missing") return "нет данных";
  if (term.state === "review") return "Требуется проверка";
  if (name === "deadline") return term.value.split("-").reverse().join(".");
  const rubles = Math.trunc(term.value / 100);
  const kopecks = term.value % 100;
  return currency.format(rubles) + (kopecks ? "," + String(kopecks).padStart(2, "0") : "") + "\u00A0₽";
}

function clearSource() {
  state.selection?.control.setAttribute("aria-pressed", "false");
  state.selection = null;
  byId("source").hidden = true;
  byId("source-empty").hidden = false;
  byId("source-back").hidden = true;
  state.currentBlock = null;
}

function renderSource(ref) {
  const doc = state.report.documents[ref.doc];
  const block = doc.blocks[ref.block];
  byId("source-name").textContent = doc.name;
  byId("source-lines").textContent = block.start === block.end
    ? `строка ${block.start}` : `строки ${block.start}–${block.end}`;
  byId("source-quote").textContent = block.text;

  const original = byId("original");
  const blocks = doc.blocks.map(item => {
    const paragraph = element("div", "paragraph" + (item === block ? " target" : ""));
    paragraph.append(element("span", "line-number", item.start), element("p", "", item.text));
    if (item === block) {
      paragraph.tabIndex = -1;
      state.currentBlock = paragraph;
    }
    return paragraph;
  });
  original.replaceChildren(...blocks);
  original.scrollTop = 0;
}

function openSource(refs, topic, note = "") {
  const choices = [...new Map(refs.filter(Boolean).map(ref => [`${ref.doc}/${ref.block}`, ref])).values()];
  if (!choices.length) return;
  byId("source-topic").textContent = topic;
  byId("source-note").hidden = !note;
  byId("source-note").textContent = note;
  byId("source-empty").hidden = true;
  byId("source").hidden = false;
  byId("source-back").hidden = false;
  const options = byId("source-options");
  const controls = choices.length > 1 ? choices.map((ref, index) => {
    const doc = state.report.documents[ref.doc];
    const control = button(`${doc.name} · строка ${doc.blocks[ref.block].start}`, "source-option", () => {
      for (const sibling of options.children) sibling.setAttribute("aria-pressed", String(sibling === control));
      renderSource(ref);
    });
    control.setAttribute("aria-pressed", String(index === 0));
    return control;
  }) : [];
  options.replaceChildren(...controls);
  renderSource(choices[0]);

  const heading = byId("evidence-title");
  heading.focus({ preventScroll: true });
  const rect = heading.getBoundingClientRect();
  if (window.matchMedia("(max-width: 1040px)").matches || rect.top < 0 || rect.bottom > window.innerHeight) {
    heading.scrollIntoView({ block: "start" });
  }
}

function evidenceButton(label, className, refs, topic, note = "") {
  const key = JSON.stringify([topic, refs]);
  const control = button(label, className, () => {
    state.selection?.control.setAttribute("aria-pressed", "false");
    state.selection = { key, control };
    control.setAttribute("aria-pressed", "true");
    openSource(refs, topic, note);
  });
  const selected = state.selection?.key === key;
  control.setAttribute("aria-pressed", String(selected));
  control.setAttribute("aria-controls", "source");
  if (selected) state.selection.control = control;
  return control;
}

function labeledCell(className, title) {
  const cell = element("td", className);
  cell.setAttribute("role", "cell");
  const label = element("span", "mobile-label", title);
  label.setAttribute("aria-hidden", "true");
  cell.append(label);
  return cell;
}

function termCell(row, name) {
  const term = row.terms[name];
  const cell = labeledCell("term-cell", fieldLabels[name]);
  const label = labelValue(name, term);
  if (term.sources.length) {
    const note = [term.amended ? "Условие установлено допсоглашением." : "", term.note].filter(Boolean).join(" ");
    const control = evidenceButton(label, `term-link ${term.state}`, term.sources,
      `${row.id} · ${fieldLabels[name]}`, note);
    control.setAttribute("aria-label", `${row.id}, ${fieldLabels[name].toLowerCase()}: ${label}. Открыть источник`);
    cell.append(control);
    if (term.amended) cell.append(element("span", "term-detail", "Допсоглашение"));
  } else {
    cell.append(element("span", "missing", label));
  }
  return cell;
}

function proposalCell(row) {
  const cell = labeledCell("proposals", "Несогласованные изменения");
  if (!row.proposals.length) {
    cell.append(element("span", "muted", "Нет в комплекте"));
    return cell;
  }
  for (const doc of row.proposals) {
    const group = element("div", "proposal");
    const proposedFields = Object.keys(fieldLabels).filter(name =>
      doc.terms[name].state !== "missing" || doc.terms[name].sources.length
    );
    group.append(evidenceButton(documentLabels[doc.kind], "proposal-link",
      [doc.statusSource, ...proposedFields.flatMap(name => doc.terms[name].sources)],
      `${row.id} · ${documentLabels[doc.kind]}`, "Предложение ожидает согласования."));
    for (const name of proposedFields) {
      const term = doc.terms[name];
      const label = term.state === "value" ? labelValue(name, term) : "требуется проверка";
      group.append(evidenceButton(`${fieldLabels[name]} · ${label}`, "proposal-value",
        [...term.sources, doc.statusSource], `${row.id} · предложенное условие`, term.note));
    }
    cell.append(group);
  }
  return cell;
}

function renderRows() {
  if (!state.report) return;
  const search = byId("search").value.trim().toLowerCase();
  const matching = state.report.rows.filter(row => `${row.id} ${row.supplier || ""}`.toLowerCase().includes(search));
  const filterOn = byId("filter-on").checked;
  const beforeInput = byId("before");
  beforeInput.disabled = !filterOn;
  const before = beforeInput.validity.valid ? beforeInput.value : "";
  const visible = filterOn ? matching.filter(row =>
    before && row.terms.deadline.state === "value" && row.terms.deadline.value < before
  ) : matching;
  const unverified = matching.filter(row => row.terms.deadline.state !== "value").length;
  const summary = byId("review-summary");
  summary.hidden = !filterOn || !unverified || !before;
  summary.textContent = `Договоров без подтверждённого срока: ${unverified}. Они исключены из фильтра.`;
  byId("contracts").replaceChildren(...visible.map(row => {
    const tr = element("tr");
    tr.setAttribute("role", "row");
    const title = element("th", "contract");
    title.scope = "row";
    title.setAttribute("role", "rowheader");
    title.append(element("strong", "", row.id), element("span", "", row.supplier || "Поставщик: нет данных"));
    tr.append(title, termCell(row, "amount"), termCell(row, "deadline"), proposalCell(row));
    return tr;
  }));
  byId("counts").textContent = state.report.rows.length ? `Показано ${visible.length} из ${state.report.rows.length}` : "";
  byId("counts").hidden = !state.report.rows.length;
  byId("filters").hidden = !state.report.rows.length;
  byId("contract-table").hidden = !visible.length;
  const noRows = byId("no-rows");
  noRows.hidden = visible.length > 0;
  noRows.textContent = filterOn && !before ? "Укажите дату для фильтра." :
    state.report.rows.length ? "По этому запросу договоров нет." :
    "На дату проверки договоры не найдены. Проверьте документы комплекта.";
}

function renderDocuments() {
  const report = state.report;
  const unlinked = new Set(report.orphans.map(doc => doc.key));
  const issues = byId("document-issues");
  issues.hidden = !unlinked.size;
  issues.textContent = unlinked.size ? `У ${unlinked.size} файлов не подтверждена связь с договором. Проверьте документы комплекта.` : "";
  byId("document-list").hidden = false;
  if (unlinked.size) byId("document-list").open = true;
  byId("file-count").textContent = report.documents.length;
  byId("document-items").replaceChildren(...report.documents.map(doc => {
    const row = element("li");
    const name = doc.startSource
      ? evidenceButton(doc.name, "file-link",
        [doc.statusSource, doc.effectiveSource, doc.startSource], documentLabels[doc.kind],
        unlinked.has(doc.key) ? "Связанный договор не найден или номер неоднозначен." : statusLabels[doc.status]
      ) : element("span", "file-name", doc.name);
    const meta = element("span", "muted", doc.id ? `${documentLabels[doc.kind]} · ${doc.id}` : documentLabels[doc.kind]);
    const status = unlinked.has(doc.key) ? "Требуется проверка связи" : statusLabels[doc.status];
    const badge = element("span", `badge ${unlinked.has(doc.key) ? "review" : doc.status}`, status);
    row.append(name, meta, badge);
    return row;
  }));
}

function refresh() {
  clearSource();
  const input = byId("as-of");
  const canAnalyze = state.files.length && input.validity.valid;
  byId("empty").hidden = Boolean(state.files.length);
  byId("results").hidden = !canAnalyze;
  byId("evidence").hidden = !canAnalyze;
  byId("document-list").hidden = !canAnalyze;
  if (!canAnalyze) {
    state.report = null;
    byId("counts").textContent = state.files.length ? "Укажите корректную дату проверки" : "";
    byId("counts").hidden = !state.files.length;
    return;
  }
  state.report = TextNavigator.analyze(state.files, input.value);
  renderRows();
  renderDocuments();
}

function showFiles(files, errors = []) {
  const keepPrevious = !files.length && state.files.length > 0;
  byId("errors").hidden = !errors.length;
  byId("errors-title").textContent = keepPrevious
    ? "Не удалось загрузить новый комплект. Показан предыдущий."
    : files.length ? "Эти файлы не учтены при сверке" : "Не удалось прочитать выбранные файлы";
  byId("errors-list").replaceChildren(...errors.map(error => element("li", "", error)));
  byId("upload-status").textContent = files.length
    ? `Загружено файлов: ${files.length}${errors.length ? ` · С ошибками: ${errors.length}` : ""}`
    : "Файлы не загружены";
  if (keepPrevious) return;
  state.files = files;
  byId("search").value = "";
  byId("filter-on").checked = false;
  byId("document-list").open = false;
  refresh();
}

async function loadDemo() {
  const upload = ++state.upload;
  const status = byId("upload-status");
  status.textContent = "Загружаем учебный комплект…";
  try {
    const files = await Promise.all(demoFiles.map(async name => {
      const response = await fetch("documents/" + name);
      if (!response.ok) throw new Error("Учебный файл недоступен");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer());
      return { name, text };
    }));
    if (upload === state.upload) showFiles(files);
  } catch {
    if (upload === state.upload) status.textContent = "Учебный комплект не загрузился. Попробуйте ещё раз.";
  }
}

async function loadFiles(event) {
  const selected = Array.from(event.target.files);
  event.target.value = "";
  if (!selected.length) return;
  const upload = ++state.upload;
  const status = byId("upload-status");
  status.textContent = "Читаем файлы…";
  const loaded = await Promise.allSettled(selected.map(async file => {
    if (!file.name.toLowerCase().endsWith(".txt")) throw new Error("выберите TXT");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    if (!text.trim()) throw new Error("пустой файл");
    return { name: file.name, text };
  }));
  if (upload !== state.upload) return;

  const errors = loaded.flatMap((item, index) => {
    if (item.status === "fulfilled") return [];
    const reason = item.reason instanceof TypeError ? "проверьте кодировку UTF-8" : item.reason?.message || "ошибка чтения";
    return [`${selected[index].name} · ${reason}`];
  });
  showFiles(loaded.flatMap(item => item.status === "fulfilled" ? [item.value] : []), errors);
}

if (location.protocol === "https:" || location.protocol === "http:") {
  const demo = byId("demo");
  demo.hidden = false;
  demo.addEventListener("click", loadDemo);
  byId("example-hint").textContent = "Для знакомства с приложением откройте учебный пример.";
}
byId("upload").addEventListener("click", () => byId("files").click());
byId("files").addEventListener("change", loadFiles);
byId("as-of").addEventListener("input", refresh);
byId("search").addEventListener("input", renderRows);
byId("filter-on").addEventListener("change", renderRows);
byId("before").addEventListener("input", renderRows);
byId("source-back").addEventListener("click", () => {
  const selected = state.selection?.control;
  const target = selected?.isConnected && selected.getClientRects().length ? selected : byId("terms-title");
  target.focus();
});
byId("jump").addEventListener("click", () => {
  if (!state.currentBlock) return;
  state.currentBlock.focus({ preventScroll: true });
  state.currentBlock.scrollIntoView({ block: "nearest" });
});
