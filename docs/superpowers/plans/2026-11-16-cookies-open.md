# Cookies Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Открывать значения всех видимых заявок Cookies с паузой 800 мс.
**Architecture:** Отдельный сборщик `pmGetCookiesBatch()` возвращает `{link}` в порядке DOM без лимита. Кнопка использует существующий `pmRunBatch`, общий busy и фоновые вкладки.
**Tech Stack:** JavaScript, node:test, jsdom, Chrome MV3.
**Spec:** `docs/superpowers/specs/2026-11-16-cookies-open-design.md`

## Global Constraints
- Cookies без учёта регистра только в `.bids-item-title`; скрытые фильтром строки исключены.
- Без лимита 10; порядок строк, пауза 800 мс. Старые кнопки неизменны.
- Вкладки фоновые, не закрываем. Новых зависимостей нет.

## Review Focus
- Больше 10 совпадений: открыть все.
- Cookies только в категории или деталях: не открывать.
- Без ссылки или названия: пропустить.
- Повторное нажатие/другая операция/окно: не запустить вторую очередь.
- Новые строки и фильтр: счётчик актуален.

### Task 1: Кнопка и выпуск v2.24
**Files:** `extension/content.js`, `tests/cookies-open.cjs`, `extension/manifest.json`, `docs/project-context.md`, `docs/page-markup.md`.
**Interfaces:** `pmGetCookiesBatch() -> Array<{link: string}>`, `pmOpenCookiesLinks() -> void`, `pmCookiesBtnText() -> string`; переиспользовать `pmRunBatch(kind, items, step)`.
- [x] Написать DOM-тесты: смешанный регистр, 12 совпадений, скрытая строка, отсутствие названия/ссылки, совпадения вне названия; таймеры 800 мс и порядок, busy и модальное окно; новые строки и фильтрация; старый лимит 10.
- [x] `node --test tests/cookies-open.cjs`: ожидается FAIL из-за отсутствия кнопки.
- [x] Реализовать сборщик, кнопку, прогресс и общую блокировку; обновление счётчика без лишних мутаций.
- [x] `npm test`, `node --check extension/content.js`, `git diff --check`: ожидается PASS.
- [ ] Обновить документацию и manifest 2.24, независимое ревью, коммит и тег v2.24.
- [ ] Push main и v2.24; дождаться успешного Actions и проверить ZIP релиза.
