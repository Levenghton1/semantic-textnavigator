"use strict";

const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { analyze } = require("./docs/navigator.js");

const fixtureDir = join(__dirname, "docs", "documents");
const files = readdirSync(fixtureDir).sort().map(name => ({
  name, text: readFileSync(join(fixtureDir, name), "utf8")
}));
const [base, amendment, , , email, draft] = files;
const asOf = "2026-03-10";
const find = (report, id) => report.rows.find(row => row.id === id);
const read = (files, name, date = asOf) => find(analyze(files, date), "STN-101").terms[name];

test("учебный комплект даёт три строки и четыре требуемых ответа", () => {
  const report = analyze(files, asOf);
  assert.deepEqual(report.rows.map(row => row.id), ["STN-101", "STN-102", "STN-103"]);
  const [one, two, three] = report.rows;
  assert.equal(one.supplier, "ООО «Вектор Прибор»");
  assert.equal(one.terms.deadline.value, "2026-04-30");
  assert.equal(one.terms.amount.value, 138_000_000);
  assert.equal(two.terms.amount.value, 84_000_000);
  assert.equal(three.terms.amount.state, "missing");
  assert.equal(three.terms.amount.value, null);
  const early = report.rows.filter(row => row.terms.deadline.value < "2026-04-01");
  assert.deepEqual(early.map(row => row.id), ["STN-102"]);
  assert.equal(two.terms.deadline.value, "2026-03-20");
  assert.equal(two.proposals[0].terms.deadline.value, "2026-03-27");
  assert.equal(one.proposals[0].terms.deadline.value, "2026-05-10");
  assert.equal(one.proposals[0].terms.amount.value, 145_000_000);
});

test("источник ведёт к дословному абзацу и правильному файлу", () => {
  const report = analyze(files, asOf);
  const one = find(report, "STN-101");
  const two = find(report, "STN-102");
  const three = find(report, "STN-103");
  const cases = [
    [one.terms.deadline, amendment.name, /не позднее 30\.04\.2026/],
    [one.terms.amount, amendment.name, /1 380 000/],
    [two.terms.amount, files[2].name, /840 000/],
    [three.terms.amount, files[3].name, /спецификацией/],
    [two.proposals[0].terms.deadline, email.name, /с 20\.03\.2026 на 27\.03\.2026/]
  ];
  for (const [term, file, quote] of cases) {
    const [ref] = term.sources;
    const doc = report.documents[ref.doc];
    const block = doc.blocks[ref.block];
    const original = files.find(item => item.name === file);
    assert.equal(doc.name, file);
    assert.equal(block.text, original.text.split(/\r?\n/).slice(block.start - 1, block.end).join("\n"));
    assert.match(block.text, quote);
  }
});

test("смена имени, порядка и текста файла меняет результат только по содержанию", () => {
  const renamed = files.toReversed().map((file, index) => ({
    name: `sample-${index}.txt`, text: file.text.replace("840 000", "913 500")
  }));
  const report = analyze(renamed, asOf);
  assert.equal(find(report, "STN-102").terms.amount.value, 91_350_000);
  assert.equal(find(report, "STN-101").terms.deadline.value, "2026-04-30");
});

test("новый договор с переносом строки, другим номером и суммой с копейками", () => {
  const text = [
    "ДОГОВОР ПОСТАВКИ № NORTH-204",
    "Статус: подписан обеими сторонами 01.02.2026.",
    "1. Поставщик: ООО «Альфа».",
    "5. Общая стоимость поставки составляет",
    "1\u202F250,45 рубля.",
    "8. Дата поставки: 01.04.2026."
  ].join("\r\n");
  const report = analyze([...files, { name: "new.txt", text }], asOf);
  const row = find(report, "NORTH-204");
  assert.equal(report.rows.length, 4);
  assert.equal(row.supplier, "ООО «Альфа»");
  assert.equal(row.terms.amount.value, 125_045);
  assert.equal(row.terms.deadline.value, "2026-04-01");
  const ref = row.terms.amount.sources[0];
  const block = report.documents[ref.doc].blocks[ref.block];
  assert.equal(block.start, 4);
  assert.equal(block.end, 5);
  assert.equal(block.text, "5. Общая стоимость поставки составляет\n1\u202F250,45 рубля.");
});

