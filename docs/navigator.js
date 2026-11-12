"use strict";

// The browser and the regression tests call the same parser.
const TextNavigator = (() => {
  const fields = ["amount", "deadline"];
  const dateToken = "\\d{2}\\.\\d{2}\\.\\d{4}";
  const idToken = "[\\p{L}\\d]+(?:[-–./][\\p{L}\\d]+)*";
  const total = /(?:(?:общ(?:ая|ую|ей)|итогов(?:ая|ую|ой))\s+(?:стоимост[ьи]|сумм[ауые])|(?:цена|сумма)\s+договора)/iu;
  const price = new RegExp(
    total.source + "(?: (?:договора|поставки|товара))?\\s*(?:(?:составляет|равна|установлена в размере|на)\\s+|[:—–-]\\s*)?" +
    "(\\d{1,3}(?: \\d{3})+|\\d+)([,.]\\d{1,2})?(?: \\([^()]*\\))? (?:руб(?:лей|ля|ль|\\.)?|₽)(?![а-яё])", "giu"
  );
  const delivery = /(?:срок|дата)\s+поставки|поставщик\s+обязуется\s+поставить|поставка\s+(?:осуществляется|должна\s+быть\s+выполнена)/iu;
  const deadline = new RegExp(
    "(?:поставщик обязуется поставить[^.!?:;]{0,180}?\\s+(?:не позднее|до)|" +
    "поставка (?:осуществляется|должна быть выполнена) (?:не позднее|до)|" +
    "(?:срок|дата) поставки\\s*(?:(?:составляет|установлен[а]? на|изменить на|на|не позднее|до)\\s+|[:—–-]\\s*)?)\\s*" +
    "(" + dateToken + ")(?!\\d)", "giu"
  );
  const moveDeadline = new RegExp("срок поставки с " + dateToken + " на (" + dateToken + ")(?!\\d)", "giu");
  const missingAmount = /определяется спецификацией|числовое значение стоимости.{0,65}не указано|(?:стоимость|сумма).{0,50}не указана/iu;
  const missingDeadline = /срок поставки.{0,55}не (?:установлен|указан|определ[её]н)/iu;
  const unchanged = /без изменений|не изменяет(?:ся)?|не является (?:согласованной стоимостью|сроком поставки)/iu;
  const includedInTotal = /входит\s+в\s+(?:общую|итоговую)\s+(?:стоимость|сумму)/iu;
  const alternatives = new RegExp("(?:или|либо|в зависимости от)\\s+(?:до\\s+)?(?:" + dateToken +
    "|[0-9][0-9 ,.]*\\s+(?:руб|₽))", "iu");

  function parseDate(text) {
    const parts = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
    if (!parts) return null;
    const [, day, month, year] = parts;
    const iso = `${year}-${month}-${day}`;
    const date = new Date(iso + "T00:00:00Z");
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
  }

  function paragraphs(text) {
    const blocks = [];
    let current = null;
    const separate = /^(?:\d+(?:\.\d+)*\.\s|(?:дата(?: проекта)?|статус|от|кому|тема):)/iu;
    const metadata = /^(?:дата(?: проекта)?|статус|от|кому|тема):/iu;
    text.split(/\r\n?|\n/).forEach((line, index) => {
      const content = line.trim();
      if (!content) {
        current = null;
        return;
      }
      if (current && !separate.test(content) && !metadata.test(current.text.trim()) && current.start !== 1) {
        current.text += "\n" + line;
        current.end = index + 1;
      } else {
        current = { index: blocks.length, start: index + 1, end: index + 1, text: line };
        blocks.push(current);
      }
    });
    return blocks;
  }

  function source(doc, block) {
    return block ? { doc: doc.key, block: block.index } : null;
  }

  function field(state, value = null, sources = [], note = "") {
    return { state, value, sources: sources.filter(Boolean), note };
  }

  function extract(doc, name) {
    const isAmount = name === "amount";
    const hint = isAmount ? total : delivery;
    const absent = isAmount ? missingAmount : missingDeadline;
    const matches = [];
    const unclear = [];
    const missing = [];
    for (const block of doc.blocks.slice(1)) {
      const line = block.text.trim().replace(/\s+/gu, " ");
      if (!hint.test(line) || unchanged.test(line)) continue;
      const ref = source(doc, block);
      if (absent.test(line)) {
        missing.push(ref);
        continue;
      }
      if (alternatives.test(line)) {
        unclear.push(ref);
        continue;
      }
      if (isAmount) {
        const amounts = [...line.matchAll(price)];
        for (const match of amounts) {
          const rubles = Number(match[1].replaceAll(" ", ""));
          const kopecks = Number((match[2]?.slice(1) || "").padEnd(2, "0"));
          const value = rubles * 100 + kopecks;
          matches.push({ value: Number.isSafeInteger(value) ? value : null, ref });
        }
        if (!amounts.length && !includedInTotal.test(line)) unclear.push(ref);
      } else {
        const dates = [...line.matchAll(deadline), ...line.matchAll(moveDeadline)];
        for (const match of dates) matches.push({ value: parseDate(match[1]), ref });
        if (!dates.length) unclear.push(ref);
      }
    }
    if (!matches.length && !unclear.length) return field("missing", null, missing);
    if (unclear.length || (matches.length && missing.length) ||
        matches.some(match => match.value === null || match.value !== matches[0].value)) {
      return field("review", null, [...matches.map(match => match.ref), ...missing, ...unclear],
        "Не удалось однозначно прочитать условие.");
    }
    return field("value", matches[0].value, [matches[0].ref]);
  }

  function readDocument({ name, text }, key) {
    const blocks = paragraphs(text);
    const header = blocks[0]?.text.trim() || "";
    const main = new RegExp("^договор поставки\\s*№\\s*(" + idToken + ")", "iu").exec(header);
    const draft = /^проект[\s:]/iu.test(header);
    const amendment = /^(?:проект[:\s]+)?(?:дополнительного соглашения|дополнительное соглашение)/iu.test(header);
    const email = /^письмо(?:\s|$)/iu.test(header);
    const mention = new RegExp("договор[ау]?(?:\\s+поставки)?\\s+№?\\s*(" + idToken + ")", "giu");
    const idFrom = items => [...new Set(items.flatMap(block =>
      [...block.text.matchAll(mention)].map(match => match[1].replaceAll("–", "-").toUpperCase())
    ).filter(id => /\d/.test(id)))];
    const linkedIds = amendment ? idFrom(blocks.slice(0, 1)) : idFrom(blocks);
    const id = main ? main[1].replaceAll("–", "-").toUpperCase() : linkedIds.length === 1 ? linkedIds[0] : null;
    const statusBlocks = blocks.filter(block => /^статус:/iu.test(block.text.trim()));
    const status = statusBlocks.map(block => block.text).join("\n");
    const positive = /подписан[оаы]?\s+обеими сторонами/iu;
    const negative = /не\s+подписан|неподписан|проект\s+на\s+согласовании/iu;
    const signed = positive.test(status.replace(/не\s+подписан[оаы]?\s+обеими сторонами/giu, ""));
    const unsigned = negative.test(status);
    const signingDates = [...status.matchAll(new RegExp(positive.source + "\\s+(" + dateToken + ")(?!\\d)", "giu"))];
    const signedOn = signingDates.length === 1 ? parseDate(signingDates[0][1]) : null;
    const effectiveBlocks = blocks.filter(block => /вступает\s+в\s+силу/iu.test(block.text));
    const effectiveDates = effectiveBlocks.flatMap(block => [...block.text.matchAll(
      new RegExp("^\\s*(?:\\d+(?:\\.\\d+)*\\.\\s+)?(?:настоящее\\s+)?(?:дополнительное\\s+)?(?:соглашение\\s+)?" +
        "вступает\\s+в\\s+силу\\s+(?:с\\s+)?(" + dateToken + ")\\s*(?:года|г\\.)?\\s*(?:[.!?]|$)", "gimu")
    )]);
    const effectiveOn = effectiveDates.length === 1 ? parseDate(effectiveDates[0][1]) : null;
    const dateBlock = blocks.find(block => /^дата(?: проекта)?:/iu.test(block.text.trim()));
    const datedOn = parseDate(new RegExp("^дата(?: проекта)?:\\s*(" + dateToken + ")(?!\\d)", "iu")
      .exec(dateBlock?.text.trim() || "")?.[1] || "");
    const supplierBlock = blocks.find(block => /поставщик\s*:/iu.test(block.text));
    const supplier = /поставщик\s*:\s*(.+?)(?:\.\s+(?:покупатель|предмет)\s*:|\.?\s*$)/imu.exec(supplierBlock?.text || "")?.[1];
    const doc = {
      key, name, blocks, id, linkedIds, signed, unsigned, signedOn, effectiveOn, datedOn,
      kind: main ? "contract" : draft && amendment ? "draft" : amendment ? "amendment" : email ? "email" : "unknown",
      supplier: supplier?.trim() || null
    };
    doc.statusSource = source(doc, statusBlocks[0] || blocks[0]);
    doc.effectiveSource = source(doc, effectiveBlocks[0]);
    doc.startSource = source(doc, blocks[0]);
    doc.terms = Object.fromEntries(fields.map(name => [name, extract(doc, name)]));
    return doc;
  }

  function documentStatus(doc, asOf) {
    if (doc.kind === "unknown") return "review";
    if (doc.kind === "contract") {
      if ((doc.signedOn || doc.datedOn) > asOf) return "future";
      return doc.signed && !doc.unsigned && doc.signedOn ? "base" : "review";
    }
    if (doc.kind === "draft" || doc.kind === "email") {
      if (doc.datedOn > asOf) return "future";
      return doc.kind === "draft" && doc.signed ? "review" : "proposal";
    }
    if (doc.signed && doc.unsigned) return "review";
    if (doc.unsigned) return doc.datedOn > asOf ? "future" : "proposal";
    if (doc.effectiveOn > asOf || doc.signedOn > asOf) return "future";
    if (!doc.signed || !doc.effectiveOn || !doc.signedOn) return "review";
    return "applied";
  }

  function changesField(doc, name) {
    return doc.terms[name].state !== "missing" || doc.terms[name].sources.length > 0;
  }

  function candidateSources(doc, name) {
    return doc.terms[name].sources.length ? doc.terms[name].sources : [doc.startSource];
  }

  function resolveField(base, documents, name) {
    const unsettled = documents.filter(doc => doc.status === "review" || doc.status === "applied")
      .filter(doc => changesField(doc, name) || !fields.some(field => changesField(doc, field)));
    const uncertain = unsettled.filter(doc => doc.status === "review" || !fields.some(field => changesField(doc, field)));
    if (uncertain.length) {
      return field("review", null, uncertain.flatMap(doc => [
        ...candidateSources(doc, name), doc.statusSource, doc.effectiveSource
      ]), "Проверьте связь, статус, даты или содержание связанных документов.");
    }
    const latest = unsettled.map(doc => doc.effectiveOn).sort().at(-1);
    if (!latest) {
      const original = base.terms[name];
      if (original.sources.length) return original;
      return field("missing", null, [base.startSource], "В исходном договоре не найдено формулировки этого условия.");
    }
    const effective = unsettled.filter(doc => doc.effectiveOn === latest);
    const [first] = effective;
    const result = first.terms[name];
    if (effective.length > 1 && (result.state === "review" ||
        effective.some(doc => doc.terms[name].state !== result.state || doc.terms[name].value !== result.value))) {
      return field("review", null, effective.flatMap(doc => candidateSources(doc, name)),
        "Допсоглашения с одной датой вступления в силу расходятся.");
    }
    return { ...result, amended: true };
  }

  function analyze(files, asOf) {
    const documents = files.map(readDocument).map(doc => ({ ...doc, status: documentStatus(doc, asOf) }));
    const groups = new Map();
    for (const doc of documents) {
      if (!doc.id) continue;
      if (!groups.has(doc.id)) groups.set(doc.id, []);
      groups.get(doc.id).push(doc);
    }
    const rows = [];
    for (const [id, group] of groups) {
      const contracts = group.filter(doc => doc.kind === "contract" && doc.status !== "future");
      if (!contracts.length) continue;
      const related = group.filter(doc => doc.kind !== "contract");
      const [base] = contracts;
      const validBase = contracts.length === 1 && base.status === "base";
      const issue = contracts.length > 1 ? "Загружено несколько договоров с этим номером." : "Не подтверждены статус или дата подписания договора.";
      const unlinked = documents.filter(doc => !doc.id && doc.status !== "future" && doc.linkedIds.includes(id) &&
        (doc.status === "review" || doc.status === "applied"));
      const relatedForResolution = [...related, ...unlinked.map(doc => ({ ...doc, status: "review" }))];
      const terms = Object.fromEntries(fields.map(name => [name, validBase
        ? resolveField(base, relatedForResolution, name)
        : field("review", null, contracts.map(doc => doc.statusSource), issue)]));
      const proposals = related.filter(doc => doc.status === "proposal");
      rows.push({ id, supplier: contracts.length === 1 ? base.supplier : null, terms, proposals });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id, "ru", { numeric: true }));
    const baseIds = new Set(documents.filter(doc => doc.kind === "contract").map(doc => doc.id));
    const orphans = documents.filter(doc => !doc.id || !baseIds.has(doc.id));
    return { rows, documents, orphans };
  }

  return { analyze };
})();

if (typeof module !== "undefined") module.exports = TextNavigator;