test("допсоглашение действует с даты вступления в силу, если подписано к этой дате", () => {
  assert.equal(read([base, amendment, draft], "deadline", "2026-02-28").value, "2026-04-15");
  assert.equal(read([base, amendment], "deadline", "2026-03-01").value, "2026-04-30");
  const laterSignature = { ...amendment, text: amendment.text.replace("сторонами 01.03", "сторонами 21.03") };
  assert.equal(read([base, laterSignature], "deadline").value, "2026-04-15");
  const future = { ...amendment, text: amendment.text.replace("силу 01.03", "силу 01.04") };
  assert.equal(read([base, future], "deadline").value, "2026-04-15");
});

test("явно неподписанное допсоглашение остаётся предложением", () => {
  const unsigned = { ...amendment, text: amendment.text.replace("подписано обеими", "не подписано обеими") };
  const row = find(analyze([base, unsigned], asOf), "STN-101");
  assert.equal(row.terms.deadline.value, "2026-04-15");
  assert.equal(row.proposals[0].terms.deadline.value, "2026-04-30");
});

test("дата вступления в силу должна быть подтверждена календарной датой в тексте", () => {
  for (const replacement of ["вступает в силу 31.02.2026", "не вступает в силу 01.03.2026",
    "вступает в силу 01.03.2026 при условии предоплаты", "вступает в силу после согласования"]) {
    const uncertain = { ...amendment, text: amendment.text.replace("вступает в силу 01.03.2026", replacement) };
    const term = read([base, uncertain], "deadline");
    assert.equal(term.state, "review");
    assert.equal(term.value, null);
    assert.ok(term.sources.length);
  }
});

test("допсоглашения обрабатываются по каждому полю и конфликт помечается", () => {
  const second = {
    name: "another.txt",
    text: amendment.text.replace("№ 1", "№ 4")
      .replace(/1\. Пункт 2\.1[^\n]*\n+/, "")
      .replace("30.04.2026", "19.04.2026")
  };
  assert.equal(read([base, second, amendment], "deadline").state, "review");
  assert.equal(read([base, second, amendment], "amount").value, 138_000_000);
  const later = { ...second, text: second.text.replace("в силу 01.03", "в силу 09.03") };
  assert.equal(read([later, amendment, base], "deadline").value, "2026-04-19");
  assert.equal(read([later, amendment, base], "amount").value, 138_000_000);
});

test("неизвестный договор у связанного файла виден в списке несвязанных", () => {
  const orphan = { ...amendment, text: amendment.text.replace("STN-101", "OTHER-901") };
  const report = analyze([base, orphan], asOf);
  assert.equal(report.orphans[0].id, "OTHER-901");
  assert.equal(report.rows[0].terms.deadline.value, "2026-04-15");
});

test("дубликат договора требует сверки двух источников", () => {
  const term = read([base, { ...base, name: "duplicate.txt" }], "deadline");
  assert.equal(term.state, "review");
  assert.equal(term.value, null);
  assert.equal(term.sources.length, 2);
});

test("пропуск пункта отличается от неоднозначного или некорректного значения", () => {
  const noDeadline = { ...base, text: base.text.replace(/3\.1\.[^\n]*\n/, "") };
  assert.equal(read([noDeadline], "deadline").state, "missing");
  for (const replacement of ["31.02.2026", "15.04.2026 или 20.04.2026"]) {
    const unclear = { ...base, text: base.text.replace("15.04.2026", replacement) };
    assert.equal(read([unclear], "deadline").state, "review");
  }
});

test("срок с условием оплаты требует проверки", () => {
  const conditional = { ...base, text: base.text.replace("15.04.2026.", "15.04.2026 при условии полной предоплаты.") };
  const term = read([conditional], "deadline");
  assert.equal(term.state, "review");
  assert.equal(term.value, null);
  assert.ok(term.sources.length);
});

test("оговорка об остальных условиях не скрывает новый срок", () => {
  const explicit = { ...amendment, text: amendment.text.replace("30.04.2026».", "30.04.2026; прочие условия остаются без изменений».") };
  const term = read([base, explicit], "deadline");
  assert.equal(term.value, "2026-04-30");
  assert.equal(term.amended, true);
});
